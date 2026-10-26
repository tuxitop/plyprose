import chess

from src.inspector import (
    extract_tactical_facts,
    inspect_square,
    verify_variation_tool,
)
from src.models import PieceInteraction, TacticalFacts


def test_bishop_e7_attackers_defenders_and_castling_variation():
    """
    Tests the position after:
    1. e4 e5 2. Nf3 d6 3. d4 Nc6 4. Bc4 exd4 5. Nxd4 Nxd4 6. Qxd4 Nf6
    7. Nc3 a6 8. O-O c6 9. e5 dxe5 10. Qxe5+ Be7 11. Rd1 Bd7 12. Re1

    Proves:
    1. The Black bishop on e7 has TWO attackers ('White queen on e5', 'White rook on e1')
    2. The Black bishop on e7 has TWO defenders ('Black queen on d8', 'Black king on e8')
    3. The Black bishop on e7 is absolutely pinned to the king on e8
    4. Playing 12... O-O via verify_variation_tool drops e7 defenders to ONE ('Black queen on d8')
    """
    moves = (
        "1. e4 e5 2. Nf3 d6 3. d4 Nc6 4. Bc4 exd4 5. Nxd4 Nxd4 "
        "6. Qxd4 Nf6 7. Nc3 a6 8. O-O c6 9. e5 dxe5 10. Qxe5+ Be7 "
        "11. Rd1 Bd7 12. Re1"
    )
    board = chess.Board()
    for token in moves.split():
        if token.endswith("."):
            continue
        board.push_san(token)

    # 1. Deterministic tactical fact extraction
    facts: TacticalFacts = extract_tactical_facts(board)
    assert isinstance(facts, TacticalFacts)
    assert facts.move_number == 12
    assert facts.turn == "Black"
    assert facts.is_check is False

    # Find Black bishop on e7
    e7_interactions = [p for p in facts.attacked_or_pinned_pieces if p.square == "e7"]
    assert len(e7_interactions) == 1
    e7_piece: PieceInteraction = e7_interactions[0]

    assert e7_piece.piece == "Black bishop on e7"
    assert e7_piece.is_pinned is True
    assert e7_piece.pinned_to == "e8"

    # Verify TWO attackers
    assert len(e7_piece.attackers) == 2
    assert "White queen on e5" in e7_piece.attackers
    assert "White rook on e1" in e7_piece.attackers
    assert e7_piece.attackers == ["White queen on e5", "White rook on e1"]

    # Verify TWO defenders
    assert len(e7_piece.defenders) == 2
    assert "Black queen on d8" in e7_piece.defenders
    assert "Black king on e8" in e7_piece.defenders
    assert e7_piece.defenders == ["Black queen on d8", "Black king on e8"]

    # 2. Test 12... O-O via verify_variation_tool
    result = verify_variation_tool(facts.fen, ["O-O"])
    assert result["valid"] is True
    assert "resulting_facts" in result

    resulting_facts = result["resulting_facts"]
    e7_after = [p for p in resulting_facts["attacked_or_pinned_pieces"] if p["square"] == "e7"]
    assert len(e7_after) == 1
    e7_piece_after = e7_after[0]

    # Verify e7 drops to ONE defender: 'Black queen on d8'
    assert len(e7_piece_after["defenders"]) == 1
    assert e7_piece_after["defenders"] == ["Black queen on d8"]

    # Verify e7 still has TWO attackers: 'White queen on e5', 'White rook on e1'
    assert len(e7_piece_after["attackers"]) == 2
    assert e7_piece_after["attackers"] == ["White queen on e5", "White rook on e1"]

    # After castling, bishop is no longer pinned to the king
    assert e7_piece_after["is_pinned"] is False
    assert e7_piece_after["pinned_to"] is None


def test_verify_variation_tool_illegal_move():
    """Tests that verify_variation_tool handles invalid/illegal moves properly."""
    fen = "r2qk2r/1p1bbppp/p1p2n2/4Q3/2B5/2N5/PPP2PPP/R1B1R1K1 b kq - 4 12"

    # Queen cannot capture e5 directly through bishop
    res = verify_variation_tool(fen, ["Qxe5"])
    assert res["valid"] is False
    assert res["illegal_move"] == "Qxe5"
    assert "legal_moves_sample" in res
    assert len(res["legal_moves_sample"]) > 0

    # Completely bogus move string
    res_bad = verify_variation_tool(fen, ["Z99#"])
    assert res_bad["valid"] is False
    assert res_bad["illegal_move"] == "Z99#"

    # Invalid FEN
    res_fen = verify_variation_tool("not-a-valid-fen", ["e4"])
    assert res_fen["valid"] is False
    assert "error" in res_fen


def test_hanging_pieces_detection():
    """Tests detection of hanging (attacked and undefended) pieces."""
    # 1. e4 e5 2. Qh5 Nf6 3. Qxe5+
    # Here pawn on e5 was hanging and captured, but let's test a position with an undefended piece
    # Position where black leaves knight undefended: 1. e4 d5 2. exd5 Nf6 3. Bb5+ Bd7 4. Bc4
    # Or simple custom FEN: White queen attacks undefended Black rook on a8
    # Put Black rook on e4 attacked by White pawn on d3, with no defenders
    board = chess.Board("r3k2r/pppppppp/8/8/4r3/3P4/PPP2PPP/R3K2R w KQkq - 0 1")
    facts = extract_tactical_facts(board)
    assert "Black rook on e4" in facts.hanging_pieces


def test_material_and_castling_facts():
    """Tests initial board material count, castling rights, and check status."""
    board = chess.Board()
    facts = extract_tactical_facts(board)
    assert facts.material_count == {"White": 39, "Black": 39}
    assert facts.legal_castling["White_O-O"] is True
    assert facts.legal_castling["White_O-O-O"] is True
    assert facts.legal_castling["Black_O-O"] is True
    assert facts.legal_castling["Black_O-O-O"] is True
    assert facts.is_check is False


def test_inspect_square():
    """Tests inspect_square helper for occupied, empty, and invalid squares."""
    fen = "r2qk2r/1p1bbppp/p1p2n2/4Q3/2B5/2N5/PPP2PPP/R1B1R1K1 b kq - 4 12"

    # Occupied square e7
    res_e7 = inspect_square(fen, "e7")
    assert res_e7["square"] == "e7"
    assert res_e7["piece"] == "Black bishop on e7"
    assert len(res_e7["attackers"]) == 2
    assert len(res_e7["defenders"]) == 2
    assert res_e7["is_pinned"] is True
    assert res_e7["pinned_to"] == "e8"

    # Empty square e4
    res_e4 = inspect_square(fen, "e4")
    assert res_e4["square"] == "e4"
    assert res_e4["piece"] is None

    # Invalid square name
    res_invalid = inspect_square(fen, "z9")
    assert "error" in res_invalid
