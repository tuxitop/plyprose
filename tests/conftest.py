"""Pytest configuration and test environment compatibility setup."""

from __future__ import annotations

import asyncio
import inspect
import sys
import typing

# ── Fix Python 3.14 deprecations in third-party packages ───────────────────────
# 1. chess.engine calls asyncio.iscoroutinefunction (deprecated in 3.14 for inspect.iscoroutinefunction)
asyncio.iscoroutinefunction = inspect.iscoroutinefunction

# 2. chess.engine accesses asyncio.DefaultEventLoopPolicy (deprecated in 3.14)
try:
    if sys.platform == "win32":
        from asyncio import windows_events

        asyncio.DefaultEventLoopPolicy = windows_events._DefaultEventLoopPolicy
    else:
        from asyncio import unix_events

        asyncio.DefaultEventLoopPolicy = unix_events._DefaultEventLoopPolicy
except Exception:
    pass

# 3. google.genai.types compares typing._UnionGenericAlias
try:

    def _quiet_eq(self: typing.Any, other: typing.Any) -> bool | object:
        if other is typing._UnionGenericAlias or other is typing.Union:
            return True
        return NotImplemented

    typing._UnionGenericAliasMeta.__eq__ = _quiet_eq  # type: ignore[attr-defined]
except Exception:
    pass
