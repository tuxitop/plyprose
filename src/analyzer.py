from __future__ import annotations

import io
import os

import chess
import chess.engine
import chess.pgn

from src.fetcher import extract_game_url
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload


def _compute_loss_and_mate_change(
    score_before: chess.engine.Score,
    score_after: chess.engine.Score,
    turn: chess.Color,
    mate_score: int = 10000,
) -> tuple[int, bool]:
    """
    Computes the centipawn loss from the moving player's perspective
    and checks if the moving player changed the forced mate status unfavorably.

    Returns:
        (loss_cp, forced_mate_status_changed)
    """
    sw_before = score_before.score(mate_score=mate_score)
    sw_after = score_after.score(mate_score=mate_score)

    if turn == chess.WHITE:
        pov_before = sw_before
        pov_after = sw_after
    else:
        pov_before = -sw_before
        pov_after = -sw_after

    loss_cp = pov_before - pov_after

    # Mate status change against the moving player:
    # 1. Moving player had a forced mate (>= 9000) and lost it (< 9000).
    # 2. Moving player was not getting mated (> -9000) and now is getting mated (<= -9000).
    is_mate_lost = pov_before >= 9000 and pov_after < 9000
    is_mate_allowed = pov_before > -9000 and pov_after <= -9000
    forced_mate_status_changed = is_mate_lost or is_mate_allowed

    return loss_cp, forced_mate_status_changed


def _classify_swing(loss_cp: int, forced_mate_status_changed: bool) -> str:
    """
    Classifies the move swing based on loss in centipawns:
    - Blunder: >= 300 cp (or forced mate status changed)
    - Mistake: >= 150 cp
    - Inaccuracy: >= 80 cp
    """
    if loss_cp >= 300 or forced_mate_status_changed:
        return "Blunder"
    elif loss_cp >= 150:
        return "Mistake"
    elif loss_cp >= 80:
        return "Inaccuracy"
    return "Inaccuracy"


