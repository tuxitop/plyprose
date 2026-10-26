from __future__ import annotations

import datetime
import hashlib
import json
import os
import sqlite3
from typing import Any

from src.fetcher import extract_played_at, parse_raw_pgn_metadata
from src.models import GameAnalysisPayload

DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "outputs",
    "history.db",
)


def compute_analysis_hash(report_md: str, pgn_text: str) -> str:
    """
    Computes a deterministic SHA-256 hash of a game's report and PGN content
    to detect whether local changes need synchronization with GitHub.
    """
    content = f"{(report_md or '').strip()}\n---PGN---\n{(pgn_text or '').strip()}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def get_connection(db_path: str | None = None) -> sqlite3.Connection:
    """Returns a SQLite connection with row factory configured and directory created."""
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db(db_path: str | None = None) -> None:
    """Initializes the database schema for storing game analysis history."""
    with get_connection(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS game_analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                white_player TEXT NOT NULL,
                black_player TEXT NOT NULL,
                result TEXT NOT NULL,
                time_control TEXT NOT NULL,
                opening_name TEXT,
                total_plies INTEGER NOT NULL,
                critical_moments_count INTEGER NOT NULL,
                model_name TEXT NOT NULL,
                pgn_text TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                report_md TEXT NOT NULL,
                played_at TEXT,
                platform TEXT NOT NULL DEFAULT 'manual',
                external_id TEXT,
                github_path TEXT,
                github_synced_hash TEXT
            );
            """
        )
        cursor = conn.cursor()
        cursor.execute("PRAGMA table_info(game_analyses);")
        columns = [row["name"] for row in cursor.fetchall()]
        if "played_at" not in columns:
            conn.execute("ALTER TABLE game_analyses ADD COLUMN played_at TEXT;")
        if "platform" not in columns:
            conn.execute(
                "ALTER TABLE game_analyses ADD COLUMN platform TEXT NOT NULL DEFAULT 'manual';"
            )
        if "external_id" not in columns:
            conn.execute("ALTER TABLE game_analyses ADD COLUMN external_id TEXT;")
        if "github_path" not in columns:
            conn.execute("ALTER TABLE game_analyses ADD COLUMN github_path TEXT;")
        if "github_synced_hash" not in columns:
            conn.execute("ALTER TABLE game_analyses ADD COLUMN github_synced_hash TEXT;")

        # Backfill platform and external_id for existing rows if needed
        rows = conn.execute(
            "SELECT id, pgn_text, platform, external_id FROM game_analyses WHERE platform IS NULL OR platform = 'manual' OR external_id IS NULL;"
        ).fetchall()
        for r in rows:
            rid, pgn, plat, ext_id = r["id"], r["pgn_text"] or "", r["platform"], r["external_id"]
            new_plat = plat
            new_ext_id = ext_id
            pgn_lower = pgn.lower()
            if not plat or plat == "manual":
                if "chess.com" in pgn_lower:
                    new_plat = "chesscom"
                elif "lichess.org" in pgn_lower:
                    new_plat = "lichess"
            if not ext_id and pgn:
                try:
                    meta = parse_raw_pgn_metadata(pgn)
                    new_ext_id = meta.get("id")
                except Exception:
                    pass
            if new_plat != plat or new_ext_id != ext_id:
                conn.execute(
                    "UPDATE game_analyses SET platform = ?, external_id = ? WHERE id = ?",
                    (new_plat, new_ext_id, rid),
                )

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_game_analyses_created_at ON game_analyses(created_at DESC);"
        )
        conn.commit()


def save_analysis(
    pgn_text: str,
    payload: GameAnalysisPayload,
    report_md: str,
    model_name: str,
    platform: str = "manual",
    external_id: str | None = None,
    db_path: str | None = None,
    played_at: str | None = None,
    github_path: str | None = None,
    github_synced_hash: str | None = None,
) -> int:
    """
    Saves a completed game analysis and narrative report to the SQLite database.

    Args:
        pgn_text: Raw PGN text of the analyzed game.
        payload: The GameAnalysisPayload object containing deterministic analysis facts.
        report_md: The generated markdown narrative report from Gemini.
        model_name: Name of the Gemini model used for the report.
        platform: Platform name ('chesscom', 'lichess', 'manual'). Auto-detected if manual.
        external_id: Optional external platform game ID. Auto-detected from PGN if omitted.
        db_path: Path to the SQLite database file.
        played_at: Optional played timestamp string. If None, extracted from pgn_text.
        github_path: Optional folder path where the game is synced in GitHub.
        github_synced_hash: Optional SHA-256 hash of the content synced to GitHub.

    Returns:
        The integer primary key (id) of the inserted record.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    created_at = datetime.datetime.now(datetime.UTC).isoformat()
    payload_json = payload.model_dump_json()

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

    if not played_at:
        played_at = extract_played_at(pgn_text, fallback_created=created_at)

    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            INSERT INTO game_analyses (
                created_at,
                white_player,
                black_player,
                result,
                time_control,
                opening_name,
                total_plies,
                critical_moments_count,
                model_name,
                pgn_text,
                payload_json,
                report_md,
                played_at,
                platform,
                external_id,
                github_path,
                github_synced_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
            """,
            (
                created_at,
                payload.white_player,
                payload.black_player,
                payload.result,
                payload.time_control,
                payload.opening_name,
                payload.total_plies,
                len(payload.critical_moments),
                model_name,
                pgn_text.strip(),
                payload_json,
                report_md.strip(),
                played_at,
                platform,
                external_id,
                github_path,
                github_synced_hash,
            ),
        )
        conn.commit()
        assert cursor.lastrowid is not None
        return int(cursor.lastrowid)


def update_analysis_github_sync(
    analysis_id: int,
    github_path: str | None,
    github_synced_hash: str | None = None,
    db_path: str | None = None,
) -> bool:
    """Updates both the github_path and github_synced_hash for an existing analysis record."""
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cur = conn.execute(
            """
            UPDATE game_analyses
            SET github_path = ?, github_synced_hash = ?
            WHERE id = ?;
            """,
            (github_path, github_synced_hash, analysis_id),
        )
        conn.commit()
        return cur.rowcount > 0


def update_analysis_github_path(
    analysis_id: int,
    github_path: str | None,
    db_path: str | None = None,
) -> bool:
    """Updates the github_path for an existing analysis record (backwards compatible)."""
    return update_analysis_github_sync(analysis_id, github_path, None, db_path)


def find_analysis(
    external_id: str | None = None,
    pgn_text: str = "",
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """
    Checks if a game has already been analyzed in game_analyses by external_id or PGN.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        if external_id and str(external_id).strip():
            clean_id = str(external_id).strip()
            row = cursor.execute(
                "SELECT * FROM game_analyses WHERE external_id = ?;", (clean_id,)
            ).fetchone()
            if row:
                return dict(row)
            row = cursor.execute(
                "SELECT * FROM game_analyses WHERE pgn_text LIKE ?;", (f"%{clean_id}%",)
            ).fetchone()
            if row:
                return dict(row)

        if pgn_text and pgn_text.strip():
            clean_pgn = pgn_text.strip()
            row = cursor.execute(
                "SELECT * FROM game_analyses WHERE TRIM(pgn_text) = ?;", (clean_pgn,)
            ).fetchone()
            if row:
                return dict(row)

    return None


def get_all_analyses(db_path: str | None = None) -> list[dict[str, Any]]:
    """
    Fetches lightweight summaries of all saved analyses, ordered newest first by played time.

    Returns:
        List of dicts with summary metadata.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                id,
                created_at,
                white_player,
                black_player,
                result,
                time_control,
                opening_name,
                total_plies,
                critical_moments_count,
                model_name,
                pgn_text,
                report_md,
                played_at,
                platform,
                external_id,
                github_path,
                github_synced_hash,
                json_extract(payload_json, '$.ply_evals') as ply_evals_json
            FROM game_analyses;
            """
        )
        rows = cursor.fetchall()
        analyses = []
        for row in rows:
            rec = dict(row)
            evals_raw = rec.pop("ply_evals_json", None)
            if evals_raw:
                try:
                    rec["ply_evals"] = (
                        json.loads(evals_raw) if isinstance(evals_raw, str) else evals_raw
                    )
                except Exception:
                    rec["ply_evals"] = None
            else:
                rec["ply_evals"] = None

            if not rec.get("played_at"):
                rec["played_at"] = extract_played_at(
                    rec.get("pgn_text", ""), fallback_created=rec.get("created_at", "")
                )
            if not rec.get("platform") or rec["platform"] == "manual":
                pgn_low = (rec.get("pgn_text") or "").lower()
                if "chess.com" in pgn_low:
                    rec["platform"] = "chesscom"
                elif "lichess.org" in pgn_low:
                    rec["platform"] = "lichess"
            analyses.append(rec)

        analyses.sort(
            key=lambda x: (
                x.get("played_at") or x.get("created_at") or "",
                x.get("id") or 0,
            ),
            reverse=True,
        )
        return analyses


