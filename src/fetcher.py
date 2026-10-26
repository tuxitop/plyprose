from __future__ import annotations

import datetime
import hashlib
import io
import json
import urllib.parse
from typing import Any

import chess.pgn
import httpx

from src.models import GameData

DEFAULT_TIMEOUT: float = 15.0

CHESSCOM_USER_AGENT: str = (
    "PlyProse/1.0 (contact: info@plyprose.local; https://github.com/plyprose)"
)

LICHESS_HEADERS: dict[str, str] = {
    "Accept": "application/x-ndjson",
    "User-Agent": "PlyProse/1.0 (contact: info@plyprose.local)",
}

CHESSCOM_HEADERS: dict[str, str] = {
    "User-Agent": CHESSCOM_USER_AGENT,
    "Accept": "application/json",
}


class FetchError(Exception):
    """Base exception for errors while fetching games."""


class UserNotFoundError(FetchError, ValueError):
    """Raised when a user is not found on Lichess or Chess.com."""


class RateLimitError(FetchError, RuntimeError):
    """Raised when an API rate limit is exceeded."""


def _extract_id_from_url(url: str, default: str = "") -> str:
    """Extracts the final path segment from a URL."""
    if not url:
        return default
    cleaned = url.strip().rstrip("/")
    if "/" in cleaned:
        segment = cleaned.split("/")[-1]
        segment = segment.split("?")[0].split("#")[0]
        if segment:
            return segment
    return default


def _extract_lichess_player(player_info: Any, default: str) -> str:
    """Extracts a display name for a Lichess player (human or AI)."""
    if not isinstance(player_info, dict):
        return default
    user = player_info.get("user")
    if isinstance(user, dict):
        name = user.get("name") or user.get("id")
        if name:
            return str(name)
    if "aiLevel" in player_info:
        return f"Stockfish level {player_info['aiLevel']}"
    if player_info.get("name"):
        return str(player_info["name"])
    return default


def extract_played_at(
    pgn_str: str,
    fallback_date: str | None = None,
    fallback_created: str | None = None,
) -> str:
    """
    Extracts the normalized played timestamp (YYYY-MM-DD HH:MM:SS) for a game.
    Inspects PGN headers (UTCDate, UTCTime, StartTime, Date, Time, EndTime)
    and falls back to fallback_date or fallback_created.
    """
    import re

    headers: dict[str, str] = {}
    if pgn_str and isinstance(pgn_str, str) and pgn_str.strip():
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_str.strip()))
            if game:
                headers = dict(game.headers)
        except Exception:
            pass

    utc_date = (
        headers.get("UTCDate")
        or headers.get("Date")
        or (fallback_date if isinstance(fallback_date, str) else "")
    )
    utc_time = (
        headers.get("UTCTime")
        or headers.get("StartTime")
        or headers.get("Time")
        or headers.get("EndTime")
    )

    d_match = None
    if utc_date and utc_date not in ("????.??.??", "?", ""):
        d_match = re.search(r"(\d{4})[./-](\d{1,2})[./-](\d{1,2})", utc_date)

    t_match = None
    if utc_time and utc_time not in ("?", ""):
        t_match = re.search(r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?", utc_time)

    if d_match:
        year, month, day = int(d_match.group(1)), int(d_match.group(2)), int(d_match.group(3))
        if t_match:
            hour = int(t_match.group(1))
            minute = int(t_match.group(2))
            second = int(t_match.group(3) or 0)
        else:
            hour, minute, second = 0, 0, 0
            if fallback_created:
                fc_match = re.search(r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?", fallback_created)
                if fc_match:
                    hour, minute, second = (
                        int(fc_match.group(1)),
                        int(fc_match.group(2)),
                        int(fc_match.group(3) or 0),
                    )
        try:
            dt = datetime.datetime(year, month, day, hour, minute, second, tzinfo=datetime.UTC)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass

    if fallback_created:
        clean_created = fallback_created.replace("T", " ")
        c_match = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", clean_created)
        if c_match:
            return c_match.group(1)
        return clean_created[:19]

    return ""


def extract_game_url(
    pgn_str: str = "",
    platform: str = "",
    external_id: str | None = None,
) -> str | None:
    """
    Extracts or reconstructs the canonical web URL for a chess game from PGN headers
    or platform + external_id.
    """
    import re

    if pgn_str and isinstance(pgn_str, str) and pgn_str.strip():
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_str.strip()))
            if game:
                # Check Link header first (common on Chess.com)
                link_header = (game.headers.get("Link") or "").strip()
                if link_header.startswith(("http://", "https://")):
                    return link_header

                # Check Site header (common on Lichess)
                site_header = (game.headers.get("Site") or "").strip()
                if site_header.startswith(("http://", "https://")):
                    return site_header
        except Exception:
            pass

        # Regex fallback on raw PGN text
        m_link = re.search(r'\[Link\s+"(https?://[^"]+)"\]', pgn_str)
        if m_link:
            return m_link.group(1).strip()
        m_site = re.search(r'\[Site\s+"(https?://[^"]+)"\]', pgn_str)
        if m_site:
            return m_site.group(1).strip()

    # Reconstruct from external_id & platform if valid
    if external_id and str(external_id).strip():
        clean_id = str(external_id).strip()
        if not clean_id.startswith("pgn_"):
            plat_low = (platform or "").lower()
            if "chess.com" in plat_low or plat_low == "chesscom":
                return f"https://www.chess.com/game/live/{clean_id}"
            elif "lichess" in plat_low:
                return f"https://lichess.org/{clean_id}"

    return None


