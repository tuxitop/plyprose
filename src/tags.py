"""
Standardized Chess Coaching Taxonomy and Ground-Truth Tagging Service.
Provides a deterministic vocabulary for opening, tactical, strategic, and endgame patterns
to guarantee cross-model consistency and zero hallucination.
"""

from __future__ import annotations

import io
import re
from typing import TYPE_CHECKING

import chess
import chess.pgn

if TYPE_CHECKING:
    from src.models import GameAnalysisPayload

# Comprehensive Standardized Taxonomy (Slug -> Human Readable Label)
ALLOWED_TAGS: dict[str, str] = {
    # ── Tactics: Missed Opportunities ─────────────────────────────────────────
    "tactic:missed-fork": "Missed Fork",
    "tactic:missed-pin": "Missed Pin",
    "tactic:missed-skewer": "Missed Skewer",
    "tactic:missed-discovery": "Missed Discovery",
    "tactic:missed-mate": "Missed Mate",
    "tactic:missed-win": "Missed Win",
    "tactic:missed-tactic": "Missed Tactic",
    "tactic:missed-hanging-piece": "Missed Free Piece",
    "tactic:missed-back-rank": "Missed Back-Rank",
    "tactic:missed-deflection": "Missed Deflection",
    "tactic:missed-zwischenzug": "Missed Zwischenzug",
    # ── Tactics: Blunders & Hanging Pieces ────────────────────────────────────
    "tactic:hung-piece": "Hung Piece",
    "tactic:blundered-piece": "Hung Piece",
    # ── Tactics: Found & Executed ─────────────────────────────────────────────
    "tactic:found-fork": "Fork",
    "tactic:found-pin": "Pin",
    "tactic:found-skewer": "Skewer",
    "tactic:found-discovery": "Discovered Attack",
    "tactic:found-mate": "Checkmate",
    "tactic:found-sacrifice": "Sacrifice",
    "tactic:hanging-piece-punished": "Free Piece Won",
    "tactic:back-rank-punished": "Back-Rank Mate",
    # ── Time Management ───────────────────────────────────────────────────────
    "time:clutch-play": "Clutch Play",
    "time:trouble-blunder": "Time Blunder",
    "time:rushed-blunder": "Rushed Blunder",
    "time:time-advantage": "Clock Lead",
    "time:time-sink": "Time Sink",
    # ── Opening & Early Development ──────────────────────────────────────────
    "opening:development-lead": "Dev Lead",
    "opening:development-lag": "Dev Lag",
    "opening:early-queen": "Early Queen",
    "opening:king-in-center": "King in Center",
    "opening:failed-to-castle": "Castling Neglected",
    "opening:pawn-overextension": "Pawn Overextension",
    "opening:wasted-tempo": "Wasted Tempo",
    "opening:center-control": "Center Control",
    # ── Middlegame Strategy & Positional ──────────────────────────────────────
    "strategy:piece-coordination": "Piece Coordination",
    "strategy:outpost-control": "Outpost Dominance",
    "strategy:open-file-control": "Open File",
    "strategy:weak-squares": "Weak Squares",
    "strategy:isolated-pawn": "Isolated Pawn",
    "strategy:doubled-pawns": "Compromised Pawns",
    "strategy:king-safety-risk": "King Safety",
    "strategy:pawn-storm": "Pawn Storm",
    "strategy:passive-defense": "Passive Defense",
    "strategy:overextended-attack": "Overextended Attack",
    # ── Endgame ───────────────────────────────────────────────────────────────
    "endgame:passed-pawn-created": "Passed Pawn",
    "endgame:passed-pawn-missed": "Allowed Passed Pawn",
    "endgame:active-rook": "Active Rook",
    "endgame:passive-rook": "Passive Rook",
    "endgame:king-centralization": "Active King",
    "endgame:pawn-race": "Pawn Race",
    "endgame:opposition": "Opposition",
    "endgame:technical-conversion": "Smooth Conversion",
    "endgame:stalemate-trap": "Stalemate Resource",
    # ── General & Practical Play ──────────────────────────────────────────────
    "general:time-trouble": "Time Trouble",
    "general:resilient-defense": "Resilient Defense",
    "general:comeback-win": "Comeback",
    "general:missed-simplification": "Missed Simplification",
}

