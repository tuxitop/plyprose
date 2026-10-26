import json
from unittest.mock import patch

import httpx
import pytest

from src.fetcher import (
    CHESSCOM_USER_AGENT,
    FetchError,
    RateLimitError,
    UserNotFoundError,
    fetch_chesscom_games,
    fetch_lichess_games,
    parse_raw_pgn_metadata,
)

# -----------------------------------------------------------------------------
# 1. Tests for parse_raw_pgn_metadata
# -----------------------------------------------------------------------------


def test_parse_raw_pgn_metadata_standard():
    pgn_str = """[Event "Live Chess"]
[Site "https://lichess.org/abcdef12"]
[Date "2024.01.15"]
[Round "1"]
[White "MagnusCarlsen"]
[Black "Hikaru"]
[Result "1-0"]
[TimeControl "180+2"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0"""

    meta = parse_raw_pgn_metadata(pgn_str)
    assert meta["id"] == "abcdef12"
    assert meta["white"] == "MagnusCarlsen"
    assert meta["black"] == "Hikaru"
    assert meta["date"] == "2024.01.15"
    assert meta["result"] == "1-0"
    assert meta["time_control"] == "180+2"
    assert meta["pgn"] == pgn_str.strip()


def test_parse_raw_pgn_metadata_chesscom_url():
    pgn_str = """[Event "Chess.com Match"]
[Link "https://www.chess.com/game/live/987654321"]
[Date "2023.12.01"]
[White "Alice"]
[Black "Bob"]
[Result "0-1"]
[TimeControl "600"]

1. d4 d5 2. c4 c6 0-1"""

    meta = parse_raw_pgn_metadata(pgn_str)
    assert meta["id"] == "987654321"
    assert meta["white"] == "Alice"
    assert meta["black"] == "Bob"
    assert meta["date"] == "2023.12.01"
    assert meta["result"] == "0-1"
    assert meta["time_control"] == "600"


def test_parse_raw_pgn_metadata_moves_only():
    pgn_str = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5"
    meta = parse_raw_pgn_metadata(pgn_str)
    assert meta["id"].startswith("pgn_")
    assert meta["white"] == "White"
    assert meta["black"] == "Black"
    assert meta["date"] is None
    assert meta["result"] == "*"
    assert meta["time_control"] == "unknown"
    assert meta["pgn"] == pgn_str


def test_parse_raw_pgn_metadata_unknown_date():
    pgn_str = """[Event "Casual"]
[Site "?"]
[Date "????.??.??"]
[White "Player1"]
[Black "Player2"]
[Result "1/2-1/2"]

1. e4 e5 1/2-1/2"""
    meta = parse_raw_pgn_metadata(pgn_str)
    assert meta["date"] is None
    assert meta["result"] == "1/2-1/2"
    assert meta["white"] == "Player1"
    assert meta["black"] == "Player2"


def test_parse_raw_pgn_metadata_invalid_inputs():
    with pytest.raises(ValueError, match="cannot be empty"):
        parse_raw_pgn_metadata("")

    with pytest.raises(ValueError, match="cannot be empty"):
        parse_raw_pgn_metadata("   \n\t  ")

    with pytest.raises(ValueError, match="No chess moves or metadata found"):
        parse_raw_pgn_metadata("not a valid pgn string at all hello world")


def test_extract_played_at():
    from src.fetcher import extract_played_at

    # PGN with UTCDate and UTCTime
    pgn1 = """[Date "2026.10.24"]
[UTCDate "2026.10.24"]
[UTCTime "05:20:24"]

1. e4 e5 *"""
    assert extract_played_at(pgn1) == "2026-10-24 05:20:24"

    # PGN with Date and StartTime
    pgn2 = """[Date "2026.10.23"]
[StartTime "19:15:41"]

1. d4 d5 *"""
    assert extract_played_at(pgn2) == "2026-10-23 19:15:41"

    # PGN with only Date
    pgn3 = """[Date "2024.01.15"]

1. e4 e5 *"""
    assert extract_played_at(pgn3) == "2024-01-15 00:00:00"

    # PGN with invalid date falls back to created_at
    pgn4 = """[Date "????.??.??"]

1. e4 e5 *"""
    assert (
        extract_played_at(pgn4, fallback_created="2026-10-24T10:48:31.047153+00:00")
        == "2026-10-24 10:48:31"
    )


