"""
Extended board renderer supporting the new :::board{...}::: tag syntax.
Parses attributes, builds SVG with arrows/circles, and handles zip export
by rendering PNG snapshots via cairosvg.
"""

from __future__ import annotations

import base64
import difflib
import io
import json
import re
import zipfile
from typing import Any, cast

import chess
import chess.pgn
import chess.svg

from src.exporter import BOARD_MARKER_RE, inline_svg_uses, sanitize_svg

# ── New :::board tag parser ────────────────────────────────────────────────────

_BOARD_TAG_RE = re.compile(
    r":::board\{([^}]+)\}[^\n]*\n?:::",
    re.MULTILINE,
)
_ATTR_RE = re.compile(r'(\w+)="([^"]*)"')


def _parse_attrs(raw: str) -> dict[str, str]:
    return dict(_ATTR_RE.findall(raw))


def _parse_arrows(arrow_str: str) -> list[chess.svg.Arrow]:
    """Parses 'e2e4,d1h5' into Arrow objects (green by default)."""
    arrows: list[chess.svg.Arrow] = []
    for token in arrow_str.split(","):
        token = token.strip()
        if len(token) >= 4:
            try:
                frm = chess.parse_square(token[0:2])
                to = chess.parse_square(token[2:4])
                color = token[5:] if len(token) > 5 and token[4] == ":" else "#15803d"
                arrows.append(chess.svg.Arrow(frm, to, color=color))
            except Exception:
                pass
    return arrows


def _parse_circles(circle_str: str) -> set[chess.Square]:
    """Parses 'e5,f7' into a set of squares for highlighting."""
    squares: set[chess.Square] = set()
    for token in circle_str.split(","):
        token = token.strip()
        try:
            squares.add(chess.parse_square(token))
        except Exception:
            pass
    return squares


def render_board_tag(attrs: dict[str, str], size: int = 380) -> str | None:
    """
    Renders a :::board{...}::: tag into an inline SVG string.
    Returns None on invalid FEN.
    """
    fen = attrs.get("fen", "").strip()
    if not fen:
        return None
    try:
        board = chess.Board(fen)
    except Exception:
        return None

    orientation_str = attrs.get("orientation", "white").lower()
    orientation = chess.BLACK if orientation_str == "black" else chess.WHITE

    arrows = _parse_arrows(attrs.get("arrows", ""))
    circles = _parse_circles(attrs.get("circles", ""))

    fill: dict[chess.Square, str] = dict.fromkeys(circles, "#f59e0b80")

    svg = chess.svg.board(
        board=board,
        arrows=arrows,
        fill=fill,
        orientation=orientation,
        size=size,
    )
    return inline_svg_uses(sanitize_svg(svg))


def render_board_tag_as_data_uri(attrs: dict[str, str], size: int = 380) -> str | None:
    """Returns a base64 data-URI for embedding in HTML/Markdown."""
    svg = render_board_tag(attrs, size=size)
    if not svg:
        return None
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


def render_board_tag_as_png_bytes(attrs: dict[str, str], size: int = 560) -> bytes | None:
    """Renders the board to PNG bytes via cairosvg (for zip export)."""
    svg = render_board_tag(attrs, size=size)
    if not svg:
        return None
    try:
        import cairosvg

        return cast(
            bytes | None,
            cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=size, output_height=size),
        )
    except Exception:
        return None


# ── Report text processors ─────────────────────────────────────────────────────

_BOARD_COMMENT_IMAGE_RE = re.compile(
    r"<!--\s*board:\s*([^>]+?)\s*-->\s*\n?!\[(.*?)\]\(\.?/?assets/(diagram_\d+\.svg)\)(?:\s*\n\s*\*(.*?)\*)?",
    re.MULTILINE | re.IGNORECASE,
)

_MD_DIAGRAM_IMAGE_RE = re.compile(
    r"!\[(.*?)\]\(\.?/?assets/diagram_(\d+)\.svg\)(?:\s*\n\s*\*(.*?)\*)?",
    re.MULTILINE | re.IGNORECASE,
)