def parse_raw_pgn_metadata(pgn_str: str) -> dict[str, Any]:
    """
    Parses a raw PGN string, extracting game metadata and normalizing into
    the standard game dictionary structure defined by GameData.

    Raises:
        ValueError: If the PGN string is empty, unparseable, or contains neither moves nor headers.
    """
    if not isinstance(pgn_str, str) or not pgn_str.strip():
        raise ValueError("PGN string cannot be empty.")

    cleaned_pgn = pgn_str.strip()
    try:
        game = chess.pgn.read_game(io.StringIO(cleaned_pgn))
    except Exception as e:
        raise ValueError(f"Failed to parse PGN: {e}") from e

    if game is None:
        raise ValueError("Invalid PGN: No valid chess game found.")

    moves = list(game.mainline_moves())
    headers = dict(game.headers)

    # Check whether there are any moves or meaningful non-default headers
    default_headers = {
        "Event": "?",
        "Site": "?",
        "Date": "????.??.??",
        "Round": "?",
        "White": "?",
        "Black": "?",
        "Result": "*",
    }
    has_meaningful_header = any(
        headers.get(k, "?") != v for k, v in default_headers.items()
    ) or any(k not in default_headers for k in headers)

    if not moves and not has_meaningful_header:
        raise ValueError("Invalid PGN: No chess moves or metadata found.")

    # Extract ID
    game_id = ""
    for id_key in ("Site", "Link", "GameId", "LichessId"):
        val = headers.get(id_key, "")
        if val and val != "?":
            if id_key in ("Site", "Link") and ("lichess.org" in val or "chess.com" in val):
                game_id = _extract_id_from_url(val)
                if game_id:
                    break
            elif id_key in ("GameId", "LichessId"):
                game_id = val.strip()
                break

    if not game_id:
        # Deterministic SHA256 fallback
        game_id = f"pgn_{hashlib.sha256(cleaned_pgn.encode('utf-8')).hexdigest()[:8]}"

    # Extract players
    white = headers.get("White")
    if not white or white in ("?", ""):
        white = "White"

    black = headers.get("Black")
    if not black or black in ("?", ""):
        black = "Black"

    # Extract date
    date_val = headers.get("Date") or headers.get("UTCDate")
    if not date_val or date_val in ("????.??.??", "?", ""):
        date = None
    else:
        date = str(date_val).strip()

    # Extract result
    result = headers.get("Result")
    if not result or result in ("?", ""):
        result = "*"

    # Extract time control
    time_control = headers.get("TimeControl")
    if not time_control or time_control in ("?", ""):
        time_control = "unknown"

    played_at = extract_played_at(cleaned_pgn, fallback_date=date)

    game_data = GameData(
        id=game_id,
        white=white,
        black=black,
        date=date,
        played_at=played_at if played_at else None,
        result=result,
        time_control=time_control,
        pgn=cleaned_pgn,
    )
    return game_data.model_dump()


