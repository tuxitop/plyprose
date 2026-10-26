from __future__ import annotations

import base64
import copy
import logging
import os
import re
import xml.etree.ElementTree as ET
from typing import cast

import chess
import chess.svg
import markdown

from src.models import CriticalMoment, GameAnalysisPayload

logger = logging.getLogger(__name__)

SVG_NS = "http://www.w3.org/2000/svg"
XLINK_NS = "http://www.w3.org/1999/xlink"

_XML_PROLOGUE_RE = re.compile(r"<\?xml[^>]*\?>", re.IGNORECASE)
_DOCTYPE_RE = re.compile(r"<!DOCTYPE[^>]*>", re.IGNORECASE)


def sanitize_svg(svg: str) -> str:
    """
    Strips the XML prologue and DOCTYPE from an SVG document so it can be
    embedded safely inside an HTML document (browsers treat them as bogus
    comments and some sanitizers drop the whole element).
    """
    cleaned = _XML_PROLOGUE_RE.sub("", svg)
    cleaned = _DOCTYPE_RE.sub("", cleaned)
    return cleaned.strip()


def inline_svg_uses(svg: str) -> str:
    """
    Replaces every `<use href="#id">` with an inline copy of the referenced
    element (e.g. a piece glyph from `<defs>`).

    HTML sanitizers (like DOMPurify) often strip `<use>` elements.
    python-chess draws every chess piece as `<use href="#white-king">`, so a
    sanitized board renders without pieces. Inlining the references keeps the board
    fully renderable everywhere (sanitized HTML, iframes, PDF export).

    Args:
        svg: Raw SVG document string.

    Returns:
        SVG string with `<use>` references expanded (unchanged on parse errors).
    """
    try:
        ET.register_namespace("", SVG_NS)
        ET.register_namespace("xlink", XLINK_NS)
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        logger.warning("Could not parse SVG for inlining (%s); keeping original", exc)
        return svg

    ids: dict[str, ET.Element] = {}
    for element in root.iter():
        element_id = element.get("id")
        if element_id:
            ids[element_id] = element

    def resolve_target(element: ET.Element) -> str | None:
        href = element.get("href") or element.get(f"{{{XLINK_NS}}}href")
        if href and href.startswith("#"):
            return href[1:]
        return None

    for parent in list(root.iter()):
        for index, child in enumerate(list(parent)):
            if child.tag != f"{{{SVG_NS}}}use":
                continue
            target_id = resolve_target(child)
            target = ids.get(target_id) if target_id else None
            if target is None:
                continue
            clone = copy.deepcopy(target)
            clone.attrib.pop("id", None)
            transform = child.get("transform")
            if transform:
                clone.set("transform", transform)
            parent.remove(child)
            parent.insert(index, clone)

    return ET.tostring(root, encoding="unicode")


PDF_STYLESHEET = """
@page {
    size: A4;
    margin: 20mm;
    @bottom-center {
        content: counter(page);
        font-size: 9pt;
        color: #718096;
    }
}
body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #2d3748;
}
h1 {
    font-size: 20pt;
    color: #1a202c;
    border-bottom: 2px solid #e2e8f0;
    padding-bottom: 8px;
    margin-top: 24px;
    margin-bottom: 16px;
    page-break-after: avoid;
}
h2 {
    font-size: 15pt;
    color: #2b6cb0;
    border-bottom: 1px solid #edf2f7;
    padding-bottom: 6px;
    margin-top: 20px;
    margin-bottom: 12px;
    page-break-after: avoid;
}
h3 {
    font-size: 12pt;
    color: #4a5568;
    margin-top: 16px;
    margin-bottom: 8px;
    page-break-after: avoid;
}
p {
    margin-bottom: 12px;
}
a {
    color: #2563eb;
    text-decoration: underline;
}
table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
    page-break-inside: avoid;
    font-size: 10pt;
}
th, td {
    padding: 8px 10px;
    border: 1px solid #e2e8f0;
    text-align: left;
}
th {
    background-color: #edf2f7;
    font-weight: 600;
    color: #2d3748;
}
tr:nth-child(even) {
    background-color: #f7fafc;
}
blockquote {
    border-left: 4px solid #3182ce;
    padding: 8px 16px;
    margin: 16px 0;
    background-color: #ebf8ff;
    color: #2c5282;
}
code {
    background-color: #f1f5f9;
    padding: 2px 5px;
    border: 1px solid #e2e8f0;
    border-radius: 3px;
    font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 9.5pt;
    font-weight: 600;
    color: #1e293b;
}
pre {
    background-color: #f7fafc;
    border: 1px solid #e2e8f0;
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-family: SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 9pt;
    page-break-inside: avoid;
}
ul, ol {
    padding-left: 24px;
    margin-bottom: 12px;
}
li {
    margin-bottom: 4px;
}
"""