def resolve_board_fen_from_caption_or_game(
    caption: str,
    diagram_num: int,
    pgn_text: str = "",
    payload: Any = None,
) -> str:
    """
    Deterministically determines the FEN for a diagram reference (e.g. ![Move 12... Nxb3](./assets/diagram_2.svg))
    using the game PGN moves and payload critical moments.
    """
    # 1. Try to find explicit move in PGN
    if pgn_text and pgn_text.strip():
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game:
                # Check for explicit move notation like 'Move 7... Nf6', 'Move 12: 12. Nd5', or '19. Re6+'
                m = re.search(
                    r"\b(?:Move\s+)?(\d+)(?:\s*(\.{1,3})\s*([A-Za-z0-9#+=_-]+)|\s*:\s*(?:(\d+)\s*(\.{1,3})\s*)?([A-Za-z0-9#+=_-]+)?)",
                    caption,
                    re.IGNORECASE,
                )
                m_num = None
                is_black = False
                san_hint = None
                if m:
                    m_num = int(m.group(1))
                    is_black = bool(m.group(2)) or (bool(m.group(5)) if m.group(5) else False)
                    san_hint = m.group(3) or m.group(6)
                if not m_num:
                    m2 = re.search(r"\b(\d+)\s*(?:\.|\.\.\.)\s*([A-Za-z0-9#+=_-]+)", caption)
                    if m2:
                        m_num = int(m2.group(1))
                        is_black = "..." in m2.group(0)
                        san_hint = m2.group(2)

                if m_num:
                    board = game.board()
                    ply = 0
                    candidate_fen = None
                    for move in game.mainline_moves():
                        ply += 1
                        move_idx = (ply + 1) // 2
                        move_color = "w" if ply % 2 == 1 else "b"
                        move_san = board.san(move)
                        board.push(move)
                        if move_idx == m_num:
                            if san_hint and (
                                san_hint.lower() in move_san.lower()
                                or move_san.lower() in san_hint.lower()
                            ):
                                return board.fen()
                            if is_black and move_color == "b":
                                candidate_fen = board.fen()
                            elif not is_black and move_color == "w" and candidate_fen is None:
                                candidate_fen = board.fen()
                    if candidate_fen:
                        return candidate_fen
        except Exception:
            pass

    # 2. Check critical moments from payload
    payload_data = None
    if isinstance(payload, str) and payload.strip():
        try:
            payload_data = json.loads(payload)
        except Exception:
            pass
    elif hasattr(payload, "model_dump"):
        payload_data = payload.model_dump()
    elif isinstance(payload, dict):
        payload_data = payload

    if payload_data and isinstance(payload_data, dict):
        moments = payload_data.get("critical_moments") or []
        # Try matching by move number mentioned in caption
        for mom in moments:
            if isinstance(mom, dict):
                m_num = mom.get("move_number")
                if m_num and f"Move {m_num}" in caption:
                    f_before = mom.get("facts_before_move") or {}
                    if isinstance(f_before, dict) and "fen" in f_before:
                        return str(f_before["fen"])
        # Try diagram index matching (1-indexed diagram -> 0-indexed moment)
        idx = diagram_num - 1
        if 0 <= idx < len(moments):
            mom = moments[idx]
            if isinstance(mom, dict):
                f_before = mom.get("facts_before_move") or {}
                if isinstance(f_before, dict) and "fen" in f_before:
                    return str(f_before["fen"])

    # 3. Fallback to start of PGN if available
    if pgn_text and pgn_text.strip():
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game:
                return game.board().fen()
        except Exception:
            pass

    return chess.STARTING_FEN