def get_analysis_by_id(
    analysis_id: int,
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """
    Fetches the complete saved analysis by its primary key ID,
    including the deserialized GameAnalysisPayload object.

    Returns:
        Dictionary with full analysis details and payload object, or None if not found.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                id,
                created_at,
                white_player,
                black_player,
                result,
                time_control,
                opening_name,
                total_plies,
                critical_moments_count,
                model_name,
                pgn_text,
                payload_json,
                report_md,
                played_at,
                platform,
                external_id,
                github_path,
                github_synced_hash
            FROM game_analyses
            WHERE id = ?;
            """,
            (analysis_id,),
        )
        row = cursor.fetchone()
        if not row:
            return None

        result_dict = dict(row)
        if not result_dict.get("platform") or result_dict["platform"] == "manual":
            pgn_low = (result_dict.get("pgn_text") or "").lower()
            if "chess.com" in pgn_low:
                result_dict["platform"] = "chesscom"
            elif "lichess.org" in pgn_low:
                result_dict["platform"] = "lichess"
        # Parse payload_json back into a GameAnalysisPayload instance
        try:
            result_dict["payload"] = GameAnalysisPayload.model_validate_json(
                result_dict["payload_json"]
            )
        except Exception:
            result_dict["payload"] = None

        return result_dict


