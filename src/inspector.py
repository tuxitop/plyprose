from __future__ import annotations

import chess

from src.models import PieceInteraction, TacticalFacts

PIECE_VALUES: dict[chess.PieceType, int] = {
    chess.PAWN: 1,
    chess.KNIGHT: 3,
    chess.BISHOP: 3,
    chess.ROOK: 5,
    chess.QUEEN: 9,
    chess.KING: 0,
}

SORT_ORDER: dict[chess.PieceType, int] = {
    chess.QUEEN: 0,
    chess.ROOK: 1,
    chess.BISHOP: 2,
    chess.KNIGHT: 3,
    chess.PAWN: 4,
    chess.KING: 5,
}


def format_piece_description(piece: chess.Piece, square: chess.Square) -> str:
    """Formats piece with color, name, and square, e.g. 'Black bishop on e7'."""
    color_str = "White" if piece.color == chess.WHITE else "Black"
    piece_name = chess.piece_name(piece.piece_type)
    sq_name = chess.square_name(square)
    return f"{color_str} {piece_name} on {sq_name}"


def get_attackers_and_defenders(
    board: chess.Board,
    target_sq: chess.Square,
    target_color: chess.Color,
) -> tuple[list[str], list[str]]:
    """
    Finds all attackers (opposite color) and defenders (same color) of target_sq.
    Accurately accounts for direct attacks as well as battery/X-ray attacks along
    ranks, files, and diagonals through friendly sliding pieces.
    """
    opp_color = not target_color
    attackers: list[tuple[chess.Square, chess.Piece]] = []
    defenders: list[tuple[chess.Square, chess.Piece]] = []

    for sq, piece in board.piece_map().items():
        if sq == target_sq:
            continue

        is_attacker_cand = piece.color == opp_color
        is_defender_cand = piece.color == target_color

        # 1. Non-sliding pieces (Pawns, Knights, Kings)
        if piece.piece_type in (chess.PAWN, chess.KNIGHT, chess.KING):
            if target_sq in board.attacks(sq):
                if is_attacker_cand:
                    attackers.append((sq, piece))
                elif is_defender_cand:
                    defenders.append((sq, piece))

        # 2. Sliding pieces (Rooks, Bishops, Queens)
        elif piece.piece_type in (chess.ROOK, chess.BISHOP, chess.QUEEN):
            rank_diff = chess.square_rank(target_sq) - chess.square_rank(sq)
            file_diff = chess.square_file(target_sq) - chess.square_file(sq)

            is_rank_or_file = rank_diff == 0 or file_diff == 0
            is_diagonal = abs(rank_diff) == abs(file_diff)

            can_move_along_ray = False
            if piece.piece_type == chess.ROOK and is_rank_or_file:
                can_move_along_ray = True
            elif piece.piece_type == chess.BISHOP and is_diagonal:
                can_move_along_ray = True
            elif piece.piece_type == chess.QUEEN and (is_rank_or_file or is_diagonal):
                can_move_along_ray = True

            if can_move_along_ray:
                between_sqs = chess.between(sq, target_sq)
                blocked = False
                for b_sq in chess.SquareSet(between_sqs):
                    b_piece = board.piece_at(b_sq)
                    if b_piece is not None:
                        # An opposing piece blocks the ray
                        if b_piece.color != piece.color:
                            blocked = True
                            break
                        # A friendly piece only preserves the attack if it also slides along this ray (battery)
                        b_can_slide = False
                        if is_rank_or_file and b_piece.piece_type in (chess.ROOK, chess.QUEEN):
                            b_can_slide = True
                        elif is_diagonal and b_piece.piece_type in (chess.BISHOP, chess.QUEEN):
                            b_can_slide = True

                        if not b_can_slide:
                            blocked = True
                            break

                if not blocked:
                    if is_attacker_cand:
                        attackers.append((sq, piece))
                    elif is_defender_cand:
                        defenders.append((sq, piece))

    # Deterministic sorting: by piece type hierarchy (Queen, Rook, Bishop, Knight, Pawn, King), then square
    attackers.sort(key=lambda item: (SORT_ORDER[item[1].piece_type], item[0]))
    defenders.sort(key=lambda item: (SORT_ORDER[item[1].piece_type], item[0]))

    formatted_attackers = [format_piece_description(p, sq) for sq, p in attackers]
    formatted_defenders = [format_piece_description(p, sq) for sq, p in defenders]

    return formatted_attackers, formatted_defenders