# Aliases to normalize variations across different LLM outputs
TAG_ALIASES: dict[str, str] = {
    # Tactics aliases
    "missed-fork": "tactic:missed-fork",
    "missed-pin": "tactic:missed-pin",
    "missed-skewer": "tactic:missed-skewer",
    "missed-discovery": "tactic:missed-discovery",
    "missed-mate": "tactic:missed-mate",
    "missed-checkmate": "tactic:missed-mate",
    "missed-win": "tactic:missed-win",
    "missed-tactic": "tactic:missed-tactic",
    "missed-hanging-piece": "tactic:missed-hanging-piece",
    "missed-free-piece": "tactic:missed-hanging-piece",
    "hung-piece": "tactic:hung-piece",
    "hanged-piece": "tactic:hung-piece",
    "hanging-piece": "tactic:hung-piece",
    "left-piece-hanging": "tactic:hung-piece",
    "blundered-piece": "tactic:hung-piece",
    "captured-free-piece": "tactic:hanging-piece-punished",
    "free-piece-captured": "tactic:hanging-piece-punished",
    "back-rank": "tactic:missed-back-rank",
    "back-rank-weakness": "tactic:missed-back-rank",
    "fork": "tactic:found-fork",
    "pin": "tactic:found-pin",
    "skewer": "tactic:found-skewer",
    "checkmate": "tactic:found-mate",
    "sacrifice": "tactic:found-sacrifice",
    "brilliant-sacrifice": "tactic:found-sacrifice",
    # Time aliases
    "clutch-play": "time:clutch-play",
    "clutch-conversion": "time:clutch-play",
    "time-scramble": "time:clutch-play",
    "trouble-blunder": "time:trouble-blunder",
    "time-blunder": "time:trouble-blunder",
    "rushed-move": "time:rushed-blunder",
    "rushed-blunder": "time:rushed-blunder",
    "time-advantage": "time:time-advantage",
    "clock-advantage": "time:time-advantage",
    "clock-lead": "time:time-advantage",
    "time-sink": "time:time-sink",
    # Opening aliases
    "early-queen": "opening:early-queen",
    "premature-queen": "opening:early-queen",
    "development-lead": "opening:development-lead",
    "development-lag": "opening:development-lag",
    "poor-development": "opening:development-lag",
    "king-in-center": "opening:king-in-center",
    "uncastled-king": "opening:king-in-center",
    "failed-to-castle": "opening:failed-to-castle",
    "pawn-overextension": "opening:pawn-overextension",
    "center-control": "opening:center-control",
    # Strategy aliases
    "weak-squares": "strategy:weak-squares",
    "isolated-pawn": "strategy:isolated-pawn",
    "doubled-pawns": "strategy:doubled-pawns",
    "king-safety": "strategy:king-safety-risk",
    "passive-play": "strategy:passive-defense",
    # Endgame aliases
    "passed-pawn": "endgame:passed-pawn-created",
    "king-activity": "endgame:king-centralization",
    "active-rook": "endgame:active-rook",
    "passive-rook": "endgame:passive-rook",
    "pawn-race": "endgame:pawn-race",
}


def normalize_tag(raw_tag: str) -> str | None:
    """
    Cleans, normalizes, and maps any tag candidate to the canonical taxonomy slug.
    Returns None if the tag is unknown or unsupported.
    """
    if not raw_tag or not isinstance(raw_tag, str):
        return None

    cleaned = raw_tag.strip().lower()
    cleaned = re.sub(r"[\s_]+", "-", cleaned)
    cleaned = re.sub(r"[^\w\-:]", "", cleaned)

    if cleaned in ALLOWED_TAGS:
        return cleaned

    # Check aliases with or without namespace prefix
    if cleaned in TAG_ALIASES:
        return TAG_ALIASES[cleaned]

    # Try matching without existing namespace if any
    if ":" in cleaned:
        _, sub = cleaned.split(":", 1)
        if sub in TAG_ALIASES:
            return TAG_ALIASES[sub]
        for key in ALLOWED_TAGS:
            if key.endswith(f":{sub}"):
                return key

    return None


