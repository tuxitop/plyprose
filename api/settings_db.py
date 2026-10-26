"""
Settings persistence layer — stores user profile, Stockfish config, and LLM
provider config in a dedicated table in the existing SQLite database.
"""

from __future__ import annotations

import json
import os
from typing import Any

import src.storage as _storage
from src.storage import DEFAULT_DB_PATH, get_connection

_DEFAULTS: dict[str, Any] = {
    "elo": 1200,
    "elo_chesscom_blitz": 1200,
    "elo_chesscom_rapid": 1200,
    "elo_lichess_blitz": 1500,
    "elo_lichess_rapid": 1600,
    "goals": "",
    "chesscom_username": "",
    "lichess_username": "",
    "stockfish_path": os.environ.get("STOCKFISH_PATH", "/usr/sbin/stockfish"),
    "stockfish_depth": 18,
    "stockfish_time": 0.15,
    "llm_provider": "openai-compat",
    "llm_base_url": os.environ.get("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1"),
    "llm_api_key": "",
    "llm_model": os.environ.get("OPENAI_COMPAT_MODEL", "gpt-4o-mini"),
    "github_enabled": False,
    "github_token": "",
    "github_repo": "",
    "github_branch": "main",
}


def _resolve_db_path(db_path: str | None = None) -> str:
    if db_path is not None:
        return db_path
    return getattr(_storage, "DEFAULT_DB_PATH", DEFAULT_DB_PATH)


def _init_settings_table(db_path: str | None = None) -> None:
    resolved = _resolve_db_path(db_path)
    with get_connection(resolved) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        conn.commit()


def get_settings(db_path: str | None = None) -> dict[str, Any]:
    resolved = _resolve_db_path(db_path)
    _init_settings_table(resolved)
    with get_connection(resolved) as conn:
        rows = conn.execute("SELECT key, value FROM settings;").fetchall()
    stored = {row["key"]: json.loads(row["value"]) for row in rows}
    return {**_DEFAULTS, **stored}


def update_settings(data: dict[str, Any], db_path: str | None = None) -> dict[str, Any]:
    resolved = _resolve_db_path(db_path)
    _init_settings_table(resolved)
    with get_connection(resolved) as conn:
        for k, v in data.items():
            if k in _DEFAULTS:
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                    (k, json.dumps(v)),
                )
        conn.commit()
    return get_settings(resolved)


__all__ = ["get_settings", "update_settings"]