def replace_board_tags_with_html(
    report_text: str,
    size: int = 380,
    pgn_text: str = "",
    payload: Any = None,
) -> str:
    """
    Replaces :::board{...}::: blocks, <!-- board: ... --> diagram markers,
    and relative markdown diagram images (./assets/diagram_N.svg) with inline
    data-URI SVG <img> figures for in-app and PDF rendering.
    Also handles legacy {{BOARD:fen=...|label=...}} markers.
    """

    def _replace_new(match: re.Match[str]) -> str:
        attrs = _parse_attrs(match.group(1))
        uri = render_board_tag_as_data_uri(attrs, size=size)
        caption = attrs.get("caption", "")
        if not uri:
            return f"*[Board diagram unavailable: {attrs.get('fen', '')}]*"
        fen_attr = attrs.get("fen", "")
        arrows_attr = attrs.get("arrows", "")
        circles_attr = attrs.get("circles", "")
        img = (
            f'<figure class="board-figure cursor-pointer group hover:opacity-95 transition-opacity" '
            f'style="text-align:center;margin:1.5rem 0;" '
            f'data-fen="{fen_attr}" data-arrows="{arrows_attr}" data-circles="{circles_attr}">'
            f'<img src="{uri}" style="width:{size}px;max-width:100%;height:auto;border-radius:4px;" alt="{caption}" title="Click to view on interactive board"/>'
        )
        if caption:
            img += f'<figcaption style="margin-top:0.5rem;font-size:0.875rem;color:#64748b;">{caption}</figcaption>'
        img += "</figure>"
        return img

    def _replace_legacy(match: re.Match[str]) -> str:
        fen = match.group(1).strip()
        label = match.group(2).strip()
        uri = render_board_tag_as_data_uri({"fen": fen}, size=size)
        if not uri:
            return "*[Board diagram unavailable]*"
        return (
            f'<figure class="board-figure cursor-pointer group hover:opacity-95 transition-opacity" '
            f'style="text-align:center;margin:1.5rem 0;" data-fen="{fen}">'
            f'<img src="{uri}" style="width:{size}px;max-width:100%;height:auto;border-radius:4px;" alt="{label}" title="Click to view on interactive board"/>'
            f'<figcaption style="margin-top:0.5rem;font-size:0.875rem;color:#64748b;">{label}</figcaption>'
            f"</figure>"
        )

    def _replace_comment_diagram(match: re.Match[str]) -> str:
        attrs = _parse_attrs(match.group(1))
        caption = match.group(2).strip() or attrs.get("caption", "")
        if not attrs.get("caption") and caption:
            attrs["caption"] = caption
        uri = render_board_tag_as_data_uri(attrs, size=size)
        if not uri:
            return f"*[Board diagram unavailable: {attrs.get('fen', '')}]*"
        fen_attr = attrs.get("fen", "")
        arrows_attr = attrs.get("arrows", "")
        circles_attr = attrs.get("circles", "")
        img = (
            f'<figure class="board-figure cursor-pointer group hover:opacity-95 transition-opacity" '
            f'style="text-align:center;margin:1.5rem 0;" '
            f'data-fen="{fen_attr}" data-arrows="{arrows_attr}" data-circles="{circles_attr}">'
            f'<img src="{uri}" style="width:{size}px;max-width:100%;height:auto;border-radius:4px;" alt="{caption}" title="Click to view on interactive board"/>'
        )
        if caption:
            img += f'<figcaption style="margin-top:0.5rem;font-size:0.875rem;color:#64748b;">{caption}</figcaption>'
        img += "</figure>"
        return img

    def _replace_md_diagram(match: re.Match[str]) -> str:
        caption = match.group(1).strip()
        diagram_num = int(match.group(2))
        fen = resolve_board_fen_from_caption_or_game(
            caption=caption,
            diagram_num=diagram_num,
            pgn_text=pgn_text,
            payload=payload,
        )
        attrs = {"fen": fen, "caption": caption}
        uri = render_board_tag_as_data_uri(attrs, size=size)
        if not uri:
            return f"*[Board diagram {diagram_num} unavailable]*"
        img = (
            f'<figure class="board-figure cursor-pointer group hover:opacity-95 transition-opacity" '
            f'style="text-align:center;margin:1.5rem 0;" '
            f'data-fen="{fen}">'
            f'<img src="{uri}" style="width:{size}px;max-width:100%;height:auto;border-radius:4px;" alt="{caption}" title="Click to view on interactive board"/>'
        )
        if caption:
            img += f'<figcaption style="margin-top:0.5rem;font-size:0.875rem;color:#64748b;">{caption}</figcaption>'
        img += "</figure>"
        return img

    text = _BOARD_TAG_RE.sub(_replace_new, report_text)
    text = BOARD_MARKER_RE.sub(_replace_legacy, text)
    text = _BOARD_COMMENT_IMAGE_RE.sub(_replace_comment_diagram, text)
    text = _MD_DIAGRAM_IMAGE_RE.sub(_replace_md_diagram, text)
    return text


