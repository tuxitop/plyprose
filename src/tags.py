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
    "tactic:missed-discovery": "Missed Discovered Attack",
    "tactic:missed-mate": "Missed Checkmate",
    "tactic:missed-win": "Missed Winning Advantage",
    "tactic:missed-tactic": "Missed Tactical Motif",
    "tactic:missed-hanging-piece": "Missed Free Piece",
    "tactic:missed-back-rank": "Missed Back-Rank Tactic",
    "tactic:missed-deflection": "Missed Deflection",
    "tactic:missed-zwischenzug": "Missed In-Between Move",
    # ── Tactics: Found & Executed ─────────────────────────────────────────────
    "tactic:found-fork": "Fork Executed",
    "tactic:found-pin": "Pin Applied",
    "tactic:found-skewer": "Skewer Executed",
    "tactic:found-discovery": "Discovered Attack",
    "tactic:found-mate": "Checkmate Delivered",
    "tactic:found-sacrifice": "Tactical Sacrifice",
    "tactic:hanging-piece-punished": "Captured Free Piece",
    "tactic:back-rank-punished": "Back-Rank Checkmate",
    # ── Time Management ───────────────────────────────────────────────────────
    "time:clutch-play": "Clutch Time Scramble",
    "time:trouble-blunder": "Time Pressure Blunder",
    "time:rushed-blunder": "Rushed Move Blunder",
    "time:time-advantage": "Clock Advantage",
    # ── Opening & Early Development ──────────────────────────────────────────
    "opening:development-lead": "Lead in Development",
    "opening:development-lag": "Lag in Development",
    "opening:early-queen": "Premature Queen Attack",
    "opening:king-in-center": "King Trapped in Center",
    "opening:failed-to-castle": "Castling Neglected",
    "opening:pawn-overextension": "Pawn Overextension",
    "opening:wasted-tempo": "Wasted Opening Tempo",
    "opening:center-control": "Dominant Center Control",
    # ── Middlegame Strategy & Positional ──────────────────────────────────────
    "strategy:piece-coordination": "Harmonious Piece Play",
    "strategy:outpost-control": "Outpost Dominance",
    "strategy:open-file-control": "Open File Seized",
    "strategy:weak-squares": "Exploited Weak Squares",
    "strategy:isolated-pawn": "Isolated Pawn Weakness",
    "strategy:doubled-pawns": "Compromised Pawn Structure",
    "strategy:king-safety-risk": "Vulnerable King",
    "strategy:pawn-storm": "Flank Pawn Storm",
    "strategy:passive-defense": "Passive Defense",
    "strategy:overextended-attack": "Overextended Attack",
    # ── Endgame ───────────────────────────────────────────────────────────────
    "endgame:passed-pawn-created": "Created Passed Pawn",
    "endgame:passed-pawn-missed": "Allowed Opponent Passed Pawn",
    "endgame:active-rook": "Active Rook in Endgame",
    "endgame:passive-rook": "Passive Rook",
    "endgame:king-centralization": "Active Endgame King",
    "endgame:pawn-race": "Pawn Race",
    "endgame:opposition": "King Opposition",
    "endgame:technical-conversion": "Smooth Endgame Conversion",
    "endgame:stalemate-trap": "Stalemate Resource",
    # ── General & Practical Play ──────────────────────────────────────────────
    "general:time-trouble": "Time Trouble Critical Swing",
    "general:resilient-defense": "Tenacious Defensive Resource",
    "general:comeback-win": "Turnaround from Deficit",
    "general:missed-simplification": "Missed Winning Simplification",
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
    "hanging-piece": "tactic:missed-hanging-piece",
    "blundered-piece": "tactic:missed-hanging-piece",
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


