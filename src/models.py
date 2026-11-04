from __future__ import annotations

from pydantic import BaseModel, Field


class PieceInteraction(BaseModel):
    square: str
    piece: str  # e.g., "Black bishop on e7"
    attackers: list[str]  # e.g., ["White queen on e5", "White rook on e1"]
    defenders: list[str]  # e.g., ["Black queen on d8", "Black king on e8"]
    is_pinned: bool
    pinned_to: str | None = None  # e.g., "e8"


class TacticalFacts(BaseModel):
    fen: str
    turn: str  # "White" or "Black"
    move_number: int
    is_check: bool
    legal_castling: dict[str, bool]
    material_count: dict[str, int]  # {"White": 39, "Black": 39}
    piece_placement: dict[str, list[str]]  # {"White": ["Qe5", "Rd1", ...], "Black": [...]}
    attacked_or_pinned_pieces: list[PieceInteraction]
    hanging_pieces: list[str]  # Pieces where len(attackers) > 0 and len(defenders) == 0


class CriticalMoment(BaseModel):
    ply: int
    move_number: int
    color: str
    move_played_san: str
    eval_before_cp: int | None = None  # From White's perspective
    eval_after_cp: int | None = None
    mate_before: int | None = None
    mate_after: int | None = None
    classification: str  # "Inaccuracy", "Mistake", "Blunder", "Critical Turning Point"
    best_move_san: str
    pv_san: list[str]  # Top engine continuation (up to 6 plies)
    refutation_san: list[str] = Field(
        default_factory=list
    )  # Top engine response/continuation (up to 6 plies) after the played move
    facts_before_move: TacticalFacts
    facts_after_played_move: TacticalFacts
    facts_after_best_move: TacticalFacts
    facts_at_end_of_pv: TacticalFacts
    clock_seconds_remaining: float | None = None  # Time remaining on player's clock after move
    time_spent_seconds: float | None = None  # Seconds spent calculating this move


class GameAnalysisPayload(BaseModel):
    white_player: str
    black_player: str
    user_color: str  # "White", "Black", or "Both"
    result: str
    time_control: str
    opening_name: str | None = None
    pgn_moves_summary: str
    total_plies: int
    critical_moments: list[CriticalMoment]
    platform: str | None = None
    date: str | None = None
    white_elo: str | None = None
    black_elo: str | None = None
    time_control_category: str | None = None
    game_url: str | None = None
    ply_evals: list[int | None] | None = None
    ply_clocks: list[float | None] | None = None  # Clock seconds remaining after each ply
    ply_times_spent: list[float | None] | None = None  # Seconds spent on each ply
    tags: list[str] = Field(default_factory=list)


class GameData(BaseModel):
    id: str
    white: str
    black: str
    date: str | None = None
    played_at: str | None = None
    result: str
    time_control: str
    pgn: str
    source: str | None = None


class AskMoveRequest(BaseModel):
    ply: int | None = None
    move_number: int | None = None
    color: str | None = None
    question: str
    provider: str | None = None
    model_name: str | None = None


class AskMoveResponse(BaseModel):
    formal_question: str
    answer_markdown: str
    move_context: str
    ply: int
    move_number: int
    color: str


class AppendQARequest(BaseModel):
    formal_question: str
    answer_markdown: str
    move_context: str
    ply: int | None = None


class AppendQAResponse(BaseModel):
    ok: bool
    report_html: str
    report_md: str
    section_heading: str


class GitHubPullResult(BaseModel):
    ok: bool
    imported_count: int
    updated_count: int
    skipped_count: int
    purged_pending_count: int
    total_remote: int
    errors: list[str] = Field(default_factory=list)
    message: str


# Alias for compatibility with GEMINI.md naming
AnalysisPayload = GameAnalysisPayload

__all__ = [
    "AnalysisPayload",
    "AppendQARequest",
    "AppendQAResponse",
    "AskMoveRequest",
    "AskMoveResponse",
    "CriticalMoment",
    "GameAnalysisPayload",
    "GameData",
    "GitHubPullResult",
    "PieceInteraction",
    "TacticalFacts",
]
