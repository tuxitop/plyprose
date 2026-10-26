"""
Platform-specific time control classification.
Chess.com and Lichess use different formulas — do NOT unify them.
"""

from __future__ import annotations

import re


def _parse_tc(tc: str) -> tuple[int, int] | None:
    """Parses 'base+inc' or 'base' into (base_seconds, increment_seconds). Returns None on failure."""
    tc = tc.strip()
    m = re.match(r"^(\d+)\+(\d+)$", tc)
    if m:
        return int(m.group(1)), int(m.group(2))
    m2 = re.match(r"^(\d+)$", tc)
    if m2:
        return int(m2.group(1)), 0
    return None


def classify_time_control(tc: str, platform: str) -> dict:
    """
    Classifies a time control string per platform rules.

    Returns:
        {
          "label": "Bullet" | "Blitz" | "Rapid" | "Classical" | "UltraBullet" | "Daily" | "Unknown",
          "icon": "🚀" | "⚡" | "⏱️" | "🏛️",
          "seconds": int,
          "platform": str,
          "raw": str,
        }
    """
    parsed = _parse_tc(tc)
    plat = platform.lower()

    if parsed is None:
        return {"label": "Unknown", "icon": "❓", "seconds": 0, "platform": platform, "raw": tc}

    base, inc = parsed

    if plat == "chesscom" or plat == "chess.com":
        seconds = base + inc * 1
        if seconds < 180:
            label, icon = "Bullet", "🚀"
        elif seconds < 600:
            label, icon = "Blitz", "⚡"
        elif seconds < 3600:
            label, icon = "Rapid", "⏱️"
        else:
            label, icon = "Daily", "🏛️"

    elif plat == "lichess":
        seconds = base + inc * 40
        if seconds <= 29:
            label, icon = "UltraBullet", "🚀"
        elif seconds <= 179:
            label, icon = "Bullet", "🚀"
        elif seconds <= 479:
            label, icon = "Blitz", "⚡"
        elif seconds <= 1499:
            label, icon = "Rapid", "⏱️"
        else:
            label, icon = "Classical", "🏛️"

    else:
        # Manual/generic — FIDE/Lichess formula as fallback
        seconds = base + inc * 40
        if seconds <= 179:
            label, icon = "Bullet", "🚀"
        elif seconds <= 479:
            label, icon = "Blitz", "⚡"
        elif seconds <= 1499:
            label, icon = "Rapid", "⏱️"
        else:
            label, icon = "Classical", "🏛️"

    return {"label": label, "icon": icon, "seconds": seconds, "platform": platform, "raw": tc}


__all__ = ["_parse_tc", "classify_time_control"]
