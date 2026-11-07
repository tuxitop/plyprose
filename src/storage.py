from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sqlite3
from typing import Any

from src.evals import extract_ply_evals_from_pgn, interpolate_ply_evals
from src.fetcher import extract_played_at, parse_raw_pgn_metadata
from src.models import CriticalMoment, GameAnalysisPayload

DEFAULT_DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "outputs",
    "history.db",
)


def compute_analysis_hash(
    report_md: str,
    pgn_text: str,
    payload_json: str | None = None,
) -> str:
    """
    Computes a deterministic SHA-256 hash of a game's report, PGN content,
    and optional payload facts to detect whether local changes need synchronization with GitHub.
    """
    parts = [
        (report_md or "").strip(),
        "---PGN---",
        (pgn_text or "").strip(),
    ]
    if payload_json and payload_json.strip():
        parts.extend(["---PAYLOAD---", payload_json.strip()])
    content = "\n".join(parts)
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def compute_game_hash(pgn_text: str) -> str:
    """
    Computes a deterministic 12-character hexadecimal hash of the game's PGN.
    Used as a stable, instance-independent identifier for games without an external_id.
    """
    clean = re.sub(r"\s+", " ", (pgn_text or "").strip())
    return hashlib.sha256(clean.encode("utf-8")).hexdigest()[:12]


def get_game_key(rec: dict[str, Any]) -> str:
    """
    Returns the deterministic, instance-independent key for a game record:
    - external_id if present (e.g. Lichess/Chess.com game ID)
    - last segment of github_path if present
    - 12-character PGN hash otherwise
    """
    ext_id = rec.get("external_id")
    if ext_id and str(ext_id).strip():
        return str(ext_id).strip()
    github_path = rec.get("github_path")
    if github_path and str(github_path).strip():
        parts = str(github_path).strip().strip("/").split("/")
        if parts:
            return parts[-1]
    return compute_game_hash(rec.get("pgn_text", ""))


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
                github_synced_hash TEXT,
                tags TEXT
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
        if "tags" not in columns:
            conn.execute("ALTER TABLE game_analyses ADD COLUMN tags TEXT;")

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

    repair_missing_ply_evals(db_path)


def repair_missing_ply_evals(db_path: str | None = None) -> int:
    """
    Scans game_analyses for any records where payload_json is missing ply_evals
    (e.g., from earlier pulls or legacy versions) and reconstructs/interpolates
    evaluations from PGN comments or critical moments.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT id, pgn_text, payload_json, result, total_plies
            FROM game_analyses
            WHERE json_extract(payload_json, '$.ply_evals') IS NULL
               OR json_extract(payload_json, '$.ply_evals') = '[]';
            """
        )
        rows = cursor.fetchall()
        if not rows:
            return 0

        repaired_count = 0
        for row in rows:
            aid = row["id"]
            pgn_text = row["pgn_text"] or ""
            raw_payload = row["payload_json"]
            res = row["result"] or "*"
            total_plies = row["total_plies"] or 2

            payload_dict: dict[str, Any] = {}
            if raw_payload:
                try:
                    payload_dict = json.loads(raw_payload)
                except Exception:
                    payload_dict = {}

            # 1. Try extracting [%eval ...] from PGN
            extracted_evals = extract_ply_evals_from_pgn(pgn_text)
            if extracted_evals and len(extracted_evals) > 1:
                evals = extracted_evals
            else:
                # 2. Try interpolating from critical moments if available
                cms_raw = payload_dict.get("critical_moments", [])
                cms: list[CriticalMoment] = []
                for cm_dict in cms_raw:
                    try:
                        cms.append(CriticalMoment.model_validate(cm_dict))
                    except Exception:
                        pass
                evals = interpolate_ply_evals(
                    cms,
                    total_plies=total_plies,
                    result_str=res,
                )

            payload_dict["ply_evals"] = evals
            updated_payload_json = json.dumps(payload_dict)
            conn.execute(
                "UPDATE game_analyses SET payload_json = ? WHERE id = ?;",
                (updated_payload_json, aid),
            )
            repaired_count += 1

        conn.commit()
        return repaired_count


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
                github_synced_hash,
                tags
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
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
                json.dumps(payload.tags if payload.tags else []),
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