def update_analysis_report(
    analysis_id: int,
    report_md: str,
    model_name: str,
    db_path: str | None = None,
) -> bool:
    """
    Updates the narrative coaching report and model name for an existing analysis record.

    Returns:
        True if the record was updated, False if no record matched analysis_id.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            UPDATE game_analyses
            SET report_md = ?, model_name = ?
            WHERE id = ?;
            """,
            (report_md.strip(), model_name.strip(), analysis_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def update_analysis_platform(
    analysis_id: int,
    platform: str,
    db_path: str | None = None,
) -> bool:
    """
    Updates the platform tag ('lichess', 'chesscom', 'manual') for an analysis record.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE game_analyses SET platform = ? WHERE id = ?;",
            (platform.strip().lower(), analysis_id),
        )
        conn.commit()
        return cursor.rowcount > 0


def delete_analysis(analysis_id: int, db_path: str | None = None) -> bool:
    """
    Deletes an analysis record from the database by ID.

    Returns:
        True if the record was deleted, False if not found.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM game_analyses WHERE id = ?;",
            (analysis_id,),
        )
        conn.commit()
        return cursor.rowcount > 0


def clear_all_analyses(db_path: str | None = None) -> None:
    """Deletes all analysis records from the database."""
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    with get_connection(db_path) as conn:
        conn.execute("DELETE FROM game_analyses;")
        conn.commit()


__all__ = [
    "DEFAULT_DB_PATH",
    "clear_all_analyses",
    "compute_analysis_hash",
    "delete_analysis",
    "find_analysis",
    "get_all_analyses",
    "get_analysis_by_id",
    "init_db",
    "save_analysis",
    "update_analysis_github_path",
    "update_analysis_github_sync",
    "update_analysis_platform",
    "update_analysis_report",
]