POSITIVE_TAGS: set[str] = {
    # Tactics (Found)
    "tactic:found-mate",
    "tactic:found-sacrifice",
    "tactic:found-fork",
    "tactic:found-pin",
    "tactic:found-skewer",
    "tactic:found-discovery",
    "tactic:hanging-piece-punished",
    "tactic:back-rank-punished",
    # Time Management
    "time:clutch-play",
    "time:time-advantage",
    # Opening
    "opening:development-lead",
    "opening:center-control",
    # Strategy
    "strategy:piece-coordination",
    "strategy:outpost-control",
    "strategy:open-file-control",
    # Endgame
    "endgame:passed-pawn-created",
    "endgame:active-rook",
    "endgame:king-centralization",
    "endgame:opposition",
    "endgame:technical-conversion",
    "endgame:stalemate-trap",
    # General
    "general:comeback-win",
    "general:resilient-defense",
}


def is_positive_tag(tag: str) -> bool:
    """Returns True if the given tag represents an achievement or positive pattern."""
    norm = normalize_tag(tag)
    return norm in POSITIVE_TAGS if norm else False


def sort_tags_negative_first(tags: list[str]) -> list[str]:
    """
    Sorts a list of tags so that negative (areas to improve) tags come first,
    followed by positive (achievements/strengths) tags.
    """
    negatives: list[str] = []
    positives: list[str] = []
    for t in tags:
        norm = normalize_tag(t) or t
        if is_positive_tag(norm):
            positives.append(norm)
        else:
            negatives.append(norm)
    return negatives + positives