# -----------------------------------------------------------------------------
# 2. Tests for fetch_lichess_games
# -----------------------------------------------------------------------------


def test_fetch_lichess_games_success():
    ndjson_data = (
        json.dumps(
            {
                "id": "game1",
                "createdAt": 1705315200000,  # 2024-01-15 10:40:00 UTC
                "status": "mate",
                "winner": "white",
                "players": {
                    "white": {"user": {"name": "Magnus", "id": "magnus"}},
                    "black": {"user": {"name": "Hikaru", "id": "hikaru"}},
                },
                "clock": {"initial": 180, "increment": 0},
                "pgn": "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
            }
        )
        + "\n"
        + json.dumps(
            {
                "id": "game2",
                "createdAt": 1705228800000,  # 2024-01-14 10:40:00 UTC
                "status": "draw",
                "players": {
                    "white": {"user": {"name": "Hikaru", "id": "hikaru"}},
                    "black": {"user": {"name": "Magnus", "id": "magnus"}},
                },
                "clock": {"initial": 300, "increment": 2},
                "pgn": "1. d4 d5 2. c4 c6 1/2-1/2",
            }
        )
        + "\n\n"  # Empty line to verify NDJSON robustness
    )

    recorded_headers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal recorded_headers
        recorded_headers = dict(request.headers)
        assert "/api/games/user/magnus" in str(request.url)
        assert request.url.params.get("max") == "2"
        return httpx.Response(200, text=ndjson_data)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    games = fetch_lichess_games("magnus", max_games=2, client=client)

    assert recorded_headers.get("accept") == "application/x-ndjson"
    assert len(games) == 2

    # Check Game 1
    assert games[0]["id"] == "game1"
    assert games[0]["white"] == "Magnus"
    assert games[0]["black"] == "Hikaru"
    assert games[0]["date"] == "2024.01.15"
    assert games[0]["result"] == "1-0"
    assert games[0]["time_control"] == "180+0"
    assert "Qxf7#" in games[0]["pgn"]

    # Check Game 2
    assert games[1]["id"] == "game2"
    assert games[1]["white"] == "Hikaru"
    assert games[1]["black"] == "Magnus"
    assert games[1]["date"] == "2024.01.14"
    assert games[1]["result"] == "1/2-1/2"
    assert games[1]["time_control"] == "300+2"


def test_fetch_lichess_games_ai_player_and_speed_fallback():
    ndjson_data = json.dumps(
        {
            "id": "game_ai",
            "createdAt": 1700000000000,
            "status": "resign",
            "winner": "black",
            "players": {
                "white": {"aiLevel": 4},
                "black": {"name": "User123"},
            },
            "speed": "blitz",
            "pgn": "1. e4 e5 0-1",
        }
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=ndjson_data)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    games = fetch_lichess_games("User123", max_games=5, client=client)

    assert len(games) == 1
    assert games[0]["white"] == "Stockfish level 4"
    assert games[0]["black"] == "User123"
    assert games[0]["result"] == "0-1"
    assert games[0]["time_control"] == "blitz"


def test_fetch_lichess_games_user_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": "Not found"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(UserNotFoundError, match="not found on Lichess"):
        fetch_lichess_games("nonexistent_user", client=client)


def test_fetch_lichess_games_rate_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="Rate limit exceeded")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RateLimitError, match="Rate limit exceeded on Lichess"):
        fetch_lichess_games("active_user", client=client)


def test_fetch_lichess_games_network_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("Connection timed out")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(FetchError, match="Network error while connecting"):
        fetch_lichess_games("magnus", client=client)


def test_fetch_lichess_games_edge_inputs():
    with pytest.raises(ValueError, match="Username cannot be empty"):
        fetch_lichess_games("")

    with pytest.raises(ValueError, match="Username cannot be empty"):
        fetch_lichess_games("   ")

    assert fetch_lichess_games("magnus", max_games=0) == []
    assert fetch_lichess_games("magnus", max_games=-5) == []


# -----------------------------------------------------------------------------
# 3. Tests for fetch_chesscom_games
# -----------------------------------------------------------------------------