def _generate_fallback_pdf(text: str) -> bytes:
    """
    Creates a minimal valid PDF containing the plain text if WeasyPrint
    or underlying Cairo/Pango system libraries are unavailable.
    """
    # Sanitize and truncate lines for basic text stream
    lines = [line.strip() for line in text.splitlines() if line.strip()][:50]
    stream_content = "BT /F1 10 Tf 50 780 Td 14 TL "
    for line in lines:
        sanitized = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")[:90]
        stream_content += f"({sanitized}) ' "
    stream_content += "ET"

    stream_bytes = stream_content.encode("latin1", errors="replace")
    pdf_template = (
        b"%PDF-1.4\n"
        b"1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n"
        b"2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n"
        b"3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources <</Font <</F1 5 0 R>>>>>> endobj\n"
        b"4 0 obj <</Length "
        + str(len(stream_bytes)).encode()
        + b">> stream\n"
        + stream_bytes
        + b"\nendstream\nendobj\n"
        b"5 0 obj <</Type /Font /Subtype /Type1 /BaseFont /Helvetica>> endobj\n"
        b"xref\n0 6\n0000000000 65535 f \n"
        b"trailer <</Size 6 /Root 1 0 R>>\nstartxref\n300\n%%EOF"
    )
    return pdf_template


BOARD_MARKER_RE = re.compile(r"\{\{BOARD:fen=([^|]+)\|label=([^}]+)\}\}")


def render_board_from_fen(fen: str, size: int = 380) -> str | None:
    """
    Renders a plain board SVG from a FEN string with no arrows.
    Returns None on invalid FEN.
    """
    try:
        board = chess.Board(fen)
    except Exception:
        return None
    return inline_svg_uses(sanitize_svg(chess.svg.board(board=board, size=size)))


def embed_board_markers(markdown_text: str, size: int = 380) -> str:
    """
    Replaces `{{BOARD:fen=...|label=...}}` markers with embedded board images.

    Used for the Markdown and PDF exports so the distributed report contains
    the same diagrams the app renders, without any LLM-authored markup.

    Args:
        markdown_text: Report text possibly containing board markers.
        size: Rendered board size in pixels.

    Returns:
        Markdown text with markers replaced by inline SVG data-URI images.
    """

    def _replace(match: re.Match) -> str:
        fen = match.group(1).strip()
        label = match.group(2).strip()
        svg = render_board_from_fen(fen, size=size)
        if not svg:
            return f"_{label}_" if label else ""
        encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
        caption = f"<em>{label}</em>" if label else ""
        return (
            f'<p style="text-align:center">'
            f'<img src="data:image/svg+xml;base64,{encoded}" '
            f'style="width:{size}px;max-width:100%;height:auto"/>'
            f"</p>"
            f"{caption}"
        )

    return BOARD_MARKER_RE.sub(_replace, markdown_text)


def render_critical_moment_svg(
    moment: CriticalMoment,
    size: int = 400,
    orientation: chess.Color | None = None,
) -> str:
    """
    Renders an SVG board diagram for a single CriticalMoment.
    Highlights the played move in red (#d32f2f) and the engine's best move in green (#2e7d32).

    Args:
        moment: CriticalMoment containing board state and move information.
        size: Width and height of the rendered board in pixels (default: 400).
        orientation: Board orientation (chess.WHITE or chess.BLACK). If None,
                     orients according to the moving player's color.

    Returns:
        SVG string representing the board with move arrows.
    """
    try:
        board = chess.Board(moment.facts_before_move.fen)
    except Exception:
        board = chess.Board()

    arrows: list[chess.svg.Arrow] = []

    # 1. Red arrow for the played move (blunder / mistake)
    try:
        played_move = board.parse_san(moment.move_played_san)
        arrows.append(
            chess.svg.Arrow(
                played_move.from_square,
                played_move.to_square,
                color="#d32f2f",
            )
        )
    except Exception:
        pass

    # 2. Green arrow for the engine's best move
    try:
        best_move = board.parse_san(moment.best_move_san)
        arrows.append(
            chess.svg.Arrow(
                best_move.from_square,
                best_move.to_square,
                color="#2e7d32",
            )
        )
    except Exception:
        pass

    board_orientation = orientation
    if board_orientation is None:
        board_orientation = chess.WHITE if moment.color == "White" else chess.BLACK

    return inline_svg_uses(
        sanitize_svg(
            chess.svg.board(
                board=board,
                arrows=arrows,
                size=size,
                orientation=board_orientation,
            )
        )
    )


def _parse_move_squares(
    moment: CriticalMoment,
    san: str,
) -> tuple[chess.Square, chess.Square] | None:
    """Resolves a SAN move to (from_square, to_square) on the pre-move board."""
    try:
        board = chess.Board(moment.facts_before_move.fen)
        move = board.parse_san(san)
        return move.from_square, move.to_square
    except Exception:
        return None