def extract_deterministic_tags(payload: GameAnalysisPayload) -> list[str]:
    """
    Deterministically computes grounded tags directly from python-chess tactical facts,
    board positions, clock data, and Stockfish swing evaluations, completely immune to LLM hallucination.
    Populates `cm.tags` on each CriticalMoment and returns the filtered game-level tags for the coached player.
    """
    user_col = (payload.user_color or "").strip().lower()
    game_tags: set[str] = set()

    # 1. Critical moments tactical analysis
    for cm in payload.critical_moments:
        move_tags: set[str] = set()
        cls_lower = (cm.classification or "").lower()

        # Missed win / Missed mate
        if cm.mate_before is not None and cm.mate_after is None:
            move_tags.add("tactic:missed-mate")
        elif "missed win" in cls_lower:
            move_tags.add("tactic:missed-win")

        # Positive critical moments: Checkmate, Brilliant sacrifice
        if "checkmate" in cls_lower or "#" in cm.move_played_san:
            move_tags.add("tactic:found-mate")
        if "brilliant" in cls_lower:
            move_tags.add("tactic:found-sacrifice")

        # Tactical motifs in best move that were missed in played move
        best_facts = cm.facts_after_best_move
        pv_end_facts = cm.facts_at_end_of_pv
        played_facts = cm.facts_after_played_move

        # Pins
        best_has_pins = any(p.is_pinned for p in best_facts.attacked_or_pinned_pieces) or any(
            p.is_pinned for p in pv_end_facts.attacked_or_pinned_pieces
        )
        played_has_pins = any(p.is_pinned for p in played_facts.attacked_or_pinned_pieces)
        if best_has_pins and not played_has_pins:
            move_tags.add("tactic:missed-pin")
        elif played_has_pins and cls_lower in ("great move", "brilliant", "checkmate", "best move"):
            move_tags.add("tactic:found-pin")

        # Double attacks / Forks
        best_has_fork = any(
            len(p.attackers) >= 2 for p in best_facts.attacked_or_pinned_pieces
        ) or any(len(p.attackers) >= 2 for p in pv_end_facts.attacked_or_pinned_pieces)
        played_has_fork = any(len(p.attackers) >= 2 for p in played_facts.attacked_or_pinned_pieces)
        if best_has_fork and not played_has_fork:
            move_tags.add("tactic:missed-fork")
        elif played_has_fork and cls_lower in ("great move", "brilliant", "checkmate", "best move"):
            move_tags.add("tactic:found-fork")

        # Hanging pieces: distinguish between hanging your own piece vs missing opponent's free piece
        own_hanging = any(
            p.lower().startswith(cm.color.lower()) for p in played_facts.hanging_pieces
        )
        if own_hanging and any(
            w in cls_lower for w in ("blunder", "mistake", "inaccuracy", "miss")
        ):
            move_tags.add("tactic:hung-piece")

        opp_color_str = "Black" if cm.color.lower() == "white" else "White"
        opp_hanging_before = any(
            p.lower().startswith(opp_color_str.lower()) for p in cm.facts_before_move.hanging_pieces
        )
        if opp_hanging_before:
            if any(w in cls_lower for w in ("blunder", "mistake", "inaccuracy", "miss")):
                move_tags.add("tactic:missed-hanging-piece")
            elif cls_lower in ("great move", "brilliant", "checkmate", "best move"):
                move_tags.add("tactic:hanging-piece-punished")

        # Check early opening mistakes (castling rights surrendered)
        if cm.move_number <= 10:
            if not any(played_facts.legal_castling.values()) and any(
                cm.facts_before_move.legal_castling.values()
            ):
                move_tags.add("opening:king-in-center")

        # Time pressure blunder (<= 30s)
        if (
            cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining <= 30.0
            and any(w in cls_lower for w in ("blunder", "mistake"))
        ):
            move_tags.add("time:trouble-blunder")

        # Rushed move blunder (moved in < 3s despite having ample time > 60s)
        if (
            cm.time_spent_seconds is not None
            and cm.time_spent_seconds < 3.0
            and cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining > 60.0
            and any(w in cls_lower for w in ("blunder", "mistake", "inaccuracy"))
        ):
            move_tags.add("time:rushed-blunder")

        # Time sink (spent >= 45s while clock > 60s, without brilliant or great move)
        if (
            cm.time_spent_seconds is not None
            and cm.time_spent_seconds >= 45.0
            and cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining > 60.0
            and cls_lower not in ("great move", "brilliant", "checkmate")
        ):
            move_tags.add("time:time-sink")

        # Clutch time scramble / conversion
        if (
            cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining <= 30.0
            and any(w in cls_lower for w in ("checkmate", "brilliant", "great move"))
        ):
            move_tags.add("time:clutch-play")

        # Store move-level tags on CriticalMoment
        cm.tags = sorted(move_tags)

        # Perspective filter for game-level tags:
        # Only attribute to student if move matches user_color (or if user_color is unspecified/both)
        if not user_col or user_col not in ("white", "black") or cm.color.lower() == user_col:
            game_tags.update(move_tags)

    # 2. Checkmate delivered at the end of the game
    if (
        payload.result in ("1-0", "0-1")
        and payload.pgn_moves_summary
        and "#" in payload.pgn_moves_summary.split()[-1]
    ):
        if user_col == "white" and payload.result == "1-0":
            game_tags.add("tactic:found-mate")
        elif user_col == "black" and payload.result == "0-1":
            game_tags.add("tactic:found-mate")
        elif user_col not in ("white", "black"):
            game_tags.add("tactic:found-mate")

    # 3. Comeback turnaround
    if payload.ply_evals and len(payload.ply_evals) >= 10:
        if payload.result == "1-0":
            if (user_col == "white" or user_col not in ("white", "black")) and any(
                e is not None and e <= -200 for e in payload.ply_evals
            ):
                game_tags.add("general:comeback-win")
        elif payload.result == "0-1":
            if (user_col == "black" or user_col not in ("white", "black")) and any(
                e is not None and e >= 200 for e in payload.ply_evals
            ):
                game_tags.add("general:comeback-win")

    # 4. Accurate Endgame King Centralization check
    if payload.pgn_moves_summary:
        try:
            game = chess.pgn.read_game(io.StringIO(payload.pgn_moves_summary))
            if game:
                board = game.board()
                white_central_plies = 0
                black_central_plies = 0
                for ply_idx, move in enumerate(game.mainline_moves(), start=1):
                    board.push(move)
                    white_queens = len(board.pieces(chess.QUEEN, chess.WHITE))
                    black_queens = len(board.pieces(chess.QUEEN, chess.BLACK))
                    is_endgame = (
                        (white_queens == 0 and black_queens == 0)
                        or len(board.piece_map()) <= 12
                        or ply_idx >= 60
                    )
                    if is_endgame:
                        wk = board.king(chess.WHITE)
                        bk = board.king(chess.BLACK)
                        if (
                            wk is not None
                            and chess.square_file(wk) in (2, 3, 4, 5)
                            and chess.square_rank(wk) in (2, 3, 4, 5)
                        ):
                            white_central_plies += 1
                        if (
                            bk is not None
                            and chess.square_file(bk) in (2, 3, 4, 5)
                            and chess.square_rank(bk) in (2, 3, 4, 5)
                        ):
                            black_central_plies += 1

                if user_col == "white" and white_central_plies >= 4:
                    game_tags.add("endgame:king-centralization")
                elif user_col == "black" and black_central_plies >= 4:
                    game_tags.add("endgame:king-centralization")
                elif user_col not in ("white", "black") and (
                    white_central_plies >= 4 or black_central_plies >= 4
                ):
                    game_tags.add("endgame:king-centralization")
        except Exception:
            pass

    return sorted(game_tags)


