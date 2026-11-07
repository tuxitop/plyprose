from __future__ import annotations

import functools
import io
import os
import re
import shutil
from collections.abc import Callable
from typing import Any

import chess
import chess.engine
import chess.pgn

from src.fetcher import extract_game_url
from src.inspector import extract_tactical_facts
from src.models import CriticalMoment, GameAnalysisPayload
from src.openings import detect_opening
from src.tags import extract_deterministic_tags


def _parse_clock_seconds(comment: str) -> float | None:
    """Extracts remaining clock seconds from a PGN comment like [%clk 0:05:04.4]."""
    if not comment:
        return None
    m = re.search(r"\[%clk\s+(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\]", comment)
    if not m:
        return None
    hours = int(m.group(1)) if m.group(1) else 0
    minutes = int(m.group(2))
    seconds = float(m.group(3))
    return hours * 3600 + minutes * 60 + seconds


def _parse_time_control(time_control_str: str | None) -> tuple[float | None, float]:
    """Parses base time seconds and increment seconds from a TimeControl string (e.g. '300+5')."""
    if not time_control_str:
        return None, 0.0
    parts = time_control_str.strip().split("+")
    try:
        base = float(parts[0])
        inc = float(parts[1]) if len(parts) > 1 else 0.0
        return base, inc
    except ValueError:
        return None, 0.0


def _clamped_eval_for_swing(
    score: chess.engine.Score, turn: chess.Color, max_cp: int = 1000
) -> int:
    """
    Returns the evaluation in centipawns from the player's perspective,
    clamped to [-max_cp, max_cp] for swing calculation.
    This prevents artificial 9000-point cliffs when transitioning between
    hopelessly lost positions and deep forced mates.
    """
    if score.is_mate():
        m = score.mate()
        if m is not None:
            val = max_cp if m > 0 else -max_cp
        else:
            val = max_cp
    else:
        cp = score.score()
        raw = cp if cp is not None else 0
        val = max(-max_cp, min(max_cp, raw))

    return val if turn == chess.WHITE else -val


def _compute_loss_and_mate_change(
    score_before: chess.engine.Score,
    score_after: chess.engine.Score,
    turn: chess.Color,
    mate_score: int = 10000,
) -> tuple[int, bool]:
    """
    Computes centipawn loss from the moving player's perspective
    and checks if the moving player experienced a genuine forced mate blunder.
    """
    pov_before = _clamped_eval_for_swing(score_before, turn)
    pov_after = _clamped_eval_for_swing(score_after, turn)

    m_before = score_before.mate()
    m_after = score_after.mate()
    pov_m_before = (
        (m_before if turn == chess.WHITE else -m_before) if m_before is not None else None
    )
    pov_m_after = (m_after if turn == chess.WHITE else -m_after) if m_after is not None else None

    # Calculate centipawn loss:
    # If the player was in a winning forced mate:
    if pov_m_before is not None and pov_m_before > 0:
        if pov_m_after is not None and pov_m_after > 0:
            # Still in winning forced mate; centipawn loss is minimal/zero
            loss_cp = max(0, (pov_m_after - pov_m_before) * 10)
        else:
            # Exited forced mate sequence.
            # Missing an immediate mate (M1-M2) has a high baseline (1000 cp / +10.0 pawns).
            # Deep computer mates (M3+) have a realistic winning baseline (800 cp / +8.0 pawns).
            # If the player stays at +7.9 or +8.0, the centipawn loss is negligible (~10 cp).
            # If the player drops to +4.0, they lost ~400 cp, which is a genuine blunder!
            mate_baseline = 1000 if pov_m_before <= 2 else 800
            loss_cp = max(0, mate_baseline - pov_after)
    else:
        loss_cp = max(0, pov_before - pov_after)

    # 1. Missed mate against opponent:
    # Only considered a forced mate blunder if the player actually threw away the win (dropped to < 200 cp),
    # or missed an obvious mate in 1 or 2.
    is_mate_lost = False
    if pov_m_before is not None and pov_m_before > 0:
        if pov_m_after is None or pov_m_after <= 0:
            if pov_after < 200:
                is_mate_lost = True
            elif pov_m_before <= 2 and pov_after < 500:
                # Missed an obvious mate in 1 or 2
                is_mate_lost = True

    # 2. Allowed mate against moving player:
    # Only considered a blunder if the player was in a playable position (pov_before > -500),
    # not when the player was already completely dead lost (e.g. down a queen/rook).
    is_mate_allowed = False
    if pov_m_after is not None and pov_m_after < 0:
        opp_mate_in = abs(pov_m_after)
        was_already_mated = pov_m_before is not None and pov_m_before < 0
        if not was_already_mated and pov_before > -500:
            if opp_mate_in <= 6 or pov_before >= 0:
                is_mate_allowed = True

    forced_mate_status_changed = is_mate_lost or is_mate_allowed
    return loss_cp, forced_mate_status_changed