def render_moment_comparison_svgs(
    moment: CriticalMoment,
    size: int = 380,
) -> dict[str, str]:
    """
    Renders comparison SVG diagrams for a CriticalMoment:
    - "played": Board position after the played move with a red arrow for that move.
    - "best": Board position after the engine's best move with a green arrow for it.
    - "combined": Board position before move showing both arrows (red for played, green for best).

    Args:
        moment: CriticalMoment instance.
        size: Size of the SVG boards.

    Returns:
        Dictionary with keys "played", "best", "combined".
    """
    orientation = chess.WHITE if moment.color == "White" else chess.BLACK

    # Combined board before move with arrows
    combined_svg = render_critical_moment_svg(moment, size=size, orientation=orientation)

    # Board after played move (red arrow for the played move)
    played_arrows: list[chess.svg.Arrow] = []
    played_squares = _parse_move_squares(moment, moment.move_played_san)
    if played_squares:
        played_arrows.append(chess.svg.Arrow(played_squares[0], played_squares[1], color="#d32f2f"))
    try:
        board_played = chess.Board(moment.facts_after_played_move.fen)
        played_svg = inline_svg_uses(
            sanitize_svg(
                chess.svg.board(
                    board=board_played, arrows=played_arrows, size=size, orientation=orientation
                )
            )
        )
    except Exception:
        played_svg = combined_svg

    # Board after best move (green arrow for the engine's best move)
    best_arrows: list[chess.svg.Arrow] = []
    best_squares = _parse_move_squares(moment, moment.best_move_san)
    if best_squares:
        best_arrows.append(chess.svg.Arrow(best_squares[0], best_squares[1], color="#2e7d32"))
    try:
        board_best = chess.Board(moment.facts_after_best_move.fen)
        best_svg = inline_svg_uses(
            sanitize_svg(
                chess.svg.board(
                    board=board_best, arrows=best_arrows, size=size, orientation=orientation
                )
            )
        )
    except Exception:
        best_svg = combined_svg

    return {
        "played": played_svg,
        "best": best_svg,
        "combined": combined_svg,
    }


def build_board_html_document(svg: str, size: int = 380) -> str:
    """
    Wraps a sanitized SVG board into a standalone HTML document.

    Used for iframe or standalone HTML rendering, which renders the
    SVG reliably across web viewers and sanitizers.
    """
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
    html, body {{ margin: 0; padding: 0; background: transparent; }}
    .board-wrap {{ display: flex; justify-content: center; align-items: flex-start; }}
    .board-wrap svg {{ width: 100%; max-width: {size}px; height: auto; display: block; }}
</style>
</head>
<body>
<div class="board-wrap">{svg}</div>
</body>
</html>"""


def render_critical_svgs(
    payload: GameAnalysisPayload,
    size: int = 400,
) -> dict[int, str]:
    """
    Renders SVG diagrams for all critical moments in a GameAnalysisPayload.

    Args:
        payload: GameAnalysisPayload containing critical moments.
        size: Board dimension in pixels.

    Returns:
        Mapping of moment ply index to SVG string.
    """
    svg_map: dict[int, str] = {}
    for moment in payload.critical_moments:
        svg_map[moment.ply] = render_critical_moment_svg(moment, size=size)
    return svg_map


def export_to_pdf(markdown_text: str, output_path: str | None = None) -> bytes:
    """
    Converts a Markdown narrative report into a styled PDF via WeasyPrint.
    Falls back gracefully to a clean minimal PDF if system Cairo/Pango
    libraries are missing or fail.

    Args:
        markdown_text: The markdown report text to convert.
        output_path: Optional file path to save the generated PDF.

    Returns:
        The generated PDF content as raw bytes.
    """
    try:
        import weasyprint

        # Convert markdown to styled HTML (board markers become embedded SVGs)
        html_body = markdown.markdown(
            embed_board_markers(markdown_text),
            extensions=["extra", "tables", "fenced_code", "toc"],
        )

        full_html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>PlyProse Coaching Report</title>
    <style>
        {PDF_STYLESHEET}
    </style>
</head>
<body>
    {html_body}
</body>
</html>"""

        pdf_bytes = weasyprint.HTML(string=full_html).write_pdf()

    except Exception as exc:
        logger.warning(
            f"WeasyPrint PDF rendering unavailable or failed ({exc}). Using fallback PDF generator."
        )
        pdf_bytes = _generate_fallback_pdf(markdown_text)

    if output_path:
        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, "wb") as f:
            f.write(pdf_bytes)

    return cast(bytes, pdf_bytes)


# Alias for compatibility with SPEC.md naming
markdown_to_pdf = export_to_pdf

__all__ = [
    "BOARD_MARKER_RE",
    "build_board_html_document",
    "embed_board_markers",
    "export_to_pdf",
    "inline_svg_uses",
    "markdown_to_pdf",
    "render_board_from_fen",
    "render_critical_moment_svg",
    "render_critical_svgs",
    "render_moment_comparison_svgs",
    "sanitize_svg",
]