def parse_tags_with_justifications(report_md: str) -> dict[str, str]:
    """
    Extracts tags and their justifications from coaching report markdown.
    Discards any tag that lacks a concrete explanation of why it applies (min 15 chars).
    Sorts tags chronologically by move number if mentioned, with whole-game tags last.
    """
    justified_tags: dict[str, str] = {}
    if not report_md:
        return justified_tags

    lines = report_md.splitlines()
    for line in lines:
        m = re.search(
            r"[`*]*((?:tactic|opening|strategy|endgame|general|time):[a-z0-9\-]+)[`*]*(?:\s*\([^\)]*\))?\s*[:\-\u2013\u2014]\s*(.+)",
            line,
            re.IGNORECASE,
        )
        if m:
            raw_tag = m.group(1).lower().strip()
            explanation = m.group(2).strip()
            explanation = re.sub(
                r"^\s*(?:\([^\)]*\)|\*\*[^\*]+\*\*)\s*[:\-\u2013\u2014]?\s*", "", explanation
            )
            norm = normalize_tag(raw_tag)
            if norm and norm in ALLOWED_TAGS and len(explanation) >= 15:
                justified_tags[norm] = explanation

    if not justified_tags:
        return justified_tags

    def _extract_move_num(text: str) -> int:
        match = re.search(
            r"\b(?:move\s+)(\d+)\b|\b(\d+)\s*(?:\.{1,3}|\.\s+)[a-zA-Z0-9#+=x\-]+",
            text,
            re.IGNORECASE,
        )
        if match:
            num_str = match.group(1) or match.group(2)
            if num_str:
                try:
                    return int(num_str)
                except ValueError:
                    pass
        return 9999

    sorted_items = sorted(
        justified_tags.items(),
        key=lambda item: _extract_move_num(item[1]),
    )
    return dict(sorted_items)


VALID_MOVE_CLASSES: dict[str, str] = {
    "checkmate": "Checkmate",
    "mate": "Checkmate",
    "brilliant": "Brilliant",
    "great move": "Great Move",
    "great": "Great Move",
    "missed win": "Missed Win",
    "missed tactic": "Missed Tactic",
    "missed": "Missed Tactic",
    "blunder": "Blunder",
    "mistake": "Mistake",
    "inaccuracy": "Inaccuracy",
    "good move": "Good Move",
    "best move": "Best Move",
}


def parse_move_classifications_from_table(report_md: str) -> dict[str, str]:
    """
    Parses approved move classifications from Section 4's Critical Moments markdown table.
    Returns mapping of move string (e.g. '20... Ne3') to approved classification (e.g. 'Great Move').
    """
    classifications: dict[str, str] = {}
    if not report_md:
        return classifications

    in_critical_moments = False
    for line in report_md.splitlines():
        line_clean = line.strip()
        if re.match(r"^#+\s*(?:\d+\.\s*)?Critical Moments", line_clean, re.IGNORECASE):
            in_critical_moments = True
            continue
        elif in_critical_moments and re.match(r"^#+\s*(?:\d+\.\s*)?[A-Za-z]", line_clean):
            in_critical_moments = False

        if in_critical_moments and "|" in line_clean:
            parts = [p.strip() for p in line_clean.split("|")[1:-1]]
            if len(parts) >= 3 and not all(c == "-" or c == ":" for c in parts[0].replace(" ", "")):
                move_candidate = parts[0].replace("`", "").strip()
                if move_candidate.lower() in ("move", "moves", "e.g., 18...nxe4", "e.g. 18...nxe4"):
                    continue

                for col in parts[1:]:
                    clean_col = col.replace("`", "").replace("*", "").strip().lower()
                    if clean_col in VALID_MOVE_CLASSES:
                        classifications[move_candidate] = VALID_MOVE_CLASSES[clean_col]
                        break

    return classifications


