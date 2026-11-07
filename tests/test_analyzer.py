import json
import os

import pytest

from src.analyzer import (
    _classify_swing,
    analyze_pgn,
    get_stockfish_version,
)
from src.models import GameAnalysisPayload, TacticalFacts

STOCKFISH_PATH = os.environ.get("STOCKFISH_PATH", "/usr/sbin/stockfish")


# -----------------------------------------------------------------------------
# 1. Unit Tests for Classification & Helper Logic
# -----------------------------------------------------------------------------


def test_classify_swing_thresholds():
    assert _classify_swing(loss_cp=80, forced_mate_status_changed=False) == "Inaccuracy"
    assert _classify_swing(loss_cp=120, forced_mate_status_changed=False) == "Inaccuracy"
    assert _classify_swing(loss_cp=150, forced_mate_status_changed=False) == "Mistake"
    assert _classify_swing(loss_cp=250, forced_mate_status_changed=False) == "Mistake"
    assert _classify_swing(loss_cp=300, forced_mate_status_changed=False) == "Blunder"
    assert _classify_swing(loss_cp=500, forced_mate_status_changed=False) == "Blunder"
    # Any forced mate status change against the player is a blunder
    assert _classify_swing(loss_cp=50, forced_mate_status_changed=True) == "Blunder"


def test_classify_swing_missed_win_and_tactic():
    # Missed win: player was winning (pov_before >= 200) and threw it away (pov_after <= 50, loss >= 150)
    assert (
        _classify_swing(
            loss_cp=250,
            forced_mate_status_changed=False,
            pov_before=300,
            pov_after=50,
        )
        == "Missed Win"
    )

    # Missed tactic: had tactical motif in best move and loss >= 100
    assert (
        _classify_swing(
            loss_cp=120,
            forced_mate_status_changed=False,
            pov_before=0,
            pov_after=-120,
            had_tactical_motif=True,
        )
        == "Missed Tactic"
    )


def test_forced_mate_logical_thresholds():
    import chess
    import chess.engine

    from src.analyzer import _compute_loss_and_mate_change

    # Case 1: Player has deep mate in 12, but plays move staying +8.0 pawns ahead (+800 cp).
    # Missing M12 when still winning by +8.0 is NOT a blunder or critical swing!
    s_before = chess.engine.PovScore(chess.engine.Mate(12), chess.WHITE)
    s_after = chess.engine.PovScore(chess.engine.Cp(800), chess.WHITE)
    _loss, mate_blunder = _compute_loss_and_mate_change(
        s_before.white(), s_after.white(), chess.WHITE
    )
    assert mate_blunder is False

    # Case 2: Player has simple mate in 1, but drops to +0.2 pawns (+20 cp).
    # That IS a true missed win!
    s_m1 = chess.engine.PovScore(chess.engine.Mate(1), chess.WHITE)
    s_drawish = chess.engine.PovScore(chess.engine.Cp(20), chess.WHITE)
    _loss_m1, mate_blunder_m1 = _compute_loss_and_mate_change(
        s_m1.white(), s_drawish.white(), chess.WHITE
    )
    assert mate_blunder_m1 is True

    # Case 3: Black is hopelessly lost at -9.94 pawns (-994 cp).
    # Opponent now finds mate in 16. Black was already dead lost; finding M16 is NOT a blunder by Black.
    s_lost = chess.engine.PovScore(chess.engine.Cp(994), chess.WHITE)  # White +994, Black -994
    s_m16 = chess.engine.PovScore(chess.engine.Mate(16), chess.WHITE)  # White mate in 16
    _loss_lost, mate_blunder_lost = _compute_loss_and_mate_change(
        s_lost.white(), s_m16.white(), chess.BLACK
    )
    assert mate_blunder_lost is False

    # Case 4: Equal position (White +0.1) blundering into direct mate in 3.
    # Allowing a short mate from an equal position IS a blunder.
    s_eq = chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE)
    s_mated_in_3 = chess.engine.PovScore(chess.engine.Mate(-3), chess.WHITE)
    _loss_blunder, mate_blunder_blunder = _compute_loss_and_mate_change(
        s_eq.white(), s_mated_in_3.white(), chess.WHITE
    )
    assert mate_blunder_blunder is True

    # Case 5 (User Scenario): Had Mate in 6, played move staying at +7.9 pawns (+790 cp).
    # Centipawn loss is negligible (~10 cp), NOT a blunder or mistake!
    s_m6 = chess.engine.PovScore(chess.engine.Mate(6), chess.WHITE)
    s_79 = chess.engine.PovScore(chess.engine.Cp(790), chess.WHITE)
    loss_79, mate_79 = _compute_loss_and_mate_change(s_m6.white(), s_79.white(), chess.WHITE)
    assert mate_79 is False
    assert loss_79 <= 20  # negligible centipawn loss

    # Case 6 (User Scenario): Had Mate in 6, played move dropping to +4.0 pawns (+400 cp).
    # Dropped 4 pawns (400 cp loss), so this MUST be classified as a Blunder!
    s_40 = chess.engine.PovScore(chess.engine.Cp(400), chess.WHITE)
    loss_40, mate_40 = _compute_loss_and_mate_change(s_m6.white(), s_40.white(), chess.WHITE)
    assert loss_40 >= 300
    assert _classify_swing(loss_cp=loss_40, forced_mate_status_changed=mate_40) == "Blunder"