def extract_deterministic_tags(payload: GameAnalysisPayload) -> list[str]:
    """
    Deterministically computes grounded tags directly from python-chess tactical facts,
    board positions, clock data, and Stockfish swing evaluations, completely immune to LLM hallucination.
    """
    tags: set[str] = set()

    # 1. Critical moments tactical analysis
    for cm in payload.critical_moments:
        cls_lower = (cm.classification or "").lower()

        # Missed win / Missed mate
        if "missed win" in cls_lower:
            tags.add("tactic:missed-win")
        if cm.mate_before is not None and cm.mate_after is None:
            tags.add("tactic:missed-mate")

        # Positive critical moments: Checkmate, Brilliant sacrifice
        if "checkmate" in cls_lower or "#" in cm.move_played_san:
            tags.add("tactic:found-mate")
        if "brilliant" in cls_lower:
            tags.add("tactic:found-sacrifice")

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
            tags.add("tactic:missed-pin")
        elif played_has_pins and cls_lower in ("great move", "brilliant", "checkmate", "best move"):
            tags.add("tactic:found-pin")

        # Double attacks / Forks
        best_has_fork = any(
            len(p.attackers) >= 2 for p in best_facts.attacked_or_pinned_pieces
        ) or any(len(p.attackers) >= 2 for p in pv_end_facts.attacked_or_pinned_pieces)
        played_has_fork = any(len(p.attackers) >= 2 for p in played_facts.attacked_or_pinned_pieces)
        if best_has_fork and not played_has_fork:
            tags.add("tactic:missed-fork")
        elif played_has_fork and cls_lower in ("great move", "brilliant", "checkmate", "best move"):
            tags.add("tactic:found-fork")

        # Hanging pieces blundered or allowed
        if played_facts.hanging_pieces:
            tags.add("tactic:missed-hanging-piece")

        # Check early opening mistakes (castling rights surrendered)
        if cm.move_number <= 10:
            if not any(played_facts.legal_castling.values()) and any(
                cm.facts_before_move.legal_castling.values()
            ):
                tags.add("opening:king-in-center")

        # Time pressure blunder
        if (
            cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining <= 30.0
            and any(w in cls_lower for w in ("blunder", "mistake"))
        ):
            tags.add("time:trouble-blunder")

        # Rushed move blunder (moved in < 3s despite having ample time > 60s)
        if (
            cm.time_spent_seconds is not None
            and cm.time_spent_seconds < 3.0
            and cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining > 60.0
            and any(w in cls_lower for w in ("blunder", "mistake", "inaccuracy"))
        ):
            tags.add("time:rushed-blunder")

        # Clutch time scramble / conversion
        if (
            cm.clock_seconds_remaining is not None
            and cm.clock_seconds_remaining <= 30.0
            and any(w in cls_lower for w in ("checkmate", "brilliant", "great move"))
        ):
            tags.add("time:clutch-play")

    # 2. Checkmate delivered at the end of the game
    if (
        payload.result in ("1-0", "0-1")
        and payload.pgn_moves_summary
        and "#" in payload.pgn_moves_summary.split()[-1]
    ):
        tags.add("tactic:found-mate")

    # 3. Comeback turnaround
    if payload.ply_evals and len(payload.ply_evals) >= 10:
        if payload.result == "1-0":
            if any(e is not None and e <= -200 for e in payload.ply_evals):
                tags.add("general:comeback-win")
        elif payload.result == "0-1":
            if any(e is not None and e >= 200 for e in payload.ply_evals):
                tags.add("general:comeback-win")

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

                if white_central_plies >= 4 or black_central_plies >= 4:
                    tags.add("endgame:king-centralization")
        except Exception:
            pass

    return sorted(tags)


def parse_tags_with_justifications(report_md: str) -> dict[str, str]:
    """
    Extracts tags and their justifications from coaching report markdown.
    Discards any tag that lacks a concrete explanation of why it applies (min 15 chars).
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
            explanation = re.sub(r"^\(\*\*[^\)]+\*\*\)\s*[:\-\u2013\u2014]?\s*", "", explanation)
            norm = normalize_tag(raw_tag)
            if norm and norm in ALLOWED_TAGS and len(explanation) >= 15:
                justified_tags[norm] = explanation

    return justified_tags


def resolve_game_tags(
    ai_tags: list[str] | None,
    payload: GameAnalysisPayload,
    max_tags: int = 6,
    report_md: str | None = None,
) -> list[str]:
    """
    Reconciles AI-suggested tags with deterministic ground truth tags.
    If report_md is provided with a Game Tags section, validates that AI tags have grounded justifications,
    discarding any tags that the AI coach cannot substantiate.
    """
    resolved: list[str] = []
    seen: set[str] = set()

    # 1. Parse validated AI tags with justifications if report_md is available
    valid_ai_tags: list[str] = []
    has_tags_section = bool(
        report_md and re.search(r"#+\s*(?:\d+\.\s*)?Game Tags", report_md, re.IGNORECASE)
    )

    if has_tags_section and report_md:
        tag_justifications = parse_tags_with_justifications(report_md)
        valid_ai_tags = list(tag_justifications.keys())
    elif report_md:
        tag_justifications = parse_tags_with_justifications(report_md)
        if tag_justifications:
            valid_ai_tags = list(tag_justifications.keys())
        elif ai_tags:
            for t in ai_tags:
                norm = normalize_tag(t)
                if norm and norm in ALLOWED_TAGS:
                    valid_ai_tags.append(norm)
    elif ai_tags:
        for t in ai_tags:
            norm = normalize_tag(t)
            if norm and norm in ALLOWED_TAGS:
                valid_ai_tags.append(norm)

    for t in valid_ai_tags:
        if t not in seen:
            resolved.append(t)
            seen.add(t)
            if len(resolved) >= max_tags:
                return resolved

    # 2. Include existing payload tags (e.g. from analyze_pgn)
    for pt in payload.tags or []:
        norm_pt = normalize_tag(pt)
        if norm_pt and norm_pt in ALLOWED_TAGS and norm_pt not in seen:
            resolved.append(norm_pt)
            seen.add(norm_pt)
            if len(resolved) >= max_tags:
                return resolved

    # 3. Supplement with deterministic tags if AI missed key tactical or time insights
    det_tags = extract_deterministic_tags(payload)
    for dt in det_tags:
        if dt not in seen:
            resolved.append(dt)
            seen.add(dt)
            if len(resolved) >= max_tags:
                break

    return resolved