def build_markdown_zip(report_text: str, png_size: int = 560) -> bytes:
    """
    Builds a .zip bundle:
      report.md  — board tags replaced with ./images/diagram_N.png links
      images/    — PNG files rendered via cairosvg
    """
    diagram_counter = [0]
    image_files: dict[str, bytes] = {}

    def _replace_new(match: re.Match) -> str:
        attrs = _parse_attrs(match.group(1))
        caption = attrs.get("caption", "")
        n = diagram_counter[0] + 1
        diagram_counter[0] = n
        filename = f"diagram_{n}.png"
        png = render_board_tag_as_png_bytes(attrs, size=png_size)
        if png:
            image_files[filename] = png
            alt = caption or f"Diagram {n}"
            md_img = f"![{alt}](./images/{filename})"
            if caption:
                md_img += f"\n*{caption}*"
            return md_img
        return f"*[Board diagram {n} unavailable]*"

    def _replace_legacy(match: re.Match) -> str:
        fen = match.group(1).strip()
        label = match.group(2).strip()
        n = diagram_counter[0] + 1
        diagram_counter[0] = n
        filename = f"diagram_{n}.png"
        png = render_board_tag_as_png_bytes({"fen": fen}, size=png_size)
        if png:
            image_files[filename] = png
            alt = label or f"Diagram {n}"
            md_img = f"![{alt}](./images/{filename})"
            if label:
                md_img += f"\n*{label}*"
            return md_img
        return f"*[Board diagram {n} unavailable]*"

    md_text = _BOARD_TAG_RE.sub(_replace_new, report_text)
    md_text = BOARD_MARKER_RE.sub(_replace_legacy, md_text)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("report.md", md_text.encode("utf-8"))
        for fname, png_bytes in image_files.items():
            zf.writestr(f"images/{fname}", png_bytes)

    return buf.getvalue()