def _classify_swing(
    loss_cp: int,
    forced_mate_status_changed: bool,
    pov_before: int = 0,
    pov_after: int = 0,
    had_tactical_motif: bool = False,
) -> str:
    """
    Classifies the move swing based on loss in centipawns and tactical context:
    - Missed Win: moving player had clear winning advantage (>= 200 cp or mate) and threw it away
    - Missed Tactic: tactical motif was available in best move but missed in played move
    - Blunder: >= 300 cp (or forced mate blundered against the player)
    - Mistake: >= 150 cp
    - Inaccuracy: >= 80 cp
    """
    # 1. Missed Win: player was winning (>= +2.0 or forced mate) and dropped to <= +0.5
    if (
        (pov_before >= 200 or (forced_mate_status_changed and pov_before >= 9000))
        and pov_after <= 50
        and loss_cp >= 150
    ):
        return "Missed Win"

    # 2. Any move that genuinely blunders a forced mate against the player
    if forced_mate_status_changed:
        return "Blunder"

    # 3. Missed Tactic: tactical opportunity available in best line but missed
    if had_tactical_motif and 100 <= loss_cp < 300:
        return "Missed Tactic"

    # In completely lost positions (pov_before <= -500 and pov_after <= -500),
    # minor centipawn fluctuations (loss_cp < 300) are endgame noise in dead-lost positions,
    # not genuine inaccuracies or mistakes.
    if pov_before <= -500 and pov_after <= -500 and not forced_mate_status_changed:
        if loss_cp < 300:
            return "Good Move"

    if loss_cp >= 300:
        return "Blunder"
    elif loss_cp >= 150:
        return "Mistake"
    elif loss_cp >= 80:
        return "Inaccuracy"
    return "Inaccuracy"


@functools.lru_cache(maxsize=8)
def get_stockfish_version(stockfish_path: str | None = None) -> str | None:
    """
    Detects the version name of the configured or system Stockfish engine binary.
    Returns e.g. 'Stockfish 19' or None if unavailable.
    """
    resolved = stockfish_path
    if not resolved:
        resolved = os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish")
    if not resolved or not os.path.isfile(resolved) or not os.access(resolved, os.X_OK):
        for candidate in (
            "/usr/sbin/stockfish",
            "/usr/games/stockfish",
            "/usr/local/bin/stockfish",
            "/opt/homebrew/bin/stockfish",
        ):
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                resolved = candidate
                break
    if not resolved or not os.path.isfile(resolved) or not os.access(resolved, os.X_OK):
        return None

    try:
        engine = chess.engine.SimpleEngine.popen_uci(resolved)
        name = engine.id.get("name")
        engine.quit()
        return name
    except Exception:
        return None


