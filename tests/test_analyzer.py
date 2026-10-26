import json
import os

import pytest

from src.analyzer import (
    _classify_swing,
    analyze_pgn,
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
