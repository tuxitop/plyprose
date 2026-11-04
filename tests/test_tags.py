from __future__ import annotations

import chess

from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload, PieceInteraction
from src.storage import get_all_analyses, get_analysis_by_id, save_analysis
from src.tags import (
    extract_deterministic_tags,
    normalize_tag,
    resolve_game_tags,
)


def test_allowed_tags_and_normalization():
    # Canonical tags
    assert normalize_tag("tactic:missed-fork") == "tactic:missed-fork"
    assert normalize_tag("opening:early-queen") == "opening:early-queen"
    assert normalize_tag("endgame:passed-pawn-created") == "endgame:passed-pawn-created"

    # Aliases
    assert normalize_tag("missed-pin") == "tactic:missed-pin"
    assert normalize_tag("early_queen") == "opening:early-queen"
    assert normalize_tag("passed-pawn") == "endgame:passed-pawn-created"
    assert normalize_tag("tactic:checkmate") == "tactic:found-mate"

    # Invalid / hallucinated tags
    assert normalize_tag("random-hallucinated-tag-123") is None
    assert normalize_tag("") is None


def test_extract_deterministic_tags_tactics():
    board = chess.Board()
    empty_facts = extract_tactical_facts(board)

    best_with_fork = extract_tactical_facts(board)
    best_with_fork.attacked_or_pinned_pieces.append(
        PieceInteraction(
            square="c7",
            piece="Black pawn on c7",
            attackers=["White knight on d5", "White bishop on f4"],
            defenders=[],
            is_pinned=False,
        )
    )

    played_with_hanging = extract_tactical_facts(board)
    played_with_hanging.hanging_pieces = ["White bishop on e3"]

    moment = CriticalMoment(
        ply=10,
        move_number=5,
        color="White",
        move_played_san="Be3",
        eval_before_cp=100,
        eval_after_cp=-250,
        mate_before=None,
        mate_after=None,
        classification="Missed Tactic",
        best_move_san="Nxc7+",
        pv_san=["Nxc7+", "Kd8", "Nxa8"],
        refutation_san=["d5"],
        facts_before_move=empty_facts,
        facts_after_played_move=played_with_hanging,
        facts_after_best_move=best_with_fork,
        facts_at_end_of_pv=empty_facts,
    )

    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="0-1",
        time_control="300",
        pgn_moves_summary="1. e4 e5",
        total_plies=75,
        critical_moments=[moment],
    )

    tags = extract_deterministic_tags(payload)
    assert "tactic:missed-fork" in tags
    assert "tactic:missed-hanging-piece" in tags
    assert "endgame:king-centralization" in tags


def test_resolve_game_tags():
    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180",
        pgn_moves_summary="1. e4",
        total_plies=20,
        critical_moments=[],
    )

    ai_candidates = ["tactic:missed-pin", "early_queen", "invalid-fake-tag"]
    resolved = resolve_game_tags(ai_candidates, payload)

    assert "tactic:missed-pin" in resolved
    assert "opening:early-queen" in resolved
    assert "invalid-fake-tag" not in resolved


def test_tags_persistence_in_storage(tmp_path):
    test_db = str(tmp_path / "test_tags_storage.db")

    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="White",
        result="1-0",
        time_control="180",
        pgn_moves_summary="1. e4",
        total_plies=20,
        critical_moments=[],
        tags=["tactic:missed-fork", "opening:development-lead"],
    )

    aid = save_analysis(
        pgn_text="1. e4 1-0",
        payload=payload,
        report_md="# Coaching Report",
        model_name="test-model",
        db_path=test_db,
    )

    rec = get_analysis_by_id(aid, db_path=test_db)
    assert rec is not None
    assert rec["tags"] == ["tactic:missed-fork", "opening:development-lead"]

    all_recs = get_all_analyses(db_path=test_db)
    assert len(all_recs) == 1
    assert all_recs[0]["tags"] == ["tactic:missed-fork", "opening:development-lead"]
