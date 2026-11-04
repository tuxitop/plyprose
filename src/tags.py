"""
Standardized Chess Coaching Taxonomy and Ground-Truth Tagging Service.
Provides a deterministic vocabulary for opening, tactical, strategic, and endgame patterns
to guarantee cross-model consistency and zero hallucination.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

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
    "king-activity": "endgame:king-activity",
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
    Deterministically computes grounded tags directly from python-chess tactical facts
    and Stockfish swing evaluations, completely immune to LLM hallucination.
    """
    tags: set[str] = set()

    # 1. Critical moments analysis
    for cm in payload.critical_moments:
        cls_lower = (cm.classification or "").lower()

        # Missed win / Missed mate
        if "missed win" in cls_lower:
            tags.add("tactic:missed-win")
        if cm.mate_before is not None and cm.mate_after is None:
            tags.add("tactic:missed-mate")

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

        # Double attacks / Forks
        best_has_fork = any(
            len(p.attackers) >= 2 for p in best_facts.attacked_or_pinned_pieces
        ) or any(len(p.attackers) >= 2 for p in pv_end_facts.attacked_or_pinned_pieces)
        played_has_fork = any(len(p.attackers) >= 2 for p in played_facts.attacked_or_pinned_pieces)
        if best_has_fork and not played_has_fork:
            tags.add("tactic:missed-fork")

        # Hanging pieces blundered or allowed
        if played_facts.hanging_pieces:
            tags.add("tactic:missed-hanging-piece")

        # Check early opening mistakes (castling rights surrendered)
        if cm.move_number <= 10:
            if not any(played_facts.legal_castling.values()) and any(
                cm.facts_before_move.legal_castling.values()
            ):
                tags.add("opening:king-in-center")

    # 2. Game duration and phase heuristics
    if payload.total_plies >= 70:
        tags.add("endgame:king-centralization")

    return sorted(tags)


def resolve_game_tags(
    ai_tags: list[str] | None,
    payload: GameAnalysisPayload,
    max_tags: int = 5,
) -> list[str]:
    """
    Reconciles AI-suggested tags with deterministic ground truth tags.
    Normalizes all inputs against ALLOWED_TAGS and produces a clean, deduplicated list.
    """
    resolved: list[str] = []
    seen: set[str] = set()

    # 1. First add validated AI-selected tags
    if ai_tags:
        for t in ai_tags:
            norm = normalize_tag(t)
            if norm and norm in ALLOWED_TAGS and norm not in seen:
                resolved.append(norm)
                seen.add(norm)
                if len(resolved) >= max_tags:
                    return resolved

    # 2. Supplement with deterministic tags if AI missed key tactical insights
    det_tags = extract_deterministic_tags(payload)
    for dt in det_tags:
        if dt not in seen:
            resolved.append(dt)
            seen.add(dt)
            if len(resolved) >= max_tags:
                break

    return resolved
