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
    "stockfish_limit_mode": "both",
    "stockfish_backward_analysis": True,
    "llm_provider": "openai-compat",
    "llm_base_url": os.environ.get("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1"),
    "llm_api_key": "",
    "llm_model": os.environ.get("OPENAI_COMPAT_MODEL", "gpt-4o-mini"),
    "gemini_api_key": "",
    "gemini_model": "gemini-2.5-flash",
    "openai_base_url": os.environ.get("OPENAI_COMPAT_BASE_URL", "http://localhost:11434/v1"),
    "openai_api_key": "",
    "openai_model": os.environ.get("OPENAI_COMPAT_MODEL", "gpt-4o-mini"),
    "github_enabled": False,
    "github_auto_pull": True,
    "github_token": "",
    "github_repo": "",
    "github_branch": "main",
    "github_last_synced_sha": "",
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
    settings_dict = {**_DEFAULTS, **stored}

    # Dynamically attach detected stockfish version
    from src.analyzer import get_stockfish_version

    sf_path = settings_dict.get("stockfish_path")
    settings_dict["stockfish_version"] = get_stockfish_version(sf_path)
    return settings_dict


def update_settings(data: dict[str, Any], db_path: str | None = None) -> dict[str, Any]:
    resolved = _resolve_db_path(db_path)
    _init_settings_table(resolved)
    current = get_settings(resolved)

    updated_data = dict(data)

    # Sync provider-specific preferences
    provider = updated_data.get("llm_provider", current.get("llm_provider", "openai-compat"))

    if provider == "gemini":
        if "llm_api_key" in updated_data and "gemini_api_key" not in updated_data:
            updated_data["gemini_api_key"] = updated_data["llm_api_key"]
        elif "gemini_api_key" in updated_data and "llm_api_key" not in updated_data:
            updated_data["llm_api_key"] = updated_data["gemini_api_key"]
        elif "llm_provider" in updated_data and updated_data["llm_provider"] != current.get(
            "llm_provider"
        ):
            # Switching to Gemini: populate active llm fields from stored gemini settings
            if "llm_api_key" not in updated_data:
                updated_data["llm_api_key"] = current.get("gemini_api_key", "")
            if "llm_model" not in updated_data:
                updated_data["llm_model"] = current.get("gemini_model", "gemini-2.5-flash")

        if "llm_model" in updated_data and "gemini_model" not in updated_data:
            updated_data["gemini_model"] = updated_data["llm_model"]
        elif "gemini_model" in updated_data and "llm_model" not in updated_data:
            updated_data["llm_model"] = updated_data["gemini_model"]

    elif provider == "openai-compat":
        if "llm_base_url" in updated_data and "openai_base_url" not in updated_data:
            updated_data["openai_base_url"] = updated_data["llm_base_url"]
        elif "openai_base_url" in updated_data and "llm_base_url" not in updated_data:
            updated_data["llm_base_url"] = updated_data["openai_base_url"]

        if "llm_api_key" in updated_data and "openai_api_key" not in updated_data:
            updated_data["openai_api_key"] = updated_data["llm_api_key"]
        elif "openai_api_key" in updated_data and "llm_api_key" not in updated_data:
            updated_data["llm_api_key"] = updated_data["openai_api_key"]

        if "llm_model" in updated_data and "openai_model" not in updated_data:
            updated_data["openai_model"] = updated_data["llm_model"]
        elif "openai_model" in updated_data and "llm_model" not in updated_data:
            updated_data["llm_model"] = updated_data["openai_model"]
        elif "llm_provider" in updated_data and updated_data["llm_provider"] != current.get(
            "llm_provider"
        ):
            # Switching to OpenAI-compat: populate active llm fields from stored openai settings
            if "llm_base_url" not in updated_data:
                updated_data["llm_base_url"] = current.get(
                    "openai_base_url", "http://localhost:11434/v1"
                )
            if "llm_api_key" not in updated_data:
                updated_data["llm_api_key"] = current.get("openai_api_key", "")
            if "llm_model" not in updated_data:
                updated_data["llm_model"] = current.get("openai_model", "gpt-4o-mini")

    with get_connection(resolved) as conn:
        for k, v in updated_data.items():
            if k in _DEFAULTS:
                conn.execute(
                    "INSERT INTO settings (key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value;",
                    (k, json.dumps(v)),
                )
        conn.commit()
    return get_settings(resolved)


__all__ = ["get_settings", "update_settings"]