def find_analysis_by_github_path(
    github_path: str,
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """
    Checks if a game has already been analyzed in game_analyses by its github_path.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    clean_path = github_path.strip().strip("/")
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM game_analyses WHERE github_path = ?;",
            (clean_path,),
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
                payload_json,
                report_md,
                played_at,
                platform,
                external_id,
                github_path,
                github_synced_hash,
                tags,
                json_extract(payload_json, '$.ply_evals') as ply_evals_json,
                json_extract(payload_json, '$.tags') as tags_json
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

            tags_raw = rec.pop("tags_json", None)
            raw_tags_col = rec.get("tags")
            if tags_raw:
                try:
                    rec["tags"] = json.loads(tags_raw) if isinstance(tags_raw, str) else tags_raw
                except Exception:
                    rec["tags"] = []
            elif raw_tags_col:
                try:
                    rec["tags"] = (
                        json.loads(raw_tags_col) if isinstance(raw_tags_col, str) else raw_tags_col
                    )
                except Exception:
                    rec["tags"] = []
            else:
                rec["tags"] = []

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
            rec["game_key"] = get_game_key(rec)
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

        payload_obj = result_dict.get("payload")
        if payload_obj and getattr(payload_obj, "tags", None):
            result_dict["tags"] = payload_obj.tags
        elif result_dict.get("tags"):
            try:
                result_dict["tags"] = (
                    json.loads(result_dict["tags"])
                    if isinstance(result_dict["tags"], str)
                    else result_dict["tags"]
                )
            except Exception:
                result_dict["tags"] = []
        else:
            result_dict["tags"] = []

        if payload_obj and getattr(payload_obj, "ply_evals", None):
            result_dict["ply_evals"] = payload_obj.ply_evals
        elif result_dict.get("payload_json"):
            try:
                pj = json.loads(result_dict["payload_json"])
                result_dict["ply_evals"] = pj.get("ply_evals")
            except Exception:
                result_dict["ply_evals"] = None
        else:
            result_dict["ply_evals"] = None

        result_dict["game_key"] = get_game_key(result_dict)
        return result_dict


def get_analysis_by_id_or_key(
    identifier: int | str,
    db_path: str | None = None,
) -> dict[str, Any] | None:
    """
    Fetches an analysis record by either:
    1. Primary key integer ID (e.g. 1, 42)
    2. Platform external_id (e.g. 'ATH_TuongThinh_2019', '123456789')
    3. GitHub folder path or folder suffix (e.g. '25-0930-tuxitop-keswic-white')
    4. Deterministic 12-character PGN hash
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)

    ident_str = str(identifier).strip()
    if not ident_str:
        return None

    # Check primary key if it's all digits
    if ident_str.isdigit():
        rec = get_analysis_by_id(int(ident_str), db_path=db_path)
        if rec:
            return rec

    # Otherwise (or if not matched by local primary key ID), query by external_id, github_path, or hash
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        # Look up by external_id
        row = cursor.execute(
            "SELECT id FROM game_analyses WHERE external_id = ?;", (ident_str,)
        ).fetchone()
        if row:
            return get_analysis_by_id(row["id"], db_path=db_path)

        # Look up by github_path (exact or folder suffix)
        row = cursor.execute(
            "SELECT id FROM game_analyses WHERE github_path = ? OR github_path LIKE ?;",
            (ident_str, f"%/{ident_str}"),
        ).fetchone()
        if row:
            return get_analysis_by_id(row["id"], db_path=db_path)

        # Look up by PGN hash
        all_rows = cursor.execute("SELECT id, pgn_text FROM game_analyses;").fetchall()
        for r in all_rows:
            if compute_game_hash(r["pgn_text"]) == ident_str:
                return get_analysis_by_id(r["id"], db_path=db_path)

    return None


def update_analysis_payload(
    analysis_id: int,
    payload: GameAnalysisPayload,
    report_md: str | None = None,
    model_name: str | None = None,
    db_path: str | None = None,
) -> bool:
    """
    Updates the GameAnalysisPayload (including ply_evals, critical_moments, tags)
    and optionally report_md and model_name for an existing analysis record.

    Returns:
        True if the record was updated, False if no record matched analysis_id.
    """
    if db_path is None:
        db_path = DEFAULT_DB_PATH
    init_db(db_path)
    payload_json = payload.model_dump_json()
    tags_json = json.dumps(payload.tags if payload.tags else [])
    with get_connection(db_path) as conn:
        cursor = conn.cursor()
        if report_md is not None and model_name is not None:
            cursor.execute(
                """
                UPDATE game_analyses
                SET payload_json = ?,
                    opening_name = ?,
                    total_plies = ?,
                    critical_moments_count = ?,
                    tags = ?,
                    report_md = ?,
                    model_name = ?
                WHERE id = ?;
                """,
                (
                    payload_json,
                    payload.opening_name,
                    payload.total_plies,
                    len(payload.critical_moments),
                    tags_json,
                    report_md.strip(),
                    model_name.strip(),
                    analysis_id,
                ),
            )
        else:
            cursor.execute(
                """
                UPDATE game_analyses
                SET payload_json = ?,
                    opening_name = ?,
                    total_plies = ?,
                    critical_moments_count = ?,
                    tags = ?
                WHERE id = ?;
                """,
                (
                    payload_json,
                    payload.opening_name,
                    payload.total_plies,
                    len(payload.critical_moments),
                    tags_json,
                    analysis_id,
                ),
            )
        conn.commit()
        return cursor.rowcount > 0


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
    "compute_game_hash",
    "delete_analysis",
    "find_analysis",
    "find_analysis_by_github_path",
    "get_all_analyses",
    "get_analysis_by_id",
    "get_analysis_by_id_or_key",
    "get_game_key",
    "init_db",
    "repair_missing_ply_evals",
    "save_analysis",
    "update_analysis_github_path",
    "update_analysis_github_sync",
    "update_analysis_payload",
    "update_analysis_platform",
    "update_analysis_report",
]