def analyze_pgn(
    pgn_str: str,
    stockfish_path: str = "/usr/sbin/stockfish",
    user_color: str = "Both",
    time_per_move: float = 0.15,
    engine: chess.engine.SimpleEngine | None = None,
    swing_threshold_cp: int = 80,
    platform: str | None = None,
) -> GameAnalysisPayload:
    """
    Replays a PGN move-by-move, evaluates each position with Stockfish,
    and flags any move where the moving side loses >= swing_threshold_cp
    centipawns (or changes forced mate status) as a CriticalMoment.

    For every CriticalMoment, computes:
    - facts_before_move
    - facts_after_played_move
    - facts_after_best_move
    - facts_at_end_of_pv
    using extract_tactical_facts.

    Args:
        pgn_str: Raw PGN string.
        stockfish_path: Path to the Stockfish engine executable.
        user_color: "White", "Black", or "Both" (case-insensitive).
        time_per_move: Analysis time limit per position in seconds.
        engine: Optional pre-existing SimpleEngine instance. If None,
                launches an engine using stockfish_path.
        swing_threshold_cp: Minimum centipawn loss for a move to be recorded
                as a CriticalMoment (default 80).

    Returns:
        GameAnalysisPayload containing full game metadata and detected CriticalMoments.
    """
    if not isinstance(pgn_str, str) or not pgn_str.strip():
        raise ValueError("PGN string cannot be empty.")

    game = chess.pgn.read_game(io.StringIO(pgn_str.strip()))
    if game is None:
        raise ValueError("Invalid PGN: Unable to parse chess game.")

    norm_user_color = user_color.strip().capitalize()
    if norm_user_color not in ("White", "Black", "Both"):
        norm_user_color = "Both"

    # Extract metadata headers
    white_player = game.headers.get("White", "White")
    black_player = game.headers.get("Black", "Black")
    result = game.headers.get("Result", "*")
    time_control = game.headers.get("TimeControl", "unknown")
    date_val = game.headers.get("Date") or game.headers.get("UTCDate") or None
    white_elo = game.headers.get("WhiteElo") or None
    black_elo = game.headers.get("BlackElo") or None

    # Resolve platform
    plat_resolved = platform
    if not plat_resolved or plat_resolved == "manual":
        site_val = (game.headers.get("Site") or "").lower()
        link_val = (game.headers.get("Link") or "").lower()
        pgn_lower = pgn_str.lower()
        if "chess.com" in site_val or "chess.com" in link_val or "chess.com" in pgn_lower:
            plat_resolved = "Chess.com"
        elif "lichess.org" in site_val or "lichess.org" in link_val or "lichess.org" in pgn_lower:
            plat_resolved = "Lichess"
        else:
            plat_resolved = "Casual / Over-the-Board"
    else:
        plat_low = plat_resolved.lower()
        if plat_low in ("chesscom", "chess.com"):
            plat_resolved = "Chess.com"
        elif plat_low in ("lichess", "lichess.org"):
            plat_resolved = "Lichess"
        else:
            plat_resolved = plat_resolved.capitalize()

    tc_category: str | None = None
    try:
        from api.time_control import classify_time_control

        tc_info = classify_time_control(time_control, plat_resolved)
        tc_category = tc_info.get("label")
    except Exception:
        pass

    game_url = extract_game_url(pgn_str, plat_resolved)

    opening_val = game.headers.get("Opening")
    eco_val = game.headers.get("ECO")
    if opening_val and eco_val:
        opening_name = f"{eco_val}: {opening_val}"
    elif opening_val:
        opening_name = opening_val
    elif eco_val:
        opening_name = eco_val
    else:
        opening_name = None

    moves = list(game.mainline_moves())
    total_plies = len(moves)
    pgn_moves_summary = str(game.mainline()) if moves else ""

    # Manage Stockfish engine lifecycle
    should_close_engine = False
    active_engine = engine

    if active_engine is None:
        if not os.path.isfile(stockfish_path):
            raise FileNotFoundError(f"Stockfish binary not found at '{stockfish_path}'")
        active_engine = chess.engine.SimpleEngine.popen_uci(stockfish_path)
        should_close_engine = True

    try:
        critical_moments: list[CriticalMoment] = []

        if total_plies == 0:
            return GameAnalysisPayload(
                white_player=white_player,
                black_player=black_player,
                user_color=norm_user_color,
                result=result,
                time_control=time_control,
                opening_name=opening_name,
                pgn_moves_summary=pgn_moves_summary,
                total_plies=0,
                critical_moments=[],
                platform=plat_resolved,
                date=date_val,
                white_elo=white_elo,
                black_elo=black_elo,
                time_control_category=tc_category,
                game_url=game_url,
                ply_evals=[20],
            )

        board = game.board()
        limit = chess.engine.Limit(time=max(0.01, time_per_move))

        # Initial evaluation of the starting position
        current_info = active_engine.analyse(board, limit)
        score_0 = current_info["score"].white()
        ply_evals: list[int | None] = [score_0.score(mate_score=10000)]

        for ply_idx, move in enumerate(moves, start=1):
            board_before = board.copy()
            turn = board_before.turn
            color_str = "White" if turn == chess.WHITE else "Black"
            move_num = board_before.fullmove_number
            san_played = board_before.san(move)

            # Push move to reach played position
            board.push(move)
            next_info = active_engine.analyse(board, limit)
            score_before_white = current_info["score"].white()
            score_after_white = next_info["score"].white()
            ply_evals.append(score_after_white.score(mate_score=10000))

            # Check if this player's color should be analyzed
            should_analyze_color = norm_user_color == "Both" or norm_user_color == color_str

            if should_analyze_color:
                loss_cp, mate_changed = _compute_loss_and_mate_change(
                    score_before_white, score_after_white, turn
                )

                if loss_cp >= swing_threshold_cp or mate_changed:
                    classification = _classify_swing(loss_cp, mate_changed)

                    pv_moves = current_info.get("pv", [])
                    if pv_moves:
                        best_move = pv_moves[0]
                        best_move_san = board_before.san(best_move)

                        pv_san: list[str] = []
                        pv_board = board_before.copy()
                        for pv_m in pv_moves[:6]:
                            if pv_m in pv_board.legal_moves:
                                pv_san.append(pv_board.san(pv_m))
                                pv_board.push(pv_m)
                            else:
                                break

                        facts_at_end_of_pv = extract_tactical_facts(pv_board)

                        best_board = board_before.copy()
                        best_board.push(best_move)
                        facts_after_best_move = extract_tactical_facts(best_board)
                    else:
                        best_move_san = san_played
                        pv_san = []
                        facts_after_best_move = extract_tactical_facts(board)
                        facts_at_end_of_pv = extract_tactical_facts(board)

                    facts_before_move = extract_tactical_facts(board_before)
                    facts_after_played_move = extract_tactical_facts(board)

                    # Extract opponent's best refutation continuation after the played move
                    ref_moves = next_info.get("pv", [])
                    refutation_san: list[str] = []
                    if ref_moves:
                        ref_board = board.copy()
                        for ref_m in ref_moves[:6]:
                            if ref_m in ref_board.legal_moves:
                                refutation_san.append(ref_board.san(ref_m))
                                ref_board.push(ref_m)
                            else:
                                break

                    moment = CriticalMoment(
                        ply=ply_idx,
                        move_number=move_num,
                        color=color_str,
                        move_played_san=san_played,
                        eval_before_cp=score_before_white.score(),
                        eval_after_cp=score_after_white.score(),
                        mate_before=score_before_white.mate(),
                        mate_after=score_after_white.mate(),
                        classification=classification,
                        best_move_san=best_move_san,
                        pv_san=pv_san,
                        refutation_san=refutation_san,
                        facts_before_move=facts_before_move,
                        facts_after_played_move=facts_after_played_move,
                        facts_after_best_move=facts_after_best_move,
                        facts_at_end_of_pv=facts_at_end_of_pv,
                    )
                    critical_moments.append(moment)

            # Advance current_info to next position
            current_info = next_info

        return GameAnalysisPayload(
            white_player=white_player,
            black_player=black_player,
            user_color=norm_user_color,
            result=result,
            time_control=time_control,
            opening_name=opening_name,
            pgn_moves_summary=pgn_moves_summary,
            total_plies=total_plies,
            critical_moments=critical_moments,
            platform=plat_resolved,
            date=date_val,
            white_elo=white_elo,
            black_elo=black_elo,
            time_control_category=tc_category,
            game_url=game_url,
            ply_evals=ply_evals,
        )

    finally:
        if should_close_engine and active_engine is not None:
            active_engine.quit()


__all__ = ["analyze_pgn"]
