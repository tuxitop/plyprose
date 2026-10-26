"""
Ratings detection and resolution service.
Extracts player ratings from PGN headers in stored/pending games and from platform profiles.
Handles platform-specific (Lichess vs Chess.com) and time control-specific (Blitz vs Rapid) ratings.
"""

from __future__ import annotations

import io
from typing import Any

import chess.pgn

from api.settings_db import get_settings
from api.time_control import classify_time_control
from src.fetcher import extract_played_at, fetch_chesscom_ratings, fetch_lichess_ratings
from src.storage import DEFAULT_DB_PATH, get_connection


def detect_ratings_from_games(db_path: str | None = None) -> dict[str, dict[str, Any]]:
    """
    Scans all stored games (analyzed and pending) to detect the player's most recent
    Elo rating for each platform and time-control category (blitz, rapid).

    Returns a dict with keys:
        'chesscom_blitz', 'chesscom_rapid', 'lichess_blitz', 'lichess_rapid'
    Each containing:
        {'rating': int, 'played_at': str, 'opponent': str, 'platform': str, 'category': str, 'source': 'pgn'}
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH

    settings = get_settings(db_path)
    chesscom_user = (settings.get("chesscom_username") or "").strip().lower()
    lichess_user = (settings.get("lichess_username") or "").strip().lower()

    # Query all games from both tables
    with get_connection(db_path) as conn:
        try:
            analyses_rows = conn.execute(
                "SELECT pgn_text, created_at FROM game_analyses;"
            ).fetchall()
        except Exception:
            analyses_rows = []

        try:
            pending_rows = conn.execute(
                "SELECT pgn_text, platform, side, created_at, played_at FROM pending_games;"
            ).fetchall()
        except Exception:
            pending_rows = []

    detected: dict[str, dict[str, Any]] = {}

    all_items: list[dict[str, Any]] = []
    for r in analyses_rows:
        row_dict = dict(r)
        all_items.append(
            {
                "pgn": row_dict.get("pgn_text", ""),
                "created_at": row_dict.get("created_at", ""),
                "side": "both",
                "platform": "manual",
            }
        )
    for r in pending_rows:
        row_dict = dict(r)
        all_items.append(
            {
                "pgn": row_dict.get("pgn_text", ""),
                "created_at": row_dict.get("created_at", ""),
                "side": row_dict.get("side", "both"),
                "platform": row_dict.get("platform", "manual"),
            }
        )

    for item in all_items:
        pgn_str = item["pgn"]
        if not pgn_str or not isinstance(pgn_str, str) or not pgn_str.strip():
            continue

        try:
            game = chess.pgn.read_game(io.StringIO(pgn_str.strip()))
            if not game:
                continue
            headers = dict(game.headers)
        except Exception:
            continue

        w_name = (headers.get("White") or "").strip()
        b_name = (headers.get("Black") or "").strip()
        w_elo = headers.get("WhiteElo")
        b_elo = headers.get("BlackElo")
        tc = headers.get("TimeControl", "")
        site = (headers.get("Site") or "").lower()
        link = (headers.get("Link") or "").lower()

        # Identify platform
        plat = item.get("platform")
        if not plat or plat == "manual":
            if "chess.com" in site or "chess.com" in link or "chess.com" in pgn_str.lower():
                plat = "chesscom"
            elif "lichess.org" in site or "lichess.org" in link or "lichess.org" in pgn_str.lower():
                plat = "lichess"
            else:
                plat = "manual"

        if plat not in ("chesscom", "lichess"):
            continue

        # Classify time control
        tc_info = classify_time_control(tc, plat)
        speed = tc_info.get("label", "").lower()
        if speed not in ("blitz", "rapid"):
            continue

        # Determine which player is the user
        user_rating: int | None = None
        opponent = ""
        user_color = ""

        my_user = chesscom_user if plat == "chesscom" else lichess_user
        if my_user:
            if w_name.lower() == my_user:
                user_color = "white"
                opponent = b_name
            elif b_name.lower() == my_user:
                user_color = "black"
                opponent = w_name

        if not user_color and item.get("side") in ("white", "black"):
            user_color = item["side"]
            opponent = b_name if user_color == "white" else w_name

        if user_color == "white" and w_elo and str(w_elo).isdigit():
            user_rating = int(w_elo)
        elif user_color == "black" and b_elo and str(b_elo).isdigit():
            user_rating = int(b_elo)

        if not user_rating or user_rating < 100 or user_rating > 3500:
            continue

        played_at = extract_played_at(
            pgn_str,
            fallback_date=headers.get("Date"),
            fallback_created=item.get("created_at"),
        )
        key = f"{plat}_{speed}"

        prev = detected.get(key)
        if not prev or (played_at and played_at > prev.get("played_at", "")):
            detected[key] = {
                "rating": user_rating,
                "played_at": played_at,
                "opponent": opponent,
                "platform": plat,
                "category": speed,
                "source": "pgn",
            }

    return detected


def get_detected_ratings(db_path: str | None = None) -> dict[str, Any]:
    """
    Combines ratings detected from local game PGNs and live platform profile stats.
    Returns detected data plus suggestions ready to apply to settings.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH

    settings = get_settings(db_path)
    chesscom_user = (settings.get("chesscom_username") or "").strip()
    lichess_user = (settings.get("lichess_username") or "").strip()

    pgn_ratings = detect_ratings_from_games(db_path)

    live_ratings: dict[str, int] = {}
    if chesscom_user:
        cc_stats = fetch_chesscom_ratings(chesscom_user)
        for cat, r in cc_stats.items():
            if cat in ("blitz", "rapid"):
                live_ratings[f"chesscom_{cat}"] = r

    if lichess_user:
        li_stats = fetch_lichess_ratings(lichess_user)
        for cat, r in li_stats.items():
            if cat in ("blitz", "rapid"):
                live_ratings[f"lichess_{cat}"] = r

    suggestions: dict[str, int] = {}
    for key in ("chesscom_blitz", "chesscom_rapid", "lichess_blitz", "lichess_rapid"):
        val = live_ratings.get(key)
        if val is None and key in pgn_ratings:
            val = pgn_ratings.get(key, {}).get("rating")
        if val is not None:
            suggestions[f"elo_{key}"] = int(val)

    return {
        "pgn_ratings": pgn_ratings,
        "live_ratings": live_ratings,
        "suggestions": suggestions,
    }


__all__ = ["detect_ratings_from_games", "get_detected_ratings"]