# -----------------------------------------------------------------------------
# 2. Integration Tests with Stockfish
# -----------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_analyze_pgn_scholar_mate_output():
    pgn_str = """[Event "Scholar's Mate Example"]
[Site "Local"]
[Date "2024.01.01"]
[White "White Player"]
[Black "Black Player"]
[Result "1-0"]
[TimeControl "300+0"]
[ECO "C20"]
[Opening "King Pawn Game"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"""

    payload = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
    )

    assert isinstance(payload, GameAnalysisPayload)
    assert payload.white_player == "White Player"
    assert payload.black_player == "Black Player"
    assert payload.result == "1-0"
    assert payload.time_control == "300+0"
    assert "King Pawn Game" in (payload.opening_name or "")
    assert payload.total_plies == 7
    assert payload.user_color == "Both"
    assert "1. e4 e5" in payload.pgn_moves_summary
    assert payload.ply_evals is not None
    assert len(payload.ply_evals) == 8  # ply 0 through 7
    assert payload.ply_evals[-1] == 10000  # Qxf7# checkmate

    # Ensure valid JSON serialization and deserialization
    json_str = payload.model_dump_json()
    assert isinstance(json_str, str)
    parsed_json = json.loads(json_str)
    assert parsed_json["white_player"] == "White Player"

    # Validate deserialization back to model
    reloaded = GameAnalysisPayload.model_validate_json(json_str)
    assert reloaded.total_plies == 7

    # Black's 3... Nf6 allows 4. Qxf7# checkmate and must be flagged as a Blunder
    black_blunders = [
        m for m in payload.critical_moments if m.color == "Black" and m.move_played_san == "Nf6"
    ]
    assert len(black_blunders) == 1
    blunder = black_blunders[0]

    assert blunder.classification == "Blunder"
    assert blunder.move_number == 3
    assert blunder.ply == 6
    assert blunder.best_move_san in ("Qe7", "g6", "Qf6")
    assert len(blunder.pv_san) > 0
    assert len(blunder.refutation_san) > 0
    assert "Qxf7#" in blunder.refutation_san[0]

    # Verify deterministic TacticalFacts
    assert isinstance(blunder.facts_before_move, TacticalFacts)
    assert isinstance(blunder.facts_after_played_move, TacticalFacts)
    assert isinstance(blunder.facts_after_best_move, TacticalFacts)
    assert isinstance(blunder.facts_at_end_of_pv, TacticalFacts)

    # After 3... Nf6, f7 is attacked and defended only by King
    f7_interactions = [
        p for p in blunder.facts_after_played_move.attacked_or_pinned_pieces if p.square == "f7"
    ]
    assert len(f7_interactions) == 1
    assert any("queen" in a.lower() for a in f7_interactions[0].attackers)
    assert any("bishop" in a.lower() for a in f7_interactions[0].attackers)


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_analyze_pgn_user_color_filtering():
    pgn_str = """[Event "Scholar's Mate Example"]
[White "White Player"]
[Black "Black Player"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"""

    # Analyzing with user_color="White" should exclude Black's blunder
    payload_white = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="White",
        time_per_move=0.03,
    )
    assert payload_white.user_color == "White"
    assert all(m.color == "White" for m in payload_white.critical_moments)

    # Analyzing with user_color="Black" should include Black's blunder
    payload_black = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Black",
        time_per_move=0.03,
    )
    assert payload_black.user_color == "Black"
    assert len(payload_black.critical_moments) >= 1
    assert all(m.color == "Black" for m in payload_black.critical_moments)

    # Analyzing with filter_by_user_color=False includes both sides while tagging user_color
    payload_both = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="White",
        time_per_move=0.03,
        filter_by_user_color=False,
    )
    assert payload_both.user_color == "White"
    assert len(payload_both.critical_moments) >= 1


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_analyze_pgn_fools_mate():
    pgn_str = """[Event "Fool's Mate"]
[White "White Player"]
[Black "Black Player"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1"""

    payload = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
    )

    assert payload.total_plies == 4
    # White 2. g4 is a blunder leading to mate
    g4_blunders = [
        m for m in payload.critical_moments if m.color == "White" and m.move_played_san == "g4"
    ]
    assert len(g4_blunders) == 1
    assert g4_blunders[0].classification == "Blunder"
    assert g4_blunders[0].mate_after is not None


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_analyze_pgn_empty_moves_game():
    pgn_str = """[Event "Empty Game"]
[White "Player1"]
[Black "Player2"]
[Result "*"]

*"""
    payload = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
    )
    assert payload.total_plies == 0
    assert payload.critical_moments == []
    assert payload.pgn_moves_summary == ""


