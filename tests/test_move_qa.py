from __future__ import annotations

import chess
import pytest
from fastapi.testclient import TestClient

from api.main import app, append_qa_to_report_markdown
from src.coach_agent import extract_move_qa_context, generate_deterministic_move_answer
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload
from src.storage import get_analysis_by_id, save_analysis

SAMPLE_PGN = (
    '[Event "Rated Blitz game"]\n'
    '[Site "https://lichess.org/test1234"]\n'
    '[Date "2026.10.25"]\n'
    '[White "PlayerW"]\n'
    '[Black "PlayerB"]\n'
    '[Result "1-0"]\n\n'
    "1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 "
    "7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. Nxe5 dxe5 12. dxe5 Nxe5 1-0\n"
)


def test_append_qa_to_report_markdown_placement() -> None:
    original_md = (
        "# 1. Executive Summary\n\n"
        "Great tactical battle.\n\n"
        "---\n\n"
        "# 7. Verification Report\n\n"
        "- Fact-checking verified: 100%\n"
    )

    # First append
    updated_1 = append_qa_to_report_markdown(
        report_md=original_md,
        formal_question="Why is 11. Nxe5 considered a mistake instead of 11. Bxe5?",
        answer_markdown="11. Nxe5 allows `11... dxe5 12. dxe5 Nxe5` leaving Black with active central pieces.",
        move_context="Move 11 (11. Nxe5) · White to play",
    )

    assert "# Follow-up Coaching & Deep Dives" in updated_1
    assert "### Q: Why is 11. Nxe5 considered a mistake instead of 11. Bxe5?" in updated_1
    assert "**Context:** Move 11 (11. Nxe5) · White to play" in updated_1
    # Check it appears before Verification Report
    qa_pos = updated_1.find("# Follow-up Coaching & Deep Dives")
    verif_pos = updated_1.find("# 7. Verification Report")
    assert qa_pos != -1
    assert verif_pos != -1
    assert qa_pos < verif_pos

    # Second append: should add under the same section heading, not create a duplicate
    updated_2 = append_qa_to_report_markdown(
        report_md=updated_1,
        formal_question="What tactical pattern applies to 12. dxe5?",
        answer_markdown="12. dxe5 leads to simplification where Black equalizes easily.",
        move_context="Move 12 (12. dxe5) · White to play",
    )

    # Count occurrences of the section heading
    assert updated_2.count("# Follow-up Coaching & Deep Dives") == 1
    assert "### Q: Why is 11. Nxe5 considered a mistake instead of 11. Bxe5?" in updated_2
    assert "### Q: What tactical pattern applies to 12. dxe5?" in updated_2
    assert updated_2.find("# Follow-up Coaching & Deep Dives") < updated_2.find(
        "# 7. Verification Report"
    )


def test_extract_move_qa_context_and_deterministic_answer() -> None:
    board = chess.Board()
    facts = extract_tactical_facts(board)
    cm = CriticalMoment(
        ply=21,
        move_number=11,
        color="White",
        classification="Mistake",
        move_played_san="Nxe5",
        best_move_san="Bxe5",
        eval_before_cp=120,
        eval_after_cp=-80,
        eval_loss_cp=200,
        pv_san=["Bxe5", "dxe5", "Nxe5"],
        refutation_san=["dxe5", "dxe5", "Nxe5"],
        narrative="11. Nxe5 gives away White's edge.",
        facts_before_move=facts,
        facts_after_played_move=facts,
        facts_after_best_move=facts,
        facts_at_end_of_pv=facts,
    )
    payload = GameAnalysisPayload(
        white_player="PlayerW",
        black_player="PlayerB",
        user_color="White",
        result="1-0",
        time_control="300+3",
        pgn_moves_summary="Ruy Lopez",
        total_plies=24,
        critical_moments=[cm],
    )

    ctx = extract_move_qa_context(
        pgn_text=SAMPLE_PGN,
        payload=payload,
        ply=21,
    )

    assert ctx["ply"] == 21
    assert ctx["move_number"] == 11
    assert ctx["color"] == "White"
    assert ctx["move_played_san"] == "Nxe5"
    assert ctx["critical_moment"] is not None
    assert ctx["critical_moment"].best_move_san == "Bxe5"

    ans = generate_deterministic_move_answer(
        context=ctx,
        user_question="Why is this move a mistake and what pattern did I miss?",
    )

    assert ans.ply == 21
    assert ans.move_number == 11
    assert ans.color == "White"
    assert "11. Nxe5" in ans.formal_question
    assert "11. Bxe5" in ans.answer_markdown
    # Verify Rule F adherence (moves in backticks with numbers)
    assert "`11. Bxe5`" in ans.answer_markdown or "`11... dxe5`" in ans.answer_markdown