def test_fetch_chesscom_games_success():
    archives_data = {
        "archives": [
            "https://api.chess.com/pub/player/hikaru/games/2024/01",
            "https://api.chess.com/pub/player/hikaru/games/2024/02",
        ]
    }

    month_data = {
        "games": [
            {
                "url": "https://www.chess.com/game/live/101",
                "pgn": "1. e4 e5 2. Nf3 Nc6 1-0",
                "time_control": "180",
                "end_time": 1707000000,
                "white": {"username": "hikaru", "result": "win"},
                "black": {"username": "opponent1", "result": "checkmated"},
            },
            {
                "url": "https://www.chess.com/game/live/102",
                "pgn": "1. d4 d5 2. c4 e6 0-1",
                "time_control": "300+2",
                "end_time": 1707100000,
                "white": {"username": "opponent2", "result": "resigned"},
                "black": {"username": "hikaru", "result": "win"},
            },
            {
                # Game without PGN should be ignored
                "url": "https://www.chess.com/game/live/103",
                "time_control": "60",
                "end_time": 1707200000,
                "white": {"username": "hikaru", "result": "win"},
                "black": {"username": "opponent3", "result": "timeout"},
            },
            {
                "url": "https://www.chess.com/game/live/104",
                "pgn": "1. c4 c5 1/2-1/2",
                "time_control": "180+1",
                "end_time": 1707300000,
                "white": {"username": "hikaru", "result": "repetition"},
                "black": {"username": "opponent4", "result": "repetition"},
            },
        ]
    }

    recorded_headers = {}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal recorded_headers
        recorded_headers = dict(request.headers)
        url_str = str(request.url)
        if url_str.endswith("/archives"):
            return httpx.Response(200, json=archives_data)
        elif "2024/02" in url_str:
            return httpx.Response(200, json=month_data)
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    games = fetch_chesscom_games("hikaru", max_games=10, client=client)

    # Verify custom User-Agent
    assert "user-agent" in recorded_headers
    assert CHESSCOM_USER_AGENT in recorded_headers["user-agent"]

    # 3 valid games with PGN returned, newest first
    assert len(games) == 3

    # Newest game (104) is first
    assert games[0]["id"] == "104"
    assert games[0]["white"] == "hikaru"
    assert games[0]["black"] == "opponent4"
    assert games[0]["result"] == "1/2-1/2"
    assert games[0]["time_control"] == "180+1"

    # Next game (102)
    assert games[1]["id"] == "102"
    assert games[1]["white"] == "opponent2"
    assert games[1]["black"] == "hikaru"
    assert games[1]["result"] == "0-1"
    assert games[1]["time_control"] == "300+2"

    # Oldest valid game (101)
    assert games[2]["id"] == "101"
    assert games[2]["white"] == "hikaru"
    assert games[2]["black"] == "opponent1"
    assert games[2]["result"] == "1-0"


def test_fetch_chesscom_games_multi_archive_traversal():
    """Verifies that if the latest month has fewer games than max_games, it queries previous months."""
    archives_data = {
        "archives": [
            "https://api.chess.com/pub/player/erik/games/2024/01",
            "https://api.chess.com/pub/player/erik/games/2024/02",
        ]
    }

    feb_data = {
        "games": [
            {
                "url": "https://www.chess.com/game/live/feb1",
                "pgn": "1. e4 e5 1-0",
                "time_control": "600",
                "end_time": 1707000000,
                "white": {"username": "erik", "result": "win"},
                "black": {"username": "bob", "result": "checkmated"},
            }
        ]
    }

    jan_data = {
        "games": [
            {
                "url": "https://www.chess.com/game/live/jan1",
                "pgn": "1. d4 d5 1-0",
                "time_control": "600",
                "end_time": 1704100000,
                "white": {"username": "erik", "result": "win"},
                "black": {"username": "alice", "result": "resigned"},
            },
            {
                "url": "https://www.chess.com/game/live/jan2",
                "pgn": "1. c4 c5 0-1",
                "time_control": "600",
                "end_time": 1704200000,
                "white": {"username": "charlie", "result": "win"},
                "black": {"username": "erik", "result": "resigned"},
            },
        ]
    }

    def handler(request: httpx.Request) -> httpx.Response:
        url_str = str(request.url)
        if url_str.endswith("/archives"):
            return httpx.Response(200, json=archives_data)
        elif "2024/02" in url_str:
            return httpx.Response(200, json=feb_data)
        elif "2024/01" in url_str:
            return httpx.Response(200, json=jan_data)
        return httpx.Response(404)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    games = fetch_chesscom_games("erik", max_games=3, client=client)

    assert len(games) == 3
    # feb1 (latest), jan2, jan1
    assert games[0]["id"] == "feb1"
    assert games[1]["id"] == "jan2"
    assert games[2]["id"] == "jan1"