def reconcile_move_classifications(
    payload: GameAnalysisPayload,
    report_md: str,
) -> None:
    """
    Reconciles move classifications with the AI coach's editorial verdict in Section 4.
    Ensures that every celebratory badge (Brilliant, Great Move) and missed tactic is approved
    by the AI coach. Any unapproved engine heuristic classification is discarded or normalized.
    """
    if not report_md or not payload.critical_moments:
        return

    approved_map = parse_move_classifications_from_table(report_md)

    for cm in payload.critical_moments:
        move_key_candidates = [
            f"{cm.move_number}... {cm.move_played_san}",
            f"{cm.move_number}. {cm.move_played_san}",
            f"{cm.move_number}...{cm.move_played_san}",
            f"{cm.move_number}.{cm.move_played_san}",
            cm.move_played_san,
        ]

        matched_class: str | None = None
        for cand in move_key_candidates:
            if cand in approved_map:
                matched_class = approved_map[cand]
                break

        if not matched_class:
            for key, cls_val in approved_map.items():
                m = re.search(r"\b(\d+)(?:\.{1,3}|\s+)([a-zA-Z0-9#+=x\-]+)", key)
                if m:
                    mn = int(m.group(1))
                    san = m.group(2)
                    if mn == cm.move_number and (
                        san == cm.move_played_san or san in cm.move_played_san
                    ):
                        matched_class = cls_val
                        break

        if matched_class:
            cm.classification = matched_class
        else:
            # If the engine tentatively flagged the move as Brilliant or Great Move,
            # but the AI coach did not approve it in Section 4, demote/discard it!
            if cm.classification in ("Brilliant", "Great Move"):
                if "#" in cm.move_played_san or "checkmate" in (cm.classification or "").lower():
                    cm.classification = "Checkmate"
                else:
                    cm.classification = "Best Move"


def resolve_game_tags(
    ai_tags: list[str] | None,
    payload: GameAnalysisPayload,
    max_tags: int | None = None,
    report_md: str | None = None,
) -> list[str]:
    """
    Reconciles AI-suggested tags with deterministic ground truth tags.
    When report_md is provided, EVERY tag assigned to the game MUST be explained by the AI coach
    in Section 7. Any tag not explained and approved by the coach is discarded.
    """
    resolved: list[str] = []
    seen: set[str] = set()

    # 1. When report_md is provided, every assigned tag MUST have an explanation in Section 7
    if report_md:
        tag_justifications = parse_tags_with_justifications(report_md)
        if tag_justifications:
            for t in tag_justifications.keys():
                if t not in seen:
                    resolved.append(t)
                    seen.add(t)
                    if max_tags is not None and len(resolved) >= max_tags:
                        return resolved
            return resolved

    # 2. Fallback only when no report or no justified tags are present (e.g. offline/mock tests)
    if ai_tags:
        for t in ai_tags:
            norm = normalize_tag(t)
            if norm and norm in ALLOWED_TAGS and norm not in seen:
                resolved.append(norm)
                seen.add(norm)
                if max_tags is not None and len(resolved) >= max_tags:
                    return resolved

    for pt in payload.tags or []:
        norm_pt = normalize_tag(pt)
        if norm_pt and norm_pt in ALLOWED_TAGS and norm_pt not in seen:
            resolved.append(norm_pt)
            seen.add(norm_pt)
            if max_tags is not None and len(resolved) >= max_tags:
                return resolved

    if not resolved:
        det_tags = extract_deterministic_tags(payload)
        for dt in det_tags:
            if dt not in seen:
                resolved.append(dt)
                seen.add(dt)
                if max_tags is not None and len(resolved) >= max_tags:
                    break

    return resolved


__all__ = [
    "ALLOWED_TAGS",
    "POSITIVE_TAGS",
    "TAG_ALIASES",
    "VALID_MOVE_CLASSES",
    "extract_deterministic_tags",
    "is_positive_tag",
    "normalize_tag",
    "parse_move_classifications_from_table",
    "parse_tags_with_justifications",
    "reconcile_move_classifications",
    "resolve_game_tags",
    "sort_tags_negative_first",
]
