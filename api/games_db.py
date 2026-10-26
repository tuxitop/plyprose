"""
Lightweight storage for fetched/imported games that have not yet been analyzed.
These are separate from the game_analyses table which stores completed analyses.
"""

from __future__ import annotations

import datetime
from typing import Any

from src.fetcher import extract_played_at, parse_raw_pgn_metadata
from src.storage import DEFAULT_DB_PATH, get_connection


def _init_games_table(db_path: str | None = None) -> None:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    with get_connection(db_path) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pending_games (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at  TEXT NOT NULL,
                platform    TEXT NOT NULL DEFAULT 'manual',
                external_id TEXT,
                white       TEXT NOT NULL DEFAULT 'White',
                black       TEXT NOT NULL DEFAULT 'Black',
                result      TEXT NOT NULL DEFAULT '*',
                time_control TEXT NOT NULL DEFAULT 'unknown',
                date        TEXT,
                played_at   TEXT,
                opening_name TEXT,
                pgn_text    TEXT NOT NULL,
                side        TEXT NOT NULL DEFAULT 'both'
            );
        """)
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(pending_games);")
        columns = [row["name"] for row in cursor.fetchall()]
        if "played_at" not in columns:
            conn.execute("ALTER TABLE pending_games ADD COLUMN played_at TEXT;")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_pending_games_created ON pending_games(created_at DESC);"
        )

        # Check if game_analyses table exists and has external_id column
        ga_check = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='game_analyses';"
        ).fetchone()
        if ga_check:
            ga_cols = [
                r["name"] for r in conn.execute("PRAGMA table_info(game_analyses);").fetchall()
            ]
            if "external_id" in ga_cols:
                conn.execute("""
                    DELETE FROM pending_games
                    WHERE external_id IN (
                        SELECT external_id FROM game_analyses WHERE external_id IS NOT NULL AND external_id != ''
                    );
                """)

        # Prune duplicate pending rows keeping max id for each external_id
        conn.execute("""
            DELETE FROM pending_games
            WHERE id NOT IN (
                SELECT MAX(id) FROM pending_games GROUP BY external_id
            ) AND external_id IS NOT NULL AND external_id != '';
        """)

        conn.commit()


def find_pending_game(
    external_id: str | None = None,
    pgn_text: str = "",
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """
    Checks if a game is already in pending_games by external_id or PGN.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        if external_id and str(external_id).strip():
            clean_id = str(external_id).strip()
            row = cursor.execute(
                "SELECT * FROM pending_games WHERE external_id = ?;", (clean_id,)
            ).fetchone()
            if row:
                return dict(row)
            row = cursor.execute(
                "SELECT * FROM pending_games WHERE pgn_text LIKE ?;", (f"%{clean_id}%",)
            ).fetchone()
            if row:
                return dict(row)

        if pgn_text and pgn_text.strip():
            clean_pgn = pgn_text.strip()
            row = cursor.execute(
                "SELECT * FROM pending_games WHERE TRIM(pgn_text) = ?;", (clean_pgn,)
            ).fetchone()
            if row:
                return dict(row)

    return None


def delete_pending_game_by_external_id_or_pgn(
    external_id: str | None = None,
    pgn_text: str = "",
    db_path: str | None = None,
) -> int:
    """
    Deletes all pending games matching external_id or pgn_text.
    Used when a game is successfully analyzed to clean up pending duplicates.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    total_deleted = 0
    with get_connection(db_path) as conn:
        if external_id and str(external_id).strip():
            clean_id = str(external_id).strip()
            cur = conn.execute("DELETE FROM pending_games WHERE external_id = ?;", (clean_id,))
            total_deleted += cur.rowcount
            cur2 = conn.execute(
                "DELETE FROM pending_games WHERE pgn_text LIKE ?;", (f"%{clean_id}%",)
            )
            total_deleted += cur2.rowcount
        if pgn_text and pgn_text.strip():
            clean_pgn = pgn_text.strip()
            cur = conn.execute("DELETE FROM pending_games WHERE TRIM(pgn_text) = ?;", (clean_pgn,))
            total_deleted += cur.rowcount
        conn.commit()
    return total_deleted


def save_pending_game(
    pgn_text: str,
    platform: str = "manual",
    external_id: str | None = None,
    white: str = "White",
    black: str = "Black",
    result: str = "*",
    time_control: str = "unknown",
    date: str | None = None,
    played_at: str | None = None,
    opening_name: str | None = None,
    side: str = "both",
    db_path: str | None = None,
) -> int:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)

    # Auto-detect platform from PGN if default/unspecified
    if (not platform or platform == "manual") and pgn_text:
        pgn_lower = pgn_text.lower()
        if "chess.com" in pgn_lower:
            platform = "chesscom"
        elif "lichess.org" in pgn_lower:
            platform = "lichess"

    # Auto-detect external_id from PGN if omitted
    if not external_id and pgn_text:
        try:
            meta = parse_raw_pgn_metadata(pgn_text)
            external_id = meta.get("id")
        except Exception:
            pass

    # Check if already pending: return existing id if so
    existing = find_pending_game(external_id=external_id, pgn_text=pgn_text, db_path=db_path)
    if existing:
        return int(existing["id"])

    created_at = datetime.datetime.now(datetime.UTC).isoformat()
    if not played_at:
        played_at = extract_played_at(pgn_text, fallback_date=date, fallback_created=created_at)

    with get_connection(db_path) as conn:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO pending_games
                (created_at, platform, external_id, white, black, result, time_control, date, played_at, opening_name, pgn_text, side)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
            (
                created_at,
                platform,
                external_id,
                white,
                black,
                result,
                time_control,
                date,
                played_at,
                opening_name,
                pgn_text.strip(),
                side,
            ),
        )
        conn.commit()
        assert cur.lastrowid is not None
        return int(cur.lastrowid)


def get_pending_games(db_path: str | None = None) -> list[dict[str, Any]]:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    with get_connection(db_path) as conn:
        rows = conn.execute("SELECT * FROM pending_games;").fetchall()
    games = []
    for r in rows:
        rec = dict(r)
        if not rec.get("played_at"):
            rec["played_at"] = extract_played_at(
                rec.get("pgn_text", ""),
                fallback_date=rec.get("date"),
                fallback_created=rec.get("created_at"),
            )
        games.append(rec)

    games.sort(
        key=lambda x: (
            x.get("played_at") or x.get("date") or x.get("created_at") or "",
            x.get("id") or 0,
        ),
        reverse=True,
    )
    return games


def update_pending_game_platform(game_id: int, platform: str, db_path: str | None = None) -> bool:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    with get_connection(db_path) as conn:
        cur = conn.execute(
            "UPDATE pending_games SET platform = ? WHERE id = ?;",
            (platform.strip().lower(), game_id),
        )
        conn.commit()
        return cur.rowcount > 0


def delete_pending_game(game_id: int, db_path: str | None = None) -> bool:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    with get_connection(db_path) as conn:
        cur = conn.execute("DELETE FROM pending_games WHERE id = ?;", (game_id,))
        conn.commit()
        return cur.rowcount > 0


def get_pending_game(game_id: int, db_path: str | None = None) -> dict[str, Any] | None:
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    _init_games_table(db_path)
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM pending_games WHERE id = ?;", (game_id,)).fetchone()
    return dict(row) if row else None


__all__ = [
    "delete_pending_game",
    "delete_pending_game_by_external_id_or_pgn",
    "find_pending_game",
    "get_pending_game",
    "get_pending_games",
    "save_pending_game",
    "update_pending_game_platform",
]