# -----------------------------------------------------------------------------
# 3. Error Handling Tests
# -----------------------------------------------------------------------------


def test_analyze_pgn_invalid_pgn():
    with pytest.raises(ValueError, match="cannot be empty"):
        analyze_pgn("", stockfish_path=STOCKFISH_PATH)

    with pytest.raises(ValueError, match="cannot be empty"):
        analyze_pgn("   ", stockfish_path=STOCKFISH_PATH)


def test_analyze_pgn_missing_stockfish_binary():
    pgn_str = "1. e4 e5 2. Nf3 Nc6"
    with pytest.raises(FileNotFoundError, match="Stockfish binary not found"):
        analyze_pgn(pgn_str, stockfish_path="/nonexistent/path/to/stockfish")


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_best_move_played_never_negative_critical_moment():
    # In an endgame where Black is lost, playing the top engine move (e.g. capturing a knight)
    # must never be flagged as a Blunder, Mistake, or Inaccuracy.
    pgn_str = """[Event "Endgame test"]
[White "White"]
[Black "Black"]
[Result "1-0"]
[SetUp "1"]
[FEN "8/8/8/8/p5P1/5P1K/1kN4P/R7 b - - 4 56"]

56... Kxc2 57. Rxa4 1-0"""

    payload = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
    )

    # Neither 56... Kxc2 nor 57. Rxa4 should be flagged as a negative blunder/mistake/inaccuracy
    for cm in payload.critical_moments:
        if cm.move_played_san in ("Kxc2", "Rxa4"):
            assert cm.classification not in (
                "Blunder",
                "Mistake",
                "Inaccuracy",
                "Missed Win",
                "Missed Tactic",
            )
            assert cm.best_move_san != cm.move_played_san or cm.classification in (
                "Best Move",
                "Great Move",
                "Checkmate",
            )


@pytest.mark.skipif(
    not os.path.exists(STOCKFISH_PATH),
    reason="Stockfish binary not found at default path",
)
def test_analyze_pgn_depth_only_and_time_only():
    pgn_str = """[Event "Depth test"]
[White "Player1"]
[Black "Player2"]
[Result "1-0"]

1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0"""

    # 1. Depth only
    payload_depth = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=None,
        depth=10,
    )
    assert payload_depth.total_plies == 7
    assert len(payload_depth.ply_evals) == 8

    # 2. Time only
    payload_time = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
        depth=None,
    )
    assert payload_time.total_plies == 7

    # 3. Both depth and time
    payload_both = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.05,
        depth=10,
    )
    assert payload_both.total_plies == 7

    # 4. Forward traversal (backward_analysis=False)
    progress_recorded: list[tuple[int, int]] = []
    payload_forward = analyze_pgn(
        pgn_str=pgn_str,
        stockfish_path=STOCKFISH_PATH,
        user_color="Both",
        time_per_move=0.03,
        backward_analysis=False,
        progress_callback=lambda cur, tot: progress_recorded.append((cur, tot)),
    )
    assert payload_forward.total_plies == 7
    assert len(progress_recorded) == 8
    assert progress_recorded[0] == (1, 8)
    assert progress_recorded[-1] == (8, 8)


def test_get_stockfish_version():
    if os.path.exists(STOCKFISH_PATH):
        version = get_stockfish_version(STOCKFISH_PATH)
        assert version is not None
        assert "stockfish" in version.lower()
    else:
        assert get_stockfish_version("/invalid/path/stockfish") is None