def fetch_lichess_games(
    username: str,
    max_games: int = 10,
    client: httpx.Client | None = None,
    since: int | None = None,
    until: int | None = None,
) -> list[dict[str, Any]]:
    """
    Fetches recent games for a Lichess user.

    Endpoint: GET https://lichess.org/api/games/user/{username}?max={max_games}&pgnInJson=true&opening=true
    Headers: Accept: application/x-ndjson

    Parameters:
        username: Lichess username.
        max_games: Maximum games to return.
        client: Optional httpx.Client instance.
        since: Lower bound timestamp in epoch milliseconds.
        until: Upper bound timestamp in epoch milliseconds.

    Returns:
        List of dicts: {"id", "white", "black", "date", "result", "time_control", "pgn"}
    """
    if not username or not username.strip():
        raise ValueError("Username cannot be empty.")
    if max_games <= 0:
        return []

    url = f"https://lichess.org/api/games/user/{urllib.parse.quote(username.strip())}"
    params: dict[str, Any] = {
        "max": max_games,
        "pgnInJson": "true",
        "opening": "true",
    }
    if since is not None:
        params["since"] = since
    if until is not None:
        params["until"] = until

    def _execute(c: httpx.Client) -> httpx.Response:
        return c.get(url, params=params, headers=LICHESS_HEADERS, follow_redirects=True)

    try:
        if client is not None:
            resp = _execute(client)
        else:
            with httpx.Client(timeout=DEFAULT_TIMEOUT) as local_client:
                resp = _execute(local_client)
    except httpx.RequestError as exc:
        raise FetchError(f"Network error while connecting to Lichess: {exc}") from exc

    if resp.status_code == 404:
        raise UserNotFoundError(f"User '{username}' not found on Lichess.")
    if resp.status_code == 429:
        raise RateLimitError("Rate limit exceeded on Lichess. Please wait before retrying.")
    if resp.status_code != 200:
        raise FetchError(f"Lichess API returned status {resp.status_code}: {resp.text[:200]}")

    games: list[dict[str, Any]] = []
    for line in resp.text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        if not isinstance(data, dict):
            continue

        # Skip any error lines
        if "error" in data and "id" not in data:
            continue

        game_id = str(data.get("id") or "")
        if not game_id:
            continue

        pgn_text = data.get("pgn", "")
        pgn_meta: dict[str, Any] = {}
        if pgn_text:
            try:
                pgn_meta = parse_raw_pgn_metadata(pgn_text)
            except Exception:
                pass

        # Players
        players = data.get("players", {})
        white_player = _extract_lichess_player(players.get("white"), pgn_meta.get("white", "White"))
        black_player = _extract_lichess_player(players.get("black"), pgn_meta.get("black", "Black"))

        # Date & Played At
        created_at = data.get("createdAt")
        date_str: str | None = None
        played_at_str: str | None = None
        if isinstance(created_at, (int, float)):
            try:
                dt = datetime.datetime.fromtimestamp(created_at / 1000, tz=datetime.UTC)
                date_str = dt.strftime("%Y.%m.%d")
                played_at_str = dt.strftime("%Y-%m-%d %H:%M:%S")
            except Exception:
                pass
        if not date_str:
            date_str = pgn_meta.get("date")
        if not played_at_str:
            played_at_str = pgn_meta.get("played_at") or extract_played_at(
                pgn_text, fallback_date=date_str
            )

        # Result
        winner = data.get("winner")
        status = data.get("status")
        if winner == "white":
            result = "1-0"
        elif winner == "black":
            result = "0-1"
        elif status in ("draw", "stalemate", "timeRemaining", "declaredDraw"):
            result = "1/2-1/2"
        else:
            result = pgn_meta.get("result", "*")

        # Time control
        clock = data.get("clock")
        if isinstance(clock, dict) and "initial" in clock:
            init = clock.get("initial")
            inc = clock.get("increment", 0)
            time_control = f"{init}+{inc}"
        elif data.get("speed"):
            time_control = str(data["speed"])
        else:
            time_control = pgn_meta.get("time_control", "unknown")

        game_obj = GameData(
            id=game_id,
            white=white_player,
            black=black_player,
            date=date_str,
            played_at=played_at_str if played_at_str else None,
            result=result,
            time_control=time_control,
            pgn=pgn_text,
            source=data.get("source"),
        )
        games.append(game_obj.model_dump())
        if len(games) >= max_games:
            break

    return games