def analyze_pgn(
    pgn_str: str,
    stockfish_path: str = "/usr/sbin/stockfish",
    user_color: str = "Both",
    time_per_move: float | None = 0.15,
    depth: int | None = None,
    backward_analysis: bool = True,
    engine: chess.engine.SimpleEngine | None = None,
    swing_threshold_cp: int = 80,
    platform: str | None = None,
    filter_by_user_color: bool = True,
    progress_callback: Callable[[int, int], None] | None = None,
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
        time_per_move: Optional analysis time limit per position in seconds.
        depth: Optional search depth limit per position.
        backward_analysis: If True (default), evaluates moves in reverse (ply N down to 0)
                           to leverage transposition tables and eliminate horizon spikes.
                           If False, evaluates moves forwards (0 to ply N).
        engine: Optional pre-existing SimpleEngine instance. If None,
                launches an engine using stockfish_path.
        swing_threshold_cp: Minimum centipawn loss for a move to be recorded
                as a CriticalMoment (default 80).
        platform: Optional chess platform string (e.g. Chess.com, Lichess).
        filter_by_user_color: Whether to limit critical moment detection to user's moves.
        progress_callback: Optional callback(current, total) reporting progress.

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
    if not opening_val and game.headers.get("ECOUrl"):
        eco_url = game.headers.get("ECOUrl", "")
        m_slug = re.search(r"/openings/([^\"'\s]+)", eco_url)
        if m_slug:
            slug = m_slug.group(1).split("...")[0]
            slug = re.sub(r"-\d+\..*$", "", slug)
            opening_val = slug.replace("-", " ").title()
    if opening_val and eco_val:
        opening_name = f"{eco_val}: {opening_val}"
    elif opening_val:
        opening_name = opening_val
    elif eco_val:
        opening_name = eco_val
    else:
        opening_name = None

    if not opening_name or (eco_val and opening_name == eco_val):
        detected_opening = detect_opening(game)
        if detected_opening:
            opening_name = detected_opening.full_name

    mainline_nodes = list(game.mainline())
    moves = [node.move for node in mainline_nodes]
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
                ply_clocks=[None],
                ply_times_spent=[None],
            )

        limit_kwargs: dict[str, Any] = {}
        if time_per_move is not None and time_per_move > 0:
            limit_kwargs["time"] = max(0.01, float(time_per_move))
        if depth is not None and depth > 0:
            limit_kwargs["depth"] = int(depth)
        if not limit_kwargs:
            limit_kwargs["time"] = 0.15
        limit = chess.engine.Limit(**limit_kwargs)

        # Replay moves to collect board states for all plies (0..total_plies)
        boards: list[chess.Board] = [game.board()]
        curr_b = game.board()
        for node in mainline_nodes:
            curr_b = curr_b.copy()
            curr_b.push(node.move)
            boards.append(curr_b)

        # Configure Stockfish hash table (64MB) so transposition table (TT)
        # carries forward deep tactical refutations and forced mate distances.
        try:
            active_engine.configure({"Hash": 64})
        except Exception:
            pass

        # Pass 1: Position analysis. If backward_analysis is True (default),
        # analyzes from final position down to starting position (Lichess fishnet pattern).
        # Otherwise analyzes in standard forward order (ply 0 up to total_plies).
        engine_infos: dict[int, chess.engine.InfoDict] = {}
        ply_range = range(total_plies, -1, -1) if backward_analysis else range(total_plies + 1)
        for step_idx, ply_idx in enumerate(ply_range, start=1):
            info = active_engine.analyse(boards[ply_idx], limit)
            engine_infos[ply_idx] = info
            if progress_callback is not None:
                try:
                    progress_callback(step_idx, total_plies + 1)
                except Exception:
                    pass

        # Build normalized ply evaluations (clamping non-mate centipawns to [-1000, 1000]
        # matching Lichess/Chess.com standard of +/- 10.0 pawns maximum).
        ply_evals: list[int | None] = []
        for p_idx in range(total_plies + 1):
            score_white = engine_infos[p_idx]["score"].white()
            if score_white.is_mate():
                m = score_white.mate()
                if m is not None and m > 0:
                    val = 10000 - min(100, m)
                elif m is not None and m < 0:
                    val = -10000 + min(100, abs(m))
                else:
                    val = 10000
            else:
                cp = score_white.score()
                val = max(-1000, min(1000, cp if cp is not None else 0))
            ply_evals.append(val)

        base_time, inc_time = _parse_time_control(time_control)
        prev_clock: dict[chess.Color, float | None] = {
            chess.WHITE: base_time,
            chess.BLACK: base_time,
        }
        ply_clocks: list[float | None] = [base_time]
        ply_times_spent: list[float | None] = [None]

        # Pass 2: Forward pass to extract clock times and identify critical swings
        for ply_idx, node in enumerate(mainline_nodes, start=1):
            move = node.move
            board_before = boards[ply_idx - 1]
            board = boards[ply_idx]
            turn = board_before.turn
            color_str = "White" if turn == chess.WHITE else "Black"
            move_num = board_before.fullmove_number
            san_played = board_before.san(move)

            clk = _parse_clock_seconds(node.comment)
            time_spent = None
            turn_prev_clk = prev_clock[turn]
            if clk is not None:
                if turn_prev_clk is not None:
                    time_spent = max(0.0, round(turn_prev_clk + inc_time - clk, 1))
                prev_clock[turn] = clk
            ply_clocks.append(clk)
            ply_times_spent.append(time_spent)

            current_info = engine_infos[ply_idx - 1]
            next_info = engine_infos[ply_idx]
            score_before_white = current_info["score"].white()
            score_after_white = next_info["score"].white()

            # Check if this player's color should be analyzed
            should_analyze_color = (
                not filter_by_user_color
                or norm_user_color == "Both"
                or norm_user_color == color_str
            )

            if should_analyze_color:
                pv_moves = current_info.get("pv", [])
                best_move = pv_moves[0] if pv_moves else None
                is_best_move_played = bool(best_move is not None and best_move == move)

                if is_best_move_played:
                    loss_cp = 0
                    mate_changed = False
                else:
                    loss_cp, mate_changed = _compute_loss_and_mate_change(
                        score_before_white, score_after_white, turn
                    )

                pov_before = _clamped_eval_for_swing(score_before_white, turn)
                pov_after = _clamped_eval_for_swing(score_after_white, turn)

                is_checkmate = board.is_checkmate() or "#" in san_played
                is_negative_swing = not is_best_move_played and (
                    loss_cp >= swing_threshold_cp or mate_changed
                )
                if pov_before <= -500 and pov_after <= -500 and not mate_changed and loss_cp < 300:
                    is_negative_swing = False

                # Check for positive / celebratory critical moves (Checkmate, Brilliant, Great Move)
                is_positive_shot = False
                positive_classification = ""

                if is_checkmate:
                    is_positive_shot = True
                    positive_classification = "Checkmate"
                elif loss_cp <= 10:
                    # Check for brilliant sacrifice: moved piece into attack without equal recapture, keeping decisive advantage
                    if pov_after >= 150:
                        piece_moved = board_before.piece_at(move.from_square)
                        if piece_moved and piece_moved.piece_type in (
                            chess.KNIGHT,
                            chess.BISHOP,
                            chess.ROOK,
                            chess.QUEEN,
                        ):
                            opp_color = not turn
                            is_attacked = board_before.is_attacked_by(opp_color, move.to_square)
                            captured = board_before.piece_at(move.to_square)
                            if is_attacked and (
                                not captured or captured.piece_type < piece_moved.piece_type
                            ):
                                is_positive_shot = True
                                positive_classification = "Brilliant"

                    if not is_positive_shot:
                        # Great move: major turnaround or decisive saving resource under pressure
                        if (
                            pov_before <= -150
                            and (pov_after - pov_before) >= 150
                            and pov_after >= 0
                        ):
                            is_positive_shot = True
                            positive_classification = "Great Move"

                if is_negative_swing or is_positive_shot:
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

                    if is_positive_shot:
                        best_move_san = san_played
                        classification = positive_classification
                    elif is_best_move_played or best_move_san == san_played:
                        best_move_san = san_played
                        classification = "Best Move"
                    else:
                        best_has_pins = any(
                            p.is_pinned for p in facts_after_best_move.attacked_or_pinned_pieces
                        ) or any(p.is_pinned for p in facts_at_end_of_pv.attacked_or_pinned_pieces)
                        played_has_pins = any(
                            p.is_pinned for p in facts_after_played_move.attacked_or_pinned_pieces
                        )

                        best_has_fork = any(
                            len(p.attackers) >= 2
                            for p in facts_after_best_move.attacked_or_pinned_pieces
                        ) or any(
                            len(p.attackers) >= 2
                            for p in facts_at_end_of_pv.attacked_or_pinned_pieces
                        )
                        played_has_fork = any(
                            len(p.attackers) >= 2
                            for p in facts_after_played_move.attacked_or_pinned_pieces
                        )

                        had_tactical_motif = bool(
                            (best_has_pins and not played_has_pins)
                            or (best_has_fork and not played_has_fork)
                            or (
                                facts_after_played_move.hanging_pieces
                                and not facts_after_best_move.hanging_pieces
                            )
                        )

                        classification = _classify_swing(
                            loss_cp=loss_cp,
                            forced_mate_status_changed=mate_changed,
                            pov_before=pov_before,
                            pov_after=pov_after,
                            had_tactical_motif=had_tactical_motif,
                        )

                    # Extract opponent's best refutation continuation after the played move
                    refutation_san: list[str] = []
                    if is_checkmate:
                        pv_san = []
                        refutation_san = []
                    else:
                        ref_moves = next_info.get("pv", [])
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
                        clock_seconds_remaining=clk,
                        time_spent_seconds=time_spent,
                    )
                    critical_moments.append(moment)

            # Advance current_info to next position
            current_info = next_info

        payload = GameAnalysisPayload(
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
            ply_clocks=ply_clocks,
            ply_times_spent=ply_times_spent,
        )
        payload.tags = extract_deterministic_tags(payload)
        return payload

    finally:
        if should_close_engine and active_engine is not None:
            active_engine.quit()


__all__ = ["analyze_pgn", "get_stockfish_version"]