def test_api_ask_move_and_append_qa(
    tmp_path: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    test_db = str(tmp_path / "test_move_qa.db")
    monkeypatch.setattr("src.storage.DEFAULT_DB_PATH", test_db)
    monkeypatch.setattr("api.games_db.DEFAULT_DB_PATH", test_db)

    board = chess.Board()
    facts = extract_tactical_facts(board)
    cm = CriticalMoment(
        ply=21,
        move_number=11,
        color="White",
        classification="Mistake",
        move_played_san="Nxe5",
        best_move_san="Bxe5",
        eval_before_cp=120,
        eval_after_cp=-80,
        eval_loss_cp=200,
        pv_san=["Bxe5", "dxe5", "Nxe5"],
        refutation_san=["dxe5", "dxe5"],
        narrative="11. Nxe5 is inaccurate.",
        facts_before_move=facts,
        facts_after_played_move=facts,
        facts_after_best_move=facts,
        facts_at_end_of_pv=facts,
    )
    payload = GameAnalysisPayload(
        white_player="PlayerW",
        black_player="PlayerB",
        user_color="White",
        result="1-0",
        time_control="300+3",
        pgn_moves_summary="Ruy Lopez",
        total_plies=24,
        critical_moments=[cm],
    )

    initial_report = (
        "# 1. Game Overview\n\n"
        "Solid game.\n\n"
        "---\n\n"
        "# 7. Verification Report\n\n"
        "- All checks passed.\n"
    )

    analysis_id = save_analysis(
        pgn_text=SAMPLE_PGN,
        payload=payload,
        report_md=initial_report,
        model_name="test-model",
        db_path=test_db,
    )

    client = TestClient(app)

    # 1. Ask move question for non-existent analysis -> 404
    r_404 = client.post("/api/analysis/999999/ask-move", json={"question": "Why?", "ply": 21})
    assert r_404.status_code == 404

    # 2. Ask move question for valid analysis (offline fallback)
    r_ask = client.post(
        f"/api/analysis/{analysis_id}/ask-move",
        json={
            "question": "Why is move 11 considered a mistake and what pattern should I have seen?",
            "ply": 21,
        },
    )
    assert r_ask.status_code == 200
    data = r_ask.json()
    assert data["ply"] == 21
    assert data["move_number"] == 11
    assert data["color"] == "White"
    assert "formal_question" in data
    assert "answer_markdown" in data
    assert "11. Nxe5" in data["formal_question"]

    # 3. Append QA to review
    r_append = client.post(
        f"/api/analysis/{analysis_id}/append-qa",
        json={
            "formal_question": data["formal_question"],
            "answer_markdown": data["answer_markdown"],
            "move_context": data["move_context"],
            "ply": data["ply"],
        },
    )
    assert r_append.status_code == 200
    append_res = r_append.json()
    assert append_res["ok"] is True
    assert "Follow-up Coaching & Deep Dives" in append_res["section_heading"]
    assert "Follow-up Coaching & Deep Dives" in append_res["report_md"]
    assert "Follow-up Coaching &amp; Deep Dives" in append_res["report_html"]

    # Verify database persistence
    rec = get_analysis_by_id(analysis_id, db_path=test_db)
    assert rec is not None
    assert rec["report_md"] == append_res["report_md"]
    assert "### Q:" in rec["report_md"]