def extract_tactical_facts(board: chess.Board) -> TacticalFacts:
    """
    Deterministically computes spatial, tactical, material, and geometric facts
    from a chess.Board instance.
    """
    turn = "White" if board.turn == chess.WHITE else "Black"
    move_number = board.fullmove_number
    is_check = board.is_check()

    legal_castling: dict[str, bool] = {
        "K": bool(board.has_kingside_castling_rights(chess.WHITE)),
        "Q": bool(board.has_queenside_castling_rights(chess.WHITE)),
        "k": bool(board.has_kingside_castling_rights(chess.BLACK)),
        "q": bool(board.has_queenside_castling_rights(chess.BLACK)),
        "White_O-O": bool(board.has_kingside_castling_rights(chess.WHITE)),
        "White_O-O-O": bool(board.has_queenside_castling_rights(chess.WHITE)),
        "Black_O-O": bool(board.has_kingside_castling_rights(chess.BLACK)),
        "Black_O-O-O": bool(board.has_queenside_castling_rights(chess.BLACK)),
        "White kingside": bool(board.has_kingside_castling_rights(chess.WHITE)),
        "White queenside": bool(board.has_queenside_castling_rights(chess.WHITE)),
        "Black kingside": bool(board.has_kingside_castling_rights(chess.BLACK)),
        "Black queenside": bool(board.has_queenside_castling_rights(chess.BLACK)),
    }

    w_mat = sum(
        PIECE_VALUES[p.piece_type] for p in board.piece_map().values() if p.color == chess.WHITE
    )
    b_mat = sum(
        PIECE_VALUES[p.piece_type] for p in board.piece_map().values() if p.color == chess.BLACK
    )
    material_count = {"White": w_mat, "Black": b_mat}

    white_pieces: list[tuple[int, int, str]] = []
    black_pieces: list[tuple[int, int, str]] = []
    attacked_or_pinned_pieces: list[PieceInteraction] = []
    hanging_pieces: list[str] = []

    for sq, piece in sorted(board.piece_map().items(), key=lambda item: item[0]):
        sq_name = chess.square_name(sq)
        piece_desc = format_piece_description(piece, sq)
        symbol = piece.symbol().upper()
        placement_str = f"{symbol}{sq_name}"

        if piece.color == chess.WHITE:
            white_pieces.append((SORT_ORDER[piece.piece_type], sq, placement_str))
        else:
            black_pieces.append((SORT_ORDER[piece.piece_type], sq, placement_str))

        attackers, defenders = get_attackers_and_defenders(board, sq, piece.color)
        is_pinned = board.is_pinned(piece.color, sq)
        king_sq = board.king(piece.color)
        pinned_to = chess.square_name(king_sq) if (is_pinned and king_sq is not None) else None

        if len(attackers) > 0 and len(defenders) == 0:
            hanging_pieces.append(piece_desc)

        if len(attackers) > 0 or is_pinned:
            attacked_or_pinned_pieces.append(
                PieceInteraction(
                    square=sq_name,
                    piece=piece_desc,
                    attackers=attackers,
                    defenders=defenders,
                    is_pinned=is_pinned,
                    pinned_to=pinned_to,
                )
            )

    white_pieces.sort(key=lambda x: (x[0], x[1]))
    black_pieces.sort(key=lambda x: (x[0], x[1]))

    piece_placement = {
        "White": [x[2] for x in white_pieces],
        "Black": [x[2] for x in black_pieces],
    }

    attacked_or_pinned_pieces.sort(key=lambda x: x.square)
    hanging_pieces.sort()

    return TacticalFacts(
        fen=board.fen(),
        turn=turn,
        move_number=move_number,
        is_check=is_check,
        legal_castling=legal_castling,
        material_count=material_count,
        piece_placement=piece_placement,
        attacked_or_pinned_pieces=attacked_or_pinned_pieces,
        hanging_pieces=hanging_pieces,
    )


