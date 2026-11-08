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

# 4. weasyprint CFFI harfbuzz segfault & FontConfig font availability compatibility
try:
    import os
    import shutil

    from fontTools.fontBuilder import FontBuilder
    from fontTools.ttLib.tables._g_l_y_f import Glyph

    font_dir = "/tmp/plyprose_fonts"
    font_path = os.path.join(font_dir, "TestDummyFont.ttf")
    if not os.path.exists(font_path):
        os.makedirs(font_dir, exist_ok=True)
        fb = FontBuilder(unitsPerEm=1000, isTTF=True)
        fb.setupGlyphOrder([".notdef"])
        fb.setupCharacterMap({})
        fb.setupGlyf({".notdef": Glyph()})
        fb.setupHorizontalMetrics({".notdef": (500, 0)})
        fb.setupHorizontalHeader(ascent=800, descent=-200)
        fb.setupNameTable({"familyName": "TestDummyFont", "styleName": "Regular"})
        fb.setupOS2()
        fb.setupPost()
        fb.save(font_path)

    fonts_conf = f"""<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>{font_dir}</dir>
  <cachedir>/tmp/plyprose_fontcache</cachedir>
</fontconfig>"""
    conf_path = os.path.join(font_dir, "fonts.conf")
    if not os.path.exists(conf_path):
        with open(conf_path, "w") as f:
            f.write(fonts_conf)
    os.environ["FONTCONFIG_FILE"] = conf_path
    if shutil.which("fc-cache"):
        os.system(f"fc-cache -f {font_dir} >/dev/null 2>&1")
except Exception:
    pass

if sys.version_info >= (3, 14):
    try:
        import weasyprint

        def _compat_write_pdf(*args: typing.Any, **kwargs: typing.Any) -> bytes:
            raise OSError(
                "weasyprint CFFI harfbuzz font helper incompatible with Python 3.14 runtime"
            )

        weasyprint.HTML.write_pdf = _compat_write_pdf  # type: ignore[method-assign]
    except Exception:
        pass
