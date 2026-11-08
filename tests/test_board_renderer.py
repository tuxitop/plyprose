from __future__ import annotations

import re
from typing import Any

import chess
from fastapi.testclient import TestClient

from api.board_renderer import (
    replace_board_tags_with_html,
    resolve_board_fen_from_caption_or_game,
)
from api.main import app
from src.github_sync import build_game_repo_files
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload
from src.storage import get_analysis_by_id_or_key, save_analysis


def test_replace_board_tags_with_html_new_tag():
    md = ':::board{fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" caption="Move 1: e4"}:::'
    html = replace_board_tags_with_html(md, size=380)

    assert '<figure class="board-figure' in html
    assert 'data-fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"' in html
    assert '<img src="data:image/svg+xml;base64,' in html
    assert "<figcaption" in html
    assert "Move 1: e4" in html


def test_replace_board_tags_with_html_comment_metadata():
    md = (
        '<!-- board: fen="r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3" '
        'caption="Move 3: Nf3" arrows="g1f3" circles="e4,e5" -->\n'
        "![Move 3: Nf3](./assets/diagram_1.svg)\n\n"
        "*Move 3: Nf3*"
    )
    html = replace_board_tags_with_html(md, size=380)

    assert '<figure class="board-figure' in html
    assert 'data-fen="r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"' in html
    assert 'data-arrows="g1f3"' in html
    assert 'data-circles="e4,e5"' in html
    assert '<img src="data:image/svg+xml;base64,' in html
    assert "./assets/diagram_1.svg" not in html


def test_resolve_board_fen_from_caption_and_pgn():
    pgn = """[Event "Test"]
[Site "Chess.com"]
1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. Be2 e5 7. Nf3 Be7 8. O-O O-O *"""

    # Caption with move 7... Be7
    fen = resolve_board_fen_from_caption_or_game(
        caption="Move 7... Be7: Black develops dark-squared bishop.",
        diagram_num=1,
        pgn_text=pgn,
    )
    b = chess.Board(fen)
    assert b.piece_at(chess.E7) == chess.Piece(chess.BISHOP, chess.BLACK)

    # Caption with move 8: O-O
    fen2 = resolve_board_fen_from_caption_or_game(
        caption="Move 8: White castles kingside to safety.",
        diagram_num=2,
        pgn_text=pgn,
    )
    b2 = chess.Board(fen2)
    assert b2.piece_at(chess.G1) == chess.Piece(chess.KING, chess.WHITE)


def test_replace_board_tags_with_html_bare_assets_image_with_pgn():
    pgn = """[Event "Test"]
1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *"""
    report_md = """# Analysis
Here is the position after Italian opening:

![Move 3... Bc5: Italian Game setup](./assets/diagram_1.svg)

*Move 3... Bc5: Italian Game setup*
"""
    html = replace_board_tags_with_html(report_md, size=380, pgn_text=pgn)

    assert '<figure class="board-figure' in html
    assert '<img src="data:image/svg+xml;base64,' in html
    assert "./assets/diagram_1.svg" not in html
    # Check that data-fen contains the bishop on c5
    m = re.search(r'data-fen="([^"]+)"', html)
    assert m is not None
    b = chess.Board(m.group(1))
    assert b.piece_at(chess.C5) == chess.Piece(chess.BISHOP, chess.BLACK)


def test_replace_board_tags_with_html_critical_moments_fallback():
    fen_moment = "r1bqkb1r/pppp1ppp/2n5/4p3/2B1n3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 5"
    facts = extract_tactical_facts(chess.Board(fen_moment))
    moment = CriticalMoment(
        ply=8,
        move_number=4,
        color="Black",
        move_played_san="Nxe4",
        eval_before_cp=20,
        eval_after_cp=-250,
        classification="Blunder",
        best_move_san="d5",
        pv_san=["d5"],
        facts_before_move=facts,
        facts_after_played_move=facts,
        facts_after_best_move=facts,
        facts_at_end_of_pv=facts,
    )
    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="0-1",
        time_control="300",
        total_plies=10,
        pgn_moves_summary="1. e4 e5 2. Nf3 Nc6 3. Bc4 Nxe4",
        critical_moments=[moment],
    )

    report_md = "![Diagram 1: Black sacrifices knight on e4](./assets/diagram_1.svg)"
    html = replace_board_tags_with_html(report_md, size=380, payload=payload)

    assert '<figure class="board-figure' in html
    assert f'data-fen="{fen_moment}"' in html
    assert '<img src="data:image/svg+xml;base64,' in html
    assert "./assets/diagram_1.svg" not in html


def test_build_game_repo_files_roundtrip_with_replace_board_tags():
    orig_md = """# Game Analysis
:::board{fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1" caption="Move 1: e4"}:::
Good move.
"""
    pgn = "1. e4 *"
    repo_files = build_game_repo_files(report_md=orig_md, pgn_text=pgn)

    converted_md = str(repo_files["report.md"])
    assert "<!-- board: " in converted_md
    assert "./assets/diagram_1.svg" in converted_md

    # Now simulate pulling converted_md and rendering in app
    rendered_html = replace_board_tags_with_html(converted_md, size=380, pgn_text=pgn)
    assert '<figure class="board-figure' in rendered_html
    assert 'data-fen="rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"' in rendered_html
    assert '<img src="data:image/svg+xml;base64,' in rendered_html
    assert "./assets/diagram_1.svg" not in rendered_html


def test_api_get_analysis_html_replaces_assets_svg_links(tmp_path: Any, monkeypatch: Any):
    test_db = str(tmp_path / "test_board_api.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr(
        "api.main.get_analysis_by_id_or_key",
        lambda aid: get_analysis_by_id_or_key(aid, db_path=test_db),
    )

    pgn = """[Event "Casual Game"]
[White "Grandmaster"]
[Black "Challenger"]
1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *"""

    report_md = """# Coaching Report
### Italian Game
![Move 3... Bc5: Black develops bishop to active diagonal](./assets/diagram_1.svg)

*Move 3... Bc5: Black develops bishop to active diagonal*
"""
    payload = GameAnalysisPayload(
        white_player="Grandmaster",
        black_player="Challenger",
        user_color="White",
        result="*",
        time_control="300",
        total_plies=6,
        pgn_moves_summary="1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5",
        critical_moments=[],
    )
    aid = save_analysis(
        pgn_text=pgn,
        payload=payload,
        report_md=report_md,
        model_name="github-sync",
        platform="chesscom",
        db_path=test_db,
    )

    client = TestClient(app)
    resp = client.get(f"/api/analysis/{aid}/report-html")
    assert resp.status_code == 200
    data = resp.json()

    assert "report_html" in data
    html = data["report_html"]

    # Verify no broken relative asset links
    assert "./assets/diagram_1.svg" not in html
    assert "assets/diagram_1.svg" not in html
    # Verify rendered figure and base64 data URI
    assert '<figure class="board-figure' in html
    assert 'data-fen="' in html
    assert '<img src="data:image/svg+xml;base64,' in html