def reconcile_report_fens(
    report_text: str,
    pgn_text: str = "",
    payload: Any = None,
) -> str:
    """
    Validates and reconciles FEN strings inside :::board{...} blocks against
    ground-truth legal game positions and critical moments.

    If an LLM manually crafts or hallucinates a FEN (such as leaving a captured piece
    on its old square and creating duplicate queens), this function identifies the closest
    matching deterministic game position and replaces the hallucinated FEN with the
    correct one.
    """
    if not report_text:
        return report_text

    # Extract payload data if provided (can be dict or GameAnalysisPayload or JSON string)
    payload_data = None
    if isinstance(payload, str) and payload.strip():
        try:
            payload_data = json.loads(payload)
        except Exception:
            pass
    elif hasattr(payload, "model_dump"):
        payload_data = payload.model_dump()
    elif isinstance(payload, dict):
        payload_data = payload

    # Reconcile hallucinated "Platform Game" or "Platform: Game"
    plat_str = None
    if payload_data and isinstance(payload_data, dict):
        plat_str = payload_data.get("platform")
    if not plat_str and pgn_text:
        pgn_low = pgn_text.lower()
        if "chess.com" in pgn_low:
            plat_str = "Chess.com"
        elif "lichess.org" in pgn_low:
            plat_str = "Lichess"
    if plat_str:
        norm_plat = (
            "Chess.com"
            if plat_str.lower() in ("chesscom", "chess.com")
            else "Lichess"
            if plat_str.lower() in ("lichess", "lichess.org")
            else plat_str.capitalize()
        )
        report_text = re.sub(
            r"\bPlatform(?:\s*:\s*|\s+)Game\b",
            f"Platform: {norm_plat}",
            report_text,
            flags=re.IGNORECASE,
        )

    # Ensure Game Link is present if a game URL can be determined
    from src.fetcher import extract_game_url

    game_url = None
    if payload_data and isinstance(payload_data, dict):
        game_url = payload_data.get("game_url")
    if not game_url:
        game_url = extract_game_url(pgn_text, plat_str or "")

    if game_url and game_url not in report_text and "Game Link:" not in report_text:
        link_plat = norm_plat if plat_str else "Online"
        link_bullet = f"- **Game Link:** [View on {link_plat}]({game_url})"
        match_details_m = re.search(r"(-\s*\*\*Match Details:\*\*.*)", report_text)
        if match_details_m:
            report_text = (
                report_text[: match_details_m.end()]
                + f"\n{link_bullet}"
                + report_text[match_details_m.end() :]
            )
        elif "# 1. Game Overview" in report_text:
            overview_idx = report_text.find("# 1. Game Overview") + len("# 1. Game Overview")
            report_text = (
                report_text[:overview_idx] + f"\n\n{link_bullet}" + report_text[overview_idx:]
            )

    valid_fens: set[str] = set()
    move_to_fens: dict[int, list[str]] = {}

    if pgn_text:
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_text))
            if game:
                board = game.board()
                valid_fens.add(board.fen())
                ply = 0
                for move in game.mainline_moves():
                    ply += 1
                    move_num = (ply + 1) // 2
                    board.push(move)
                    fen = board.fen()
                    valid_fens.add(fen)
                    move_to_fens.setdefault(move_num, []).append(fen)
        except Exception:
            pass

    if payload_data and isinstance(payload_data, dict):
        moments = payload_data.get("critical_moments") or []
        for m in moments:
            if isinstance(m, dict):
                m_num = m.get("move_number")
                for k in (
                    "facts_before_move",
                    "facts_after_played_move",
                    "facts_after_best_move",
                    "facts_at_end_of_pv",
                ):
                    f_obj = m.get(k)
                    if isinstance(f_obj, dict) and "fen" in f_obj:
                        fen = f_obj["fen"]
                        valid_fens.add(fen)
                        if m_num:
                            move_to_fens.setdefault(m_num, []).append(fen)

    if not valid_fens:
        return report_text

    # Set of piece placements (first field of FEN)
    valid_placements = {vf.split(" ")[0]: vf for vf in valid_fens}

    def _reconcile_tag(match: re.Match[str]) -> str:
        tag_str = match.group(0)
        body = match.group(1)
        attrs = _parse_attrs(body)
        fen = attrs.get("fen", "").strip()
        if not fen:
            return tag_str

        fen_placement = fen.split(" ")[0]
        # If this exact placement already exists in the valid game positions, it's correct
        if fen_placement in valid_placements:
            return tag_str

        # Look for move number in caption or tag
        caption = attrs.get("caption", "")
        move_match = re.search(r"Move\s+(\d+)", caption, re.IGNORECASE)
        candidates: list[str] = []
        if move_match:
            move_num = int(move_match.group(1))
            candidates.extend(move_to_fens.get(move_num, []))

        if not candidates:
            candidates = list(valid_fens)

        best_cand: str | None = None
        best_ratio = 0.0

        for cand in candidates:
            cand_placement = cand.split(" ")[0]
            ratio = difflib.SequenceMatcher(None, fen_placement, cand_placement).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_cand = cand

        if best_cand and best_ratio >= 0.70:
            new_body = re.sub(r'fen="[^"]*"', f'fen="{best_cand}"', body)
            return tag_str.replace(body, new_body)

        return tag_str

    tag_pattern = re.compile(r":::board\{([^}]+)\}")
    return tag_pattern.sub(_reconcile_tag, report_text)


__all__ = [
    "build_markdown_zip",
    "reconcile_report_fens",
    "render_board_tag",
    "render_board_tag_as_data_uri",
    "render_board_tag_as_png_bytes",
    "replace_board_tags_with_html",
    "resolve_board_fen_from_caption_or_game",
]