def _normalize_chesscom_game(g: dict[str, Any]) -> dict[str, Any]:
    """Normalizes a single Chess.com game object into the GameData schema."""
    pgn_text = str(g.get("pgn", "")).strip()
    pgn_meta: dict[str, Any] = {}
    if pgn_text:
        try:
            pgn_meta = parse_raw_pgn_metadata(pgn_text)
        except Exception:
            pass

    # ID
    url = str(g.get("url") or "")
    game_id = _extract_id_from_url(url)
    if not game_id:
        game_id = pgn_meta.get("id") or f"chesscom_{g.get('end_time', '')}"

    # Players
    white_data = g.get("white")
    if isinstance(white_data, dict) and white_data.get("username"):
        white_player = str(white_data["username"])
    else:
        white_player = pgn_meta.get("white", "White")

    black_data = g.get("black")
    if isinstance(black_data, dict) and black_data.get("username"):
        black_player = str(black_data["username"])
    else:
        black_player = pgn_meta.get("black", "Black")

    # Date & Played At
    end_time = g.get("end_time")
    date_str: str | None = None
    played_at_str: str | None = None
    if isinstance(end_time, (int, float)):
        try:
            dt = datetime.datetime.fromtimestamp(end_time, tz=datetime.UTC)
            date_str = dt.strftime("%Y.%m.%d")
            played_at_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
    if not date_str:
        date_str = pgn_meta.get("date")
    if not played_at_str:
        played_at_str = pgn_meta.get("played_at") or extract_played_at(
            pgn_text, fallback_date=date_str
        )

    # Result
    white_res = white_data.get("result") if isinstance(white_data, dict) else ""
    black_res = black_data.get("result") if isinstance(black_data, dict) else ""
    if white_res == "win":
        result = "1-0"
    elif black_res == "win":
        result = "0-1"
    elif white_res in (
        "repetition",
        "agreed",
        "stalemate",
        "insufficient",
        "50move",
        "timevsinsufficient",
    ) or black_res in (
        "repetition",
        "agreed",
        "stalemate",
        "insufficient",
        "50move",
        "timevsinsufficient",
    ):
        result = "1/2-1/2"
    else:
        result = pgn_meta.get("result", "*")

    # Time control
    tc = g.get("time_control") or g.get("time_class")
    if tc:
        time_control = str(tc)
    else:
        time_control = pgn_meta.get("time_control", "unknown")

    game_data = GameData(
        id=game_id,
        white=white_player,
        black=black_player,
        date=date_str,
        played_at=played_at_str if played_at_str else None,
        result=result,
        time_control=time_control,
        pgn=pgn_text,
    )
    return game_data.model_dump()


