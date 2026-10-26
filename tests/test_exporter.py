from unittest.mock import patch

import chess
import pytest

from src.exporter import (
    _generate_fallback_pdf,
    build_board_html_document,
    export_to_pdf,
    inline_svg_uses,
    markdown_to_pdf,
    render_critical_moment_svg,
    render_critical_svgs,
    render_moment_comparison_svgs,
    sanitize_svg,
)
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload


@pytest.fixture
def sample_critical_moment() -> CriticalMoment:
    # 1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6?? (Best move: Qe7)
    board_before = chess.Board()
    for m in ["e4", "e5", "Qh5", "Nc6", "Bc4"]:
        board_before.push_san(m)

    board_after_played = board_before.copy()
    board_after_played.push_san("Nf6")

    board_after_best = board_before.copy()
    board_after_best.push_san("Qe7")

    facts_before = extract_tactical_facts(board_before)
    facts_played = extract_tactical_facts(board_after_played)
    facts_best = extract_tactical_facts(board_after_best)

    return CriticalMoment(
        ply=6,
        move_number=3,
        color="Black",
        move_played_san="Nf6",
        eval_before_cp=150,
        eval_after_cp=None,
        mate_before=None,
        mate_after=1,
        classification="Blunder",
        best_move_san="Qe7",
        pv_san=["Qe7", "Ne2"],
        facts_before_move=facts_before,
        facts_after_played_move=facts_played,
        facts_after_best_move=facts_best,
        facts_at_end_of_pv=facts_best,
    )


def test_render_critical_moment_svg(sample_critical_moment: CriticalMoment):
    svg = render_critical_moment_svg(sample_critical_moment, size=350)
    assert isinstance(svg, str)
    assert svg.startswith("<svg") or "<svg" in svg
    assert "</svg>" in svg
    # Red arrow for played blunder
    assert "#d32f2f" in svg
    # Green arrow for best move
    assert "#2e7d32" in svg


def test_render_moment_comparison_svgs(sample_critical_moment: CriticalMoment):
    svgs = render_moment_comparison_svgs(sample_critical_moment, size=350)
    assert isinstance(svgs, dict)
    assert "played" in svgs
    assert "best" in svgs
    assert "combined" in svgs
    assert "</svg>" in svgs["played"]
    assert "</svg>" in svgs["best"]
    assert "</svg>" in svgs["combined"]
    # Played board carries the red move arrow, best board the green one
    assert "#d32f2f" in svgs["played"]
    assert "#2e7d32" in svgs["best"]
    # No XML prologue / DOCTYPE so the SVG embeds cleanly in HTML
    for svg in svgs.values():
        assert not svg.lstrip().startswith("<?xml")
        assert "<!DOCTYPE" not in svg


def test_sanitize_svg_strips_prologue():
    raw = '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg></svg>'
    cleaned = sanitize_svg(raw)
    assert cleaned.startswith("<svg")
    assert "<?xml" not in cleaned
    assert "<!DOCTYPE" not in cleaned


def test_inline_svg_uses_expands_references():
    raw = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
        '<defs><g id="glyph"><circle cx="1" cy="1" r="1"/></g></defs>'
        '<use href="#glyph" transform="translate(2,3)"/>'
        "</svg>"
    )
    out = inline_svg_uses(raw)
    assert "<use" not in out
    assert "<circle" in out
    assert "translate(2,3)" in out


def test_board_svgs_have_no_use_elements(sample_critical_moment: CriticalMoment):
    """Piece glyphs must be inlined: DOMPurify (used by st.html) strips <use>."""
    svgs = render_moment_comparison_svgs(sample_critical_moment, size=350)
    for svg in svgs.values():
        assert "<use" not in svg
        assert "<path" in svg
        assert "translate(" in svg


def test_build_board_html_document(sample_critical_moment: CriticalMoment):
    svgs = render_moment_comparison_svgs(sample_critical_moment, size=350)
    doc = build_board_html_document(svgs["played"], size=350)
    assert doc.startswith("<!DOCTYPE html>")
    assert "<svg" in doc
    assert "max-width: 350px" in doc


def test_render_critical_svgs(sample_critical_moment: CriticalMoment):
    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="Both",
        result="1-0",
        time_control="300",
        opening_name="King Pawn",
        pgn_moves_summary="1. e4 e5",
        total_plies=6,
        critical_moments=[sample_critical_moment],
    )

    svg_map = render_critical_svgs(payload, size=350)
    assert 6 in svg_map
    assert "</svg>" in svg_map[6]


def test_export_to_pdf_success(tmp_path):
    md_content = """# Chess Coaching Report
## Chapter 1: The Critical Blunder
| Move | Evaluation | Note |
|---|---|---|
| 3... Nf6 | Mate in 1 | Overlooked f7 attack |

> **Lesson:** Always calculate forcing checks before attacking opponent's queen.
"""
    pdf_path = tmp_path / "test_report.pdf"
    pdf_bytes = export_to_pdf(md_content, output_path=str(pdf_path))

    assert isinstance(pdf_bytes, bytes)
    assert pdf_bytes.startswith(b"%PDF")
    assert pdf_path.exists()
    assert pdf_path.stat().st_size > 0


def test_markdown_to_pdf_alias():
    md = "# Hello"
    assert markdown_to_pdf(md).startswith(b"%PDF")


def test_export_to_pdf_fallback():
    # Verify fallback if WeasyPrint fails
    with patch("weasyprint.HTML", side_effect=OSError("Missing libcairo")):
        pdf_bytes = export_to_pdf("# Test Title\nSome content")
        assert isinstance(pdf_bytes, bytes)
        assert pdf_bytes.startswith(b"%PDF")


def test_generate_fallback_pdf():
    fallback_bytes = _generate_fallback_pdf("Report Header\nMove 1: e4 e5")
    assert fallback_bytes.startswith(b"%PDF-1.4")
    assert b"Report Header" in fallback_bytes
