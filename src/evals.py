from __future__ import annotations

import io
import re
from typing import Any

import chess.pgn

from src.models import CriticalMoment


def parse_eval_token(token: str) -> int | None:
    """
    Parses a PGN evaluation string token (e.g. '0.25', '-1.50', '#3', '#-2')
    into centipawns from White's perspective. Forced mates are mapped to +/-10000.
    """
    cleaned = token.strip()
    if cleaned.startswith("#"):
        try:
            moves = int(cleaned[1:])
            if moves > 0:
                return 10000 - moves
            elif moves < 0:
                return -10000 - moves
            else:
                return 0
        except ValueError:
            return None
    try:
        pawn_val = float(cleaned)
        return round(pawn_val * 100)
    except ValueError:
        return None


def interpolate_eval_list(scores: list[int | None]) -> list[int | None]:
    """
    Fills in any None gaps in a per-ply evaluation list via linear interpolation.
    Guarantees that index 0 starts with a valid value (defaulting to 20 cp).
    """
    if not scores:
        return []
    total = len(scores)
    result = list(scores)
    first_val = result[0]
    last_known: int = first_val if first_val is not None else 20
    last_idx: int = 0
    result[0] = last_known

    for i in range(total):
        curr = result[i]
        if curr is not None:
            last_known = curr
            last_idx = i
        else:
            next_known: int = last_known
            next_idx: int = i
            for j in range(i + 1, total):
                cand = result[j]
                if cand is not None:
                    next_known = cand
                    next_idx = j
                    break
            span = next_idx - last_idx
            step = (next_known - last_known) / (span if span > 0 else 1)
            result[i] = round(last_known + step * (i - last_idx))

    out: list[int | None] = [x if x is not None else 0 for x in result]
    return out


def extract_ply_evals_from_pgn(pgn_text: str) -> list[int | None] | None:
    """
    Extracts per-ply centipawn evaluations from [%eval ...] comments in a PGN string.
    Supports centipawn values (e.g., [%eval 0.25]) and mate values (e.g., [%eval #3]).
    Returns a list of centipawns from White's perspective indexed by ply (0..total_plies),
    or None if no [%eval ...] comments are found in the game.
    """
    if not pgn_text or "[%eval" not in pgn_text:
        return None

    try:
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if not game:
            return None
    except Exception:
        return None

    eval_regex = re.compile(r"\[%eval\s+([#]?[+-]?\d+(?:\.\d+)?)\]")

    # Starting position
    root_match = eval_regex.search(game.comment or "")
    score_0: int | None = None
    if root_match:
        score_0 = parse_eval_token(root_match.group(1))
    if score_0 is None:
        score_0 = 20

    node: Any = game
    ply_scores: list[int | None] = [score_0]
    eval_count = 1 if root_match is not None else 0

    while node.variations:
        node = node.variation(0)
        comment = node.comment or ""
        m = eval_regex.search(comment)
        if m:
            val = parse_eval_token(m.group(1))
            ply_scores.append(val)
            if val is not None:
                eval_count += 1
        else:
            ply_scores.append(None)

    # Require at least one move evaluation to consider it an engine-annotated PGN
    if eval_count == 0 or (eval_count == 1 and root_match is not None):
        return None

    return interpolate_eval_list(ply_scores)


def interpolate_ply_evals(
    critical_moments: list[CriticalMoment],
    total_plies: int,
    starting_cp: int = 20,
    result_str: str = "*",
) -> list[int | None]:
    """
    Interpolates a continuous per-ply evaluation trajectory (0..total_plies)
    from available critical moments or game outcome when dense Stockfish evaluations are absent.
    """
    total = max(2, total_plies + 1)
    evals: list[int | None] = [None] * total
    evals[0] = starting_cp

    # Final position anchor based on game outcome
    res = result_str.strip()
    if res == "1-0":
        evals[-1] = 1000
    elif res == "0-1":
        evals[-1] = -1000
    elif res in ("1/2-1/2", "draw"):
        evals[-1] = 0

    if critical_moments:
        for cm in critical_moments:
            if 0 <= cm.ply < total:
                cp: int | None = None
                if cm.mate_after is not None:
                    cp = 10000 - cm.mate_after if cm.mate_after > 0 else -10000 - cm.mate_after
                elif cm.eval_after_cp is not None:
                    cp = cm.eval_after_cp
                if cp is not None:
                    evals[cm.ply] = cp

                if cm.ply > 1 and evals[cm.ply - 1] is None:
                    cp_b: int | None = None
                    if cm.mate_before is not None:
                        cp_b = (
                            10000 - cm.mate_before
                            if cm.mate_before > 0
                            else -10000 - cm.mate_before
                        )
                    elif cm.eval_before_cp is not None:
                        cp_b = cm.eval_before_cp
                    if cp_b is not None:
                        evals[cm.ply - 1] = cp_b

    return interpolate_eval_list(evals)


__all__ = [
    "extract_ply_evals_from_pgn",
    "interpolate_eval_list",
    "interpolate_ply_evals",
    "parse_eval_token",
]