def fetch_chesscom_games(
    username: str,
    max_games: int = 10,
    client: httpx.Client | None = None,
    since: int | None = None,
    until: int | None = None,
) -> list[dict[str, Any]]:
    """
    Fetches recent games for a Chess.com user.

    Step 1: GET https://api.chess.com/pub/player/{username}/games/archives
    Step 2: Fetch recent monthly archive JSONs, extract games containing "pgn",
            and normalize to the same dictionary structure.

    Parameters:
        username: Chess.com username.
        max_games: Maximum games to return.
        client: Optional httpx.Client instance.
        since: Lower bound timestamp in epoch seconds or ms.
        until: Upper bound timestamp in epoch seconds or ms.

    Returns:
        List of dicts: {"id", "white", "black", "date", "result", "time_control", "pgn"}
    """
    if not username or not username.strip():
        raise ValueError("Username cannot be empty.")
    if max_games <= 0:
        return []

    clean_user = username.strip()
    archives_url = (
        f"https://api.chess.com/pub/player/{urllib.parse.quote(clean_user)}/games/archives"
    )

    since_sec: int | None = None
    if since is not None:
        since_sec = since // 1000 if since > 10_000_000_000 else since

    until_sec: int | None = None
    if until is not None:
        until_sec = until // 1000 if until > 10_000_000_000 else until

    since_dt: datetime.datetime | None = None
    if since_sec is not None:
        try:
            since_dt = datetime.datetime.fromtimestamp(since_sec, tz=datetime.UTC)
        except Exception:
            pass

    def _get(c: httpx.Client, u: str) -> httpx.Response:
        import time as _t

        last_exc: Exception | None = None
        last_resp: httpx.Response | None = None
        for attempt in range(3):
            try:
                resp = c.get(u, headers=CHESSCOM_HEADERS, follow_redirects=True)
                last_resp = resp
                if resp.status_code == 429:
                    _t.sleep(1.0 * (attempt + 1))
                    continue
                return resp
            except (httpx.RequestError, httpx.HTTPError) as exc:
                last_exc = exc
                _t.sleep(0.75 * (attempt + 1))
        if last_resp is not None and last_resp.status_code == 429:
            raise RateLimitError("Rate limit exceeded on Chess.com. Please wait before retrying.")
        raise FetchError(f"Network error while connecting to Chess.com: {last_exc}") from last_exc

    def _fetch_with_client(c: httpx.Client) -> list[dict[str, Any]]:
        try:
            resp = _get(c, archives_url)
        except httpx.RequestError as exc:
            raise FetchError(f"Network error while connecting to Chess.com: {exc}") from exc

        if resp.status_code == 404:
            raise UserNotFoundError(f"User '{clean_user}' not found on Chess.com.")
        if resp.status_code == 429:
            raise RateLimitError("Rate limit exceeded on Chess.com. Please wait before retrying.")
        if resp.status_code != 200:
            raise FetchError(f"Chess.com API returned status {resp.status_code}: {resp.text[:200]}")

        try:
            archives_data = resp.json()
        except Exception as exc:
            raise FetchError(f"Failed to parse Chess.com archives JSON: {exc}") from exc

        archives: list[str] = archives_data.get("archives", [])
        if not archives:
            return []

        collected_games: list[dict[str, Any]] = []

        # Traverse archives in reverse (most recent months first)
        for archive_url in reversed(archives):
            if since_dt is not None:
                import re

                arch_m = re.search(r"/(\d{4})/(\d{1,2})/?$", archive_url)
                if arch_m:
                    arch_y, arch_m_num = int(arch_m.group(1)), int(arch_m.group(2))
                    if (arch_y, arch_m_num) < (since_dt.year, since_dt.month):
                        break

            try:
                m_resp = _get(c, archive_url)
            except httpx.RequestError as exc:
                raise FetchError(f"Network error fetching archive from Chess.com: {exc}") from exc

            if m_resp.status_code == 429:
                raise RateLimitError(
                    "Rate limit exceeded on Chess.com. Please wait before retrying."
                )
            if m_resp.status_code != 200:
                continue

            try:
                m_data = m_resp.json()
            except Exception:
                continue

            raw_games = m_data.get("games", [])
            # Only consider games that have a non-empty pgn
            pgn_games = [g for g in raw_games if isinstance(g, dict) and g.get("pgn")]

            # Games within an archive are in chronological order (oldest to newest).
            # We traverse from newest to oldest to return the most recent games first.
            for g in reversed(pgn_games):
                end_time = g.get("end_time")
                if isinstance(end_time, (int, float)):
                    if until_sec is not None and end_time > until_sec:
                        continue
                    if since_sec is not None and end_time < since_sec:
                        break

                normalized = _normalize_chesscom_game(g)
                collected_games.append(normalized)
                if len(collected_games) >= max_games:
                    break

            if len(collected_games) >= max_games:
                break

        return collected_games

    if client is not None:
        return _fetch_with_client(client)
    else:
        with httpx.Client(timeout=DEFAULT_TIMEOUT) as local_client:
            return _fetch_with_client(local_client)