def verify_variation_tool(fen: str, san_moves: list[str]) -> dict:
    """
    Validates a sequence of chess moves from a given board position (FEN).

    Verifies whether each move in san_moves is legal in turn. If all moves are legal,
    extracts and returns the deterministic tactical facts (attackers, defenders,
    pins, material count, hanging pieces) of the resulting final position.
    If any move is illegal, stops immediately and returns details about the illegal move
    along with sample legal moves in that position.

    Args:
        fen: The FEN string of the starting chess board position.
        san_moves: A list of moves in Standard Algebraic Notation (SAN, e.g. ["e4", "e5", "Nf3"])
                   to be executed sequentially from the starting position.

    Returns:
        A dictionary containing:
        - "valid" (bool): True if all moves in the variation were legal, False otherwise.
        - "resulting_facts" (dict, optional): Tactical facts of the resulting position if valid.
        - "illegal_move" (str, optional): The move string that failed validation if invalid.
        - "legal_moves_sample" (list[str], optional): Sample of legal candidate moves in the position.
        - "error" (str, optional): Error description if the FEN was invalid.
    """
    try:
        board = chess.Board(fen)
    except Exception as e:
        return {"valid": False, "error": f"Invalid FEN: {e}"}

    for move_str in san_moves:
        parsed_move = None
        try:
            parsed_move = board.parse_san(move_str)
        except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError):
            try:
                uci_move = board.parse_uci(move_str)
                if uci_move in board.legal_moves:
                    parsed_move = uci_move
            except (chess.IllegalMoveError, chess.InvalidMoveError, ValueError):
                pass

        if parsed_move is None or parsed_move not in board.legal_moves:
            sample = [board.san(m) for m in list(board.legal_moves)[:10]]
            return {
                "valid": False,
                "illegal_move": move_str,
                "legal_moves_sample": sample,
            }

        board.push(parsed_move)

    return {
        "valid": True,
        "resulting_facts": extract_tactical_facts(board).model_dump(),
    }


def inspect_square(board_or_fen: chess.Board | str, square_name: str) -> dict:
    """
    Inspects a specific square on the board, returning piece info,
    attackers, defenders, and pin status.
    """
    if isinstance(board_or_fen, str):
        try:
            board = chess.Board(board_or_fen)
        except Exception as e:
            return {"error": f"Invalid FEN: {e}"}
    else:
        board = board_or_fen

    try:
        sq = chess.parse_square(square_name.lower())
    except ValueError:
        return {"error": f"Invalid square name: {square_name}"}

    piece = board.piece_at(sq)
    if piece is None:
        white_attackers, _ = get_attackers_and_defenders(board, sq, chess.BLACK)
        black_attackers, _ = get_attackers_and_defenders(board, sq, chess.WHITE)
        return {
            "square": square_name.lower(),
            "piece": None,
            "white_attackers": white_attackers,
            "black_attackers": black_attackers,
            "is_pinned": False,
            "pinned_to": None,
            "is_hanging": False,
        }

    attackers, defenders = get_attackers_and_defenders(board, sq, piece.color)
    is_pinned = board.is_pinned(piece.color, sq)
    king_sq = board.king(piece.color)
    pinned_to = chess.square_name(king_sq) if (is_pinned and king_sq is not None) else None

    return {
        "square": square_name.lower(),
        "piece": format_piece_description(piece, sq),
        "attackers": attackers,
        "defenders": defenders,
        "is_pinned": is_pinned,
        "pinned_to": pinned_to,
        "is_hanging": len(attackers) > 0 and len(defenders) == 0,
    }


__all__ = [
    "extract_tactical_facts",
    "format_piece_description",
    "get_attackers_and_defenders",
    "inspect_square",
    "verify_variation_tool",
]