def test_fetch_chesscom_games_empty_archives():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"archives": []})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    games = fetch_chesscom_games("newuser", max_games=5, client=client)
    assert games == []


def test_fetch_chesscom_games_user_not_found():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"message": "Player not found"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(UserNotFoundError, match=r"not found on Chess\.com"):
        fetch_chesscom_games("ghost_user", client=client)


def test_fetch_chesscom_games_rate_limit():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, text="Rate limit exceeded")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(RateLimitError, match=r"Rate limit exceeded on Chess\.com"):
        fetch_chesscom_games("active_user", client=client)


def test_fetch_chesscom_games_network_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("Connection timed out")

    client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(FetchError, match="Network error while connecting"):
        fetch_chesscom_games("hikaru", client=client)


def test_fetch_chesscom_games_edge_inputs():
    with pytest.raises(ValueError, match="Username cannot be empty"):
        fetch_chesscom_games("")

    with pytest.raises(ValueError, match="Username cannot be empty"):
        fetch_chesscom_games("   ")

    assert fetch_chesscom_games("hikaru", max_games=0) == []
    assert fetch_chesscom_games("hikaru", max_games=-1) == []


# -----------------------------------------------------------------------------
# 4. Tests for default client creation path
# -----------------------------------------------------------------------------


def test_fetch_lichess_games_default_client_path():
    ndjson_data = json.dumps(
        {
            "id": "def1",
            "createdAt": 1705315200000,
            "players": {"white": {"name": "P1"}, "black": {"name": "P2"}},
            "winner": "white",
            "pgn": "1. e4 e5 1-0",
        }
    )

    def fake_send(self, request, **kwargs):
        return httpx.Response(200, text=ndjson_data, request=request)

    with patch.object(httpx.Client, "send", fake_send):
        games = fetch_lichess_games("someone", max_games=1)
        assert len(games) == 1
        assert games[0]["id"] == "def1"


def test_fetch_chesscom_games_default_client_path():
    def fake_send(self, request, **kwargs):
        url = str(request.url)
        if url.endswith("/archives"):
            return httpx.Response(
                200,
                json={"archives": ["https://api.chess.com/pub/player/someone/games/2024/01"]},
                request=request,
            )
        return httpx.Response(
            200,
            json={
                "games": [
                    {
                        "url": "https://www.chess.com/game/live/999",
                        "pgn": "1. d4 d5 1/2-1/2",
                        "white": {"username": "someone", "result": "agreed"},
                        "black": {"username": "other", "result": "agreed"},
                    }
                ]
            },
            request=request,
        )

    with patch.object(httpx.Client, "send", fake_send):
        games = fetch_chesscom_games("someone", max_games=1)
        assert len(games) == 1
        assert games[0]["id"] == "999"


def test_extract_game_url():
    from src.fetcher import extract_game_url

    # 1. Chess.com Link header
    pgn_cc = (
        '[Event "Live Chess"]\n[Link "https://www.chess.com/game/live/123456789"]\n\n1. e4 e5 *'
    )
    assert extract_game_url(pgn_cc) == "https://www.chess.com/game/live/123456789"

    # 2. Lichess Site header
    pgn_li = '[Event "Rated Blitz"]\n[Site "https://lichess.org/xYzW1234"]\n\n1. d4 d5 *'
    assert extract_game_url(pgn_li) == "https://lichess.org/xYzW1234"

    # 3. External id fallback
    assert (
        extract_game_url("", platform="chesscom", external_id="98765")
        == "https://www.chess.com/game/live/98765"
    )
    assert (
        extract_game_url("", platform="lichess", external_id="abc12345")
        == "https://lichess.org/abc12345"
    )

    # 4. No link available
    assert extract_game_url("1. e4 e5 *", platform="manual") is None
