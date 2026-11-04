from __future__ import annotations

import chess

from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload, PieceInteraction
from src.storage import get_all_analyses, get_analysis_by_id, save_analysis
from src.tags import (
    extract_deterministic_tags,
    normalize_tag,
    parse_tags_with_justifications,
    reconcile_move_classifications,
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
        total_plies=20,
        critical_moments=[moment],
    )

    tags = extract_deterministic_tags(payload)
    assert "tactic:missed-fork" in tags
    assert "tactic:hung-piece" in tags


def test_extract_deterministic_tags_positive_and_time():
    board = chess.Board()
    empty_facts = extract_tactical_facts(board)

    mate_moment = CriticalMoment(
        ply=78,
        move_number=39,
        color="Black",
        move_played_san="Re1#",
        eval_before_cp=10000,
        eval_after_cp=10000,
        mate_before=-1,
        mate_after=0,
        classification="Checkmate",
        best_move_san="Re1#",
        pv_san=["Re1#"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
        clock_seconds_remaining=17.7,
        time_spent_seconds=2.7,
    )

    trouble_blunder_moment = CriticalMoment(
        ply=71,
        move_number=36,
        color="White",
        move_played_san="Qd6",
        eval_before_cp=-200,
        eval_after_cp=-800,
        classification="Blunder",
        best_move_san="Qxe5",
        pv_san=["Qxe5"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
        clock_seconds_remaining=25.0,
        time_spent_seconds=35.0,
    )

    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="Both",
        result="0-1",
        time_control="300+5",
        pgn_moves_summary="1. e4 e5 39... Re1#",
        total_plies=78,
        critical_moments=[trouble_blunder_moment, mate_moment],
    )

    tags = extract_deterministic_tags(payload)
    assert "tactic:found-mate" in tags
    assert "time:clutch-play" in tags
    assert "time:trouble-blunder" in tags


def test_parse_tags_with_justifications_and_discarding():
    report_with_justifications = """
# 7. Game Tags & Tactical Patterns

- `tactic:found-mate` (**Checkmate Delivered**): Delivered checkmate with `39... Re1#` on the back rank.
- `tactic:found-fork` (**Fork Executed**): On Move 20... Ne3, you forked White's queen and rook.
- `tactic:missed-fork`:
- `time:clutch-play` (**Clutch Time Scramble**): Converted the attack under 20 seconds on the clock.
- `invalid:nonsense`: Some fake explanation here that is not a real tag.
"""
    justified = parse_tags_with_justifications(report_with_justifications)
    assert "tactic:found-mate" in justified
    assert "tactic:found-fork" in justified
    assert "time:clutch-play" in justified
    assert "tactic:missed-fork" not in justified  # Discarded due to lack of justification
    assert "invalid:nonsense" not in justified  # Discarded because not allowed

    # Test resolving tags with report_md discards ungrounded AI tags
    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="Black",
        result="0-1",
        time_control="300+5",
        pgn_moves_summary="1. e4",
        total_plies=10,
        critical_moments=[],
    )
    resolved = resolve_game_tags(
        ai_tags=["tactic:found-mate", "tactic:missed-fork"],
        payload=payload,
        report_md=report_with_justifications,
    )
    assert "tactic:found-mate" in resolved
    assert "tactic:missed-fork" not in resolved  # Discarded!


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


def test_reconcile_move_classifications_with_coach_verdict():
    board = chess.Board()
    empty_facts = extract_tactical_facts(board)

    cm_unapproved_brilliant = CriticalMoment(
        ply=20,
        move_number=10,
        color="White",
        move_played_san="Nxd5",
        eval_before_cp=200,
        eval_after_cp=350,
        classification="Brilliant",  # Tentative heuristic
        best_move_san="Nxd5",
        pv_san=["Nxd5"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
    )

    cm_approved_great = CriticalMoment(
        ply=40,
        move_number=20,
        color="Black",
        move_played_san="Ne3",
        eval_before_cp=-50,
        eval_after_cp=300,
        classification="Good Move",  # Tentative heuristic
        best_move_san="Ne3",
        pv_san=["Ne3"],
        facts_before_move=empty_facts,
        facts_after_played_move=empty_facts,
        facts_after_best_move=empty_facts,
        facts_at_end_of_pv=empty_facts,
    )

    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="Both",
        result="0-1",
        time_control="300",
        pgn_moves_summary="1. e4",
        total_plies=40,
        critical_moments=[cm_unapproved_brilliant, cm_approved_great],
    )

    report_md = """
# 4. Critical Moments

| Move | Player | Classification | What Happened | Why It Mattered | Tactical / Strategic Context |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `20... Ne3` | Black | Great Move | Discovered knight fork on Q and R | Won the exchange | Tactics verified |
| `10. Nxd5` | White | Good Move | Routine central piece recapture | Maintained advantage | Routine recapture |
"""
    reconcile_move_classifications(payload, report_md)

    # 1. 20... Ne3 is approved and promoted to "Great Move"
    assert cm_approved_great.classification == "Great Move"
    # 2. 10. Nxd5 was NOT approved as Brilliant, so its Brilliant classification was demoted to "Good Move"
    assert cm_unapproved_brilliant.classification == "Good Move"


def test_every_assigned_tag_must_be_explained_by_coach():
    payload = GameAnalysisPayload(
        white_player="Alice",
        black_player="Bob",
        user_color="Both",
        result="0-1",
        time_control="300+5",
        pgn_moves_summary="1. e4 e5 39... Re1#",
        total_plies=78,
        critical_moments=[],
    )

    # The AI coach generated Section 7 explaining exactly 2 tags:
    report_md = """
# 7. Game Tags & Tactical Patterns

- `tactic:found-mate` (**Checkmate Delivered**): Delivered checkmate with `39... Re1#` on the back rank.
- `time:clutch-play` (**Clutch Time Scramble**): Converted the attack with under 20 seconds remaining on the clock.
"""
    resolved = resolve_game_tags(
        ai_tags=["tactic:found-mate", "time:clutch-play", "opening:king-in-center"],
        payload=payload,
        report_md=report_md,
    )

    # Exactly and ONLY the 2 tags explained by the AI coach must be assigned
    assert resolved == ["tactic:found-mate", "time:clutch-play"]
    # Unexplained candidate tag "opening:king-in-center" was not explained and therefore DISCARDED
    assert "opening:king-in-center" not in resolved