def fetch_lichess_ratings(
    username: str,
    client: httpx.Client | None = None,
) -> dict[str, int]:
    """
    Fetches official ratings (blitz, rapid, bullet, classical) for a Lichess user.
    """
    if not username or not username.strip():
        return {}
    url = f"https://lichess.org/api/user/{urllib.parse.quote(username.strip())}"

    def _execute(c: httpx.Client) -> httpx.Response:
        return c.get(
            url, headers={"User-Agent": LICHESS_HEADERS["User-Agent"]}, follow_redirects=True
        )

    try:
        if client is not None:
            resp = _execute(client)
        else:
            with httpx.Client(timeout=5.0) as local_client:
                resp = _execute(local_client)
        if resp.status_code == 200:
            data = resp.json()
            perfs = data.get("perfs", {})
            ratings: dict[str, int] = {}
            for k in ("blitz", "rapid", "bullet", "classical"):
                r = perfs.get(k, {}).get("rating")
                if isinstance(r, (int, float)) and r > 0:
                    ratings[k] = int(r)
            return ratings
    except Exception:
        pass
    return {}


def fetch_chesscom_ratings(
    username: str,
    client: httpx.Client | None = None,
) -> dict[str, int]:
    """
    Fetches official ratings (blitz, rapid, bullet) for a Chess.com user.
    """
    if not username or not username.strip():
        return {}
    url = f"https://api.chess.com/pub/player/{urllib.parse.quote(username.strip())}/stats"

    def _execute(c: httpx.Client) -> httpx.Response:
        return c.get(url, headers=CHESSCOM_HEADERS, follow_redirects=True)

    try:
        if client is not None:
            resp = _execute(client)
        else:
            with httpx.Client(timeout=5.0) as local_client:
                resp = _execute(local_client)
        if resp.status_code == 200:
            data = resp.json()
            ratings: dict[str, int] = {}
            for k, stat_key in (
                ("blitz", "chess_blitz"),
                ("rapid", "chess_rapid"),
                ("bullet", "chess_bullet"),
            ):
                r = data.get(stat_key, {}).get("last", {}).get("rating")
                if isinstance(r, (int, float)) and r > 0:
                    ratings[k] = int(r)
            return ratings
    except Exception:
        pass
    return {}


__all__ = [
    "CHESSCOM_USER_AGENT",
    "FetchError",
    "RateLimitError",
    "UserNotFoundError",
    "extract_game_url",
    "extract_played_at",
    "fetch_chesscom_games",
    "fetch_chesscom_ratings",
    "fetch_lichess_games",
    "fetch_lichess_ratings",
    "parse_raw_pgn_metadata",
]
