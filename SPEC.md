# PlyProse — Software Design & Specification Document (SDD)

## 1. System Overview

**PlyProse** is an automated, deep-dive chess coaching platform that bridges the gap between cold engine centipawn evaluations and intuitive human masterclass storytelling. Rather than simply labeling moves as "blunder" or "mistake," PlyProse identifies pivotal psychological, tactical, and strategic turning points, computes 100% verified ground-truth facts deterministically via `python-chess` and Stockfish (`chess.engine`), and uses an LLM coaching agent with Function Calling to generate rich, chapter-based narrative coaching reports tailored to the player's rating tier.

### Core Architecture Highlights

- **Zero-Hallucination Chess:** An LLM must NEVER mentally visualize a chessboard, calculate legal moves, or count attackers/defenders in its head. All board states, hanging pieces, pins, batteries, material counts, evaluations, and variations are computed deterministically before prompting the model, and all model-suggested variations are verified via callable inspection tools (`verify_variation_tool`, `inspect_square`).
- **Dual LLM Provider Support:**
  - **Google Gemini:** Direct integration via the modern `google-genai` SDK (`gemini-2.5-pro` / `gemini-2.5-flash`) utilizing native function calling.
  - **OpenAI-Compatible Endpoints:** Configurable `base_url` supporting local and cloud inference providers (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq) via the standard `openai` SDK with a manual tool-calling loop, tool schemas, and graceful no-tools fallback.
- **Interactive Move-Level Q&A:** Players can select any move or ply on the interactive board, ask specific questions about candidate moves or plans ("Why couldn't I play Nd5 here?"), receive structured answers from the LLM coach grounded in deterministic tactical facts, and optionally append the Q&A exchange as a permanent chapter to the study report.
- **Standardized Coaching Taxonomy & Ground-Truth Tagging:** A curated taxonomy of 40+ standardized tags across tactics, time management, opening play, middlegame strategy, and endgames (`src/tags.py`). Tags are extracted deterministically from engine evaluations and reconciled with coach report justifications.
- **Deterministic Opening Tree & Continuations:** Compact, transposition-aware opening tree built from the official Lichess dataset (`src/openings.py`). Detects canonical ECO openings and suggests continuation branches.
- **Interactive Board & Client-Side Engine:** Built with `@lichess-org/chessground` and browser-side **Stockfish 19 WASM**, supporting free-play variation exploration, live multi-PV arrows, evaluation bar, and interactive ply-by-ply navigation synchronized with the narrative report and evaluation chart.
- **Multi-Format Export:** Reports export to clean Markdown, publication-quality PDFs via **WeasyPrint** (with headless text fallback), standalone HTML documents with embedded SVG boards, or ZIP packages containing Markdown and rendered PNG board diagrams.
- **Bi-Directional GitHub Smart Sync:** Automated synchronization with a user's GitHub study repository. Pushes finished analyses and Q&A additions atomically via the GitHub Git Data API, and performs lightweight smart auto-pulls based on remote branch commit SHAs.
- **GitHub Direct Mode & Mobile PWA Reader:** Standalone client-side mode for GitHub Pages or mobile PWA installation, allowing users to browse and interact with private study repositories directly from their mobile browser without a running backend server.

---

## 2. Data Schemas

### 2.1 Core Domain Models (`src/models.py`)

```python
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
    pv_san: list[str]  # Top engine continuation (up to 6 plies) after best move
    refutation_san: list[str] = Field(
        default_factory=list
    )  # Top engine response/continuation (up to 6 plies) after played move
    facts_before_move: TacticalFacts
    facts_after_played_move: TacticalFacts
    facts_after_best_move: TacticalFacts
    facts_at_end_of_pv: TacticalFacts
    clock_seconds_remaining: float | None = None  # Time remaining on player's clock after move
    time_spent_seconds: float | None = None  # Seconds spent calculating this move
    tags: list[str] = Field(default_factory=list)  # Move-specific tactical/time tags


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


# Backward-compatible alias
AnalysisPayload = GameAnalysisPayload


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
```

### 2.2 Opening Tree Models (`src/openings.py`)

```python
class OpeningEntry(BaseModel):
    eco: str
    name: str
    pgn: str
    uci: str
    epd: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class OpeningMatch(BaseModel):
    eco: str
    name: str
    ply: int
    uci: str
    pgn: str
    epd: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class OpeningContinuation(BaseModel):
    uci: str
    san: str
    eco: str
    name: str

    @property
    def full_name(self) -> str:
        return f"{self.eco}: {self.name}"


class IdentifyOpeningRequest(BaseModel):
    pgn: str | None = None
    moves: list[str] = Field(default_factory=list)


class IdentifyOpeningResponse(BaseModel):
    matched: bool
    eco: str | None = None
    name: str | None = None
    full_name: str | None = None
    ply: int | None = None
    pgn: str | None = None
    uci: str | None = None
    epd: str | None = None
    continuations: list[OpeningContinuation] = Field(default_factory=list)
```

---

## 3. Module Specifications

### Module A: `src/fetcher.py` (Platform Game & Rating Ingestion)

- **`fetch_lichess_games(username: str, max_games: int = 10) -> list[dict[str, Any]]`**
  - Endpoint: `GET https://lichess.org/api/games/user/{username}?max={max_games}&pgnInJson=true&opening=true&clocks=true&evals=true`
  - Headers: `Accept: application/x-ndjson`
  - Normalized fields: `id`, `white`, `black`, `date`, `played_at`, `result`, `time_control`, `pgn` (with embedded clock `[%clk ...]` and evaluation `[%eval ...]` comments), `source="lichess"`.
- **`fetch_chesscom_games(username: str, max_games: int = 10) -> list[dict[str, Any]]`**
  - Step 1: `GET https://api.chess.com/pub/player/{username}/games/archives` (with custom `User-Agent` header).
  - Step 2: Fetches the most recent monthly archive JSON, extracts the last `max_games` containing `"pgn"`, and normalizes to the standard format.
- **`fetch_lichess_ratings(username: str) -> dict[str, int | None]`**
  - Queries `GET https://lichess.org/api/user/{username}` and extracts current Blitz and Rapid ratings.
- **`fetch_chesscom_ratings(username: str) -> dict[str, int | None]`**
  - Queries `GET https://api.chess.com/pub/player/{username}/stats` and extracts Blitz and Rapid ratings.
- **`parse_raw_pgn_metadata(pgn_str: str) -> dict[str, Any]`**
  - Parses PGN headers (`White`, `Black`, `Date`, `Result`, `TimeControl`, `Site`, `ECO`, `Opening`) and returns normalized game metadata.
- **Error Handling & Exceptions:**
  - `FetchError`: Base exception for platform communication issues.
  - `UserNotFoundError`: Platform user does not exist (HTTP 404).
  - `RateLimitError`: Platform rate limits exceeded (HTTP 429).

### Module B: `src/inspector.py` (Deterministic Board State & Tactical Fact Extraction)

- **`extract_tactical_facts(board: chess.Board) -> TacticalFacts`**
  - Iterates over `board.piece_map()`.
  - Determines check state, castling availability, and material balance.
  - Uses `get_attackers_and_defenders` to enumerate all attackers and defenders for every piece on the board.
  - Detects absolute pins to the King (`board.is_pinned(color, square)` and `board.pin(color, square)`).
  - Identifies hanging pieces (`len(attackers) > 0 and len(defenders) == 0`).
- **`get_attackers_and_defenders(board: chess.Board, target_sq: chess.Square, target_color: chess.Color) -> tuple[list[str], list[str]]`**
  - Computes direct attacks for non-sliding pieces (Pawns, Knights, Kings).
  - Traces rays for sliding pieces (Rooks, Bishops, Queens) including battery and X-ray attacks through friendly sliding pieces along the same rank, file, or diagonal.
- **`verify_variation_tool(fen: str, san_moves: list[str]) -> dict`**
  - Callable tool for LLM coaching agents.
  - Instantiates `chess.Board(fen)`, sequentially parses and executes each move in `san_moves` (with SAN and fallback UCI resolution).
  - If any move is illegal, returns `{"valid": False, "illegal_move": move_str, "legal_moves_sample": [...]}`.
  - If valid, returns `{"valid": True, "resulting_facts": extract_tactical_facts(board).model_dump()}`.
- **`inspect_square(board_or_fen: chess.Board | str, square_name: str) -> dict`**
  - Callable tool for LLM coaching agents.
  - Returns target square piece details, attackers, defenders, pin status, and hanging status.

### Module C: `src/analyzer.py` (Stockfish Engine Analysis & Critical Turning Points)

- **`analyze_pgn(pgn_str: str, stockfish_path: str | None = None, user_color: str = "Both", time_per_move: float = 0.15, max_depth: int | None = 18, limit_mode: str = "both", backward_analysis: bool = True, engine_instance: chess.engine.SimpleEngine | None = None, progress_callback: Callable[[int, int], None] | None = None) -> GameAnalysisPayload`**
  - Parses PGN mainline moves and replay board states.
  - Auto-detects local Stockfish binary if `stockfish_path` is not explicitly provided.
  - Configures Stockfish hash table (64MB) to maintain transposition table entries across positions.
  - **Evaluation Limit Modes (`limit_mode`):**
    - `"both"`: Halts when either `time_per_move` or `max_depth` threshold is reached.
    - `"depth"`: Fixes evaluation to `chess.engine.Limit(depth=max_depth)`.
    - `"time"`: Fixes evaluation to `chess.engine.Limit(time=time_per_move)`.
  - **Backward Analysis (`backward_analysis=True`):**
    - Analyzes positions from final ply $N$ back to ply $0$ (Lichess fishnet pattern) to pre-populate endgame transpositions before evaluating complex middlegame positions.
  - **Two-Pass Pipeline:**
    - Pass 1 (Engine Analysis): Evaluates every ply position, records centipawns/mate scores, and triggers `progress_callback`. Clamps non-mate scores to $[-1000, 1000]$ cp for clean visualization.
    - Pass 2 (Forward Reconstruction & Critical Swings): Parses clock annotations (`[%clk ...]`), computes time spent per move, detects centipawn swings $\ge 80$ cp against the moving side (or forced mate status transitions), generates the top engine refutation line (`refutation_san`) up to 6 plies after the played move, and extracts full tactical facts (`facts_before_move`, `facts_after_played_move`, `facts_after_best_move`, `facts_at_end_of_pv`).
- **`get_stockfish_version(stockfish_path: str | None = None) -> str | None`**
  - Initializes Stockfish UCI protocol and extracts the official banner string (e.g. `Stockfish 19`). Auto-detects system paths (`/usr/games/stockfish`, `/usr/local/bin/stockfish`, `/usr/bin/stockfish`).

### Module D: `src/coach_agent.py` (Gemini Coaching Agent & Move Q&A)

- **`generate_narrative_report(payload: GameAnalysisPayload, model_name: str = "gemini-2.5-pro", api_key: str | None = None, client: object | None = None, system_prompt: str | None = None) -> str`**
  - Loads system instruction from `prompts/system_coach.md`.
  - Injects player rating profile (Blitz / Rapid Elo) into the system prompt to adapt coaching tone and conceptual depth.
  - Configures `GenerateContentConfig(tools=[verify_variation_tool, inspect_square], temperature=0.2)` using `google-genai`.
  - Instructs the model to rely strictly on the provided `GameAnalysisPayload` JSON and call tools whenever discussing variations outside the payload.
- **Move-Level Interactive Coaching Q&A:**
  - `extract_move_qa_context(pgn_text: str, payload: GameAnalysisPayload | None, ply: int | None, move_number: int | None, color: str | None) -> dict[str, Any]`
  - `ask_move_question_gemini(context: dict[str, Any], user_question: str, model_name: str = "gemini-2.5-pro", api_key: str | None = None, client: object | None = None) -> AskMoveResponse`
  - Reconstructs exact board state, tactical facts, engine evaluation, and candidate variations for the selected move. Answers user questions with verified advice and outputs structured Markdown.
- **Connection Testing & Resilient Fallback:**
  - `probe_gemini_connection(api_key: str | None = None) -> tuple[bool, str]`
  - `get_available_gemini_models(api_key: str | None = None) -> list[str]`
  - `generate_deterministic_summary(payload: GameAnalysisPayload) -> str`: Guaranteed offline fallback that formats a clean markdown report from deterministic facts if the LLM endpoint is unreachable.

### Module D2: `src/openai_agent.py` & `src/llm.py` (OpenAI-Compatible Dispatcher)

- **`generate_narrative_report(...) -> str` (`openai_agent.py`)**
  - Interacts with any OpenAI-compatible server (Ollama `/v1`, LM Studio, llama.cpp, vLLM, OpenRouter, Groq) via `openai.OpenAI`.
  - Uses explicit OpenAI function tool definitions for `verify_variation_tool` and `inspect_square`.
  - Executes a manual tool-calling loop (capped at `max_turns=8`), routing tool calls through `TOOL_REGISTRY` and feeding `role="tool"` responses back to the conversation.
  - Graceful tool rejection fallback: If an endpoint does not support tools (HTTP 400), automatically retries without tools while keeping the full deterministic JSON payload in context.
- **`ask_move_question_openai(...) -> AskMoveResponse` (`openai_agent.py`)**
  - Implements move-level Q&A for OpenAI-compatible models.
- **`probe_openai_compat_connection` & `list_openai_compat_models` (`openai_agent.py`)**
  - Connection validation and dynamic model enumeration.
- **Provider Dispatcher (`src/llm.py`)**
  - `generate_narrative_report(payload, provider="gemini", model_name="gemini-2.5-pro", ...)` routes requests to Gemini or OpenAI-compatible backends.
  - `ask_move_question(...)` routes move Q&A to the configured provider.
  - `model_label(provider: str, model_name: str) -> str` standardizes provenance strings (e.g. `gemini:gemini-2.5-pro`, `openai-compat:gpt-4o-mini`).

### Module D3: `src/tags.py` (Standardized Coaching Taxonomy & Ground-Truth Tagging)

- **Standardized Taxonomy (`ALLOWED_TAGS`):**
  - 40+ structured tag slugs across 6 domain categories:
    - `tactic:*` (`missed-fork`, `missed-pin`, `missed-mate`, `hung-piece`, `found-fork`, `found-pin`, `found-sacrifice`, etc.)
    - `time:*` (`clutch-play`, `trouble-blunder`, `rushed-blunder`, `time-advantage`, `time-sink`)
    - `opening:*` (`development-lead`, `development-lag`, `early-queen`, `king-in-center`, `failed-to-castle`, `center-control`)
    - `strategy:*` (`piece-coordination`, `outpost-control`, `open-file-control`, `weak-squares`, `isolated-pawn`, `king-safety-risk`)
    - `endgame:*` (`passed-pawn-created`, `active-rook`, `king-centralization`, `pawn-race`, `opposition`, `technical-conversion`)
    - `general:*` (`time-trouble`, `resilient-defense`, `comeback-win`, `missed-simplification`)
- **Deterministic Extraction & Tag Resolution:**
  - `extract_deterministic_tags(payload: GameAnalysisPayload) -> list[str]`: Evaluates clock times, centipawn swings, material balances, piece positions, and king safety to assign factual tags without hallucination.
  - `resolve_game_tags(ai_tags, payload, max_tags=None, report_md=None) -> list[str]`: When `report_md` is present, strictly enforces that every assigned tag must have an explicit justification in Section 7 of the report. Unjustified tags are discarded.
  - `reconcile_move_classifications(payload, report_md)`: Synchronizes move classification table entries (Best Move, Inaccuracy, Mistake, Blunder) between narrative prose and structured payload.

### Module D4: `src/openings.py` (Deterministic Opening Tree & Identification)

- **`OpeningsTree` Architecture:**
  - Built from canonical Lichess opening dataset (`src/data/openings.tsv.gz`).
  - Combines an exact EPD hash map ($O(1)$ lookup) with a move-trie for deep transposition-aware prefix matching.
- **Identification & Continuation APIs:**
  - `identify_opening(pgn_or_moves: str | Sequence[str]) -> OpeningMatch | None`: Traverses move sequences to match the deepest canonical opening and ECO code.
  - `get_continuations(board_or_fen: chess.Board | str) -> list[OpeningContinuation]`: Returns candidate canonical continuation branches with names and SAN moves from the current position.
- **REST Endpoints:**
  - `POST /api/openings/identify`
  - `GET /api/openings/continuations`
  - `GET /api/openings/search`

### Module D5: `src/evals.py` (PGN Evaluation Parser & Interpolation)

- **`extract_ply_evals_from_pgn(pgn_text: str) -> list[int | None] | None`**
  - Parses `[%eval ...]` comments embedded in PGN strings (centipawns or forced mate tokens `#3`, `#-2`), mapping them to White-perspective centipawn values.
- **`interpolate_eval_list(scores: list[int | None]) -> list[int | None]`**
  - Fills evaluation gaps across plies using linear interpolation, guaranteeing complete data for evaluation graphs.

### Module E: Exporters & Board Rendering (`src/exporter.py` & `api/board_renderer.py`)

- **`src/exporter.py`**:
  - `export_to_pdf(markdown_text: str, output_path: str | None = None) -> bytes`: Renders styled PDF reports via `weasyprint`, embedding fonts, tables, and SVGs. Falls back to a clean text-based PDF if WeasyPrint system libraries are absent.
  - `render_critical_svgs(payload: GameAnalysisPayload) -> dict[int, str]`: Generates SVG boards for critical moments using `chess.svg.board()`.
  - `render_moment_comparison_svgs(payload: GameAnalysisPayload, ply: int) -> dict[str, str]`: Produces side-by-side SVG comparisons for played move vs best engine move.
  - `inline_svg_uses(svg: str) -> str`: Expands `<use href="#id">` references into inline SVG paths to prevent sanitizers (DOMPurify) from stripping chess pieces.
  - `build_board_html_document(svg: str, size: int = 380) -> str`: Wraps board SVG in a standalone HTML document.
- **`api/board_renderer.py`**:
  - Custom `<board>` Tag Syntax: Parses `<board fen="..." arrows="..." circles="..." flipped="..." size="...">` tags embedded in Markdown coaching reports.
  - `render_board_tag`, `render_board_tag_as_data_uri`, `render_board_tag_as_png_bytes`.
  - `replace_board_tags_with_html(report_text: str, size: int = 380) -> str`: Inlines SVG diagrams directly into HTML report views.
  - `build_markdown_zip(report_text: str, png_size: int = 560) -> bytes`: Packages `report.md` alongside high-resolution standalone PNG board diagrams (`assets/diagram_N.png`) into a downloadable ZIP archive.
  - `reconcile_report_fens`: Automatically verifies and corrects FEN positions in report board tags against actual game positions.

### Module F: Storage, Dynamic Settings & REST API (`src/storage.py`, `api/`)

- **SQLite Database Architecture (`outputs/history.db`)**:
  - `game_analyses`: Stores completed analyses, PGN text, full payload JSON, Markdown report, platform, external IDs, GitHub sync status, and tags.
  - `pending_games`: Stores unanalyzed games imported from platforms or PGN files.
  - `settings`: Persists dynamic user configurations (ratings, platform profiles, Stockfish parameters, LLM credentials, GitHub sync options).
- **Ratings & Time Controls (`api/ratings.py`, `api/time_control.py`)**:
  - `detect_ratings_from_games`: Auto-detects user Blitz and Rapid ratings from game history.
  - `classify_time_control`: Normalizes time controls into Bullet, Blitz, Rapid, Classical, and Daily categories.
- **Cross-Instance Game Identification (`src/storage.py`)**:
  - `compute_game_hash(pgn_text: str) -> str`: Deterministic 12-character SHA-256 hash of cleaned moves.
  - `get_game_key(rec: dict) -> str`: Canonical instance-independent key (`external_id`, `github_path` folder, or PGN hash).
  - `get_analysis_by_id_or_key(identifier: int | str)`: Resolves analyses transparently via numeric SQLite ID, platform slug, GitHub folder, or PGN hash.

#### Complete REST API Specification

| Method | Endpoint | Description |
| --- | --- | --- |
| **Settings** | | |
| `GET` | `/api/settings` | Retrieve active application settings |
| `PUT` | `/api/settings` | Update application settings |
| `GET` | `/api/settings/detected-ratings` | Get auto-detected user ratings from game history |
| `POST` | `/api/settings/test-connection` | Validate LLM provider API credentials |
| `POST` | `/api/settings/verify-username` | Verify platform usernames and fetch ratings |
| **Games Library** | | |
| `GET` | `/api/games` | List games with search, platform, tag, and status filtering |
| `POST` | `/api/games/import` | Import single game from raw PGN text |
| `POST` | `/api/games/import-batch` | Batch import multiple games from PGN or platform |
| `GET` | `/api/games/fetch-platform-games` | Fetch recent games from Lichess / Chess.com |
| `POST` | `/api/games/sync` | Synchronize games from configured platform profiles |
| `PATCH` | `/api/games/{game_id}/platform` | Re-assign platform designation for a game |
| `DELETE` | `/api/games/{game_id}` | Delete completed game analysis |
| `DELETE` | `/api/games/pending/{game_id}` | Remove pending game from queue |
| `GET` | `/api/tags` | Retrieve all available tags with usage counts |
| **Analysis & Streaming** | | |
| `POST` | `/api/games/analyze` | Start background analysis job (Stockfish + LLM) |
| `GET` | `/api/jobs/{job_id}` | Check status of active analysis job |
| `GET` | `/api/jobs/{job_id}/stream` | Server-Sent Events (SSE) streaming analysis progress |
| `POST` | `/api/jobs/{job_id}/cancel` | Cancel running analysis job |
| **Analysis Details & Q&A** | | |
| `GET` | `/api/analysis/{analysis_id}` | Fetch analysis record by ID or canonical game key |
| `GET` | `/api/analysis/{analysis_id}/report-html` | Render styled report HTML with embedded SVGs |
| `POST` | `/api/analysis/{analysis_id}/ask-move` | Interactive move-level coaching Q&A |
| `POST` | `/api/analysis/{analysis_id}/append-qa` | Append Q&A chapter to report and auto-push to GitHub |
| `POST` | `/api/analysis/{analysis_id}/annotate-move` | On-demand verified AI move commentary with `✨ ` prefix |
| `POST` | `/api/analysis/{analysis_id}/pgn` | Update game PGN with user annotations and saved variations |
| **Export & Board Tools** | | |
| `GET` | `/api/analysis/{analysis_id}/export/pdf` | Download analysis report as styled PDF |
| `GET` | `/api/analysis/{analysis_id}/export/zip` | Download Markdown report and PNG diagrams as ZIP |
| `GET` | `/api/board` | Render standalone SVG board diagram from FEN |
| `GET` | `/api/llm/models` | List available models from configured LLM provider |
| **Openings Service** | | |
| `POST` | `/api/openings/identify` | Identify opening and continuations from moves/PGN |
| `GET` | `/api/openings/continuations` | Get candidate continuation branches from FEN |
| `GET` | `/api/openings/search` | Search opening names and ECO codes |
| **GitHub Sync** | | |
| `POST` | `/api/github/test-connection` | Verify GitHub repository PAT and push access |
| `POST` | `/api/github/sync/{analysis_id}` | Push single analysis to GitHub study repository |
| `POST` | `/api/github/sync-all` | Batch push all unsynced analyses to GitHub |
| `POST` | `/api/github/pull` | Pull all games from remote GitHub repository |
| `POST` | `/api/github/smart-pull` | Smart pull remote updates based on commit SHA |

### Module G: Bi-Directional GitHub Smart Sync (`src/github_sync.py`)

- **`GitHubSyncClient`**:
  - Uses the GitHub Git Data API (`/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`) for atomic multi-file commits.
  - Automatically initializes target repository branches with a default README if empty.
  - Implements exponential backoff retry for HTTP 422 fast-forward concurrency conflicts when multiple instances push simultaneously.
  - `delete_game(folder_path)`: Prunes entire game folder trees cleanly via replacement Git trees.
  - `list_remote_games_summary()`: Recursively scans repository trees to identify all synced game folders and file SHAs.
- **Smart Pull & Auto-Push Lifecycle:**
  - `get_latest_commit_sha()`: Fetches remote branch HEAD in 1 lightweight HTTP call.
  - Smart Pull verifies remote commit SHA against local `github_last_synced_sha`; downloads only when changes exist, skipping redundant blob fetches.
  - Completed game analyses and follow-up coaching Q&A additions automatically commit and push to the study repository.

### Module H: GitHub Direct Mode & Mobile PWA Reader (`frontend/src/lib/githubDirect.ts`)

- **Zero-Server Standalone Mode:**
  - Operates on GitHub Pages (`*.github.io`) without requiring a running FastAPI backend.
  - Directly queries the GitHub REST API (`api.github.com`) using a Personal Access Token stored securely in the browser's `localStorage` (`plyprose_direct_settings`).
  - Fetches repository tree and file blobs with in-memory SHA caching (`_blobCache`, `_rawBlobCache`, `clearBlobCache()`).
  - Reconstructs complete `AnalysisRecord` instances prioritizing `payload.json` and PGN header metadata over folder slug strings, with robust regex handling for player names containing hyphens or spaces.
  - Inlines relative SVG board diagrams (`./assets/diagram_N.svg` and `assets/diagram_N.svg`) as UTF-8 data URIs concurrently via `Promise.all` before parsing Markdown via `marked`.
  - Directly downloads pre-rendered `report.pdf` files from the study repository via `downloadGitHubDirectPdf()`.
- **Progressive Web App (PWA) & Mobile UX:**
  - Web App Manifest (`manifest.json`), touch PNG and SVG icons, `standalone` display mode, dark theme `#0f172a`, and mobile viewport optimization for home-screen installation on iOS and Android.
  - Service Worker (`sw.js`) caching core app shell and assets for offline PWA viewing.
  - GitHub Pages SPA routing fallback (`404.html`) preserving repository subpaths and deep navigation across page refreshes.
  - Streamlined Mobile Reader Settings: Automatically surfaces GitHub study repository configuration and connection testing, while suppressing desktop backend polling and collapsing non-applicable desktop engine settings.
  - Reader Move Q&A Fallback: Provides verified deterministic tactical engine explanations directly on mobile without remote LLM synthesis errors.
  - Mobile Report-First Default & View Switcher (`AnalysisPage.tsx`): On mobile (< 640px), entering an analysis page defaults to distraction-free reading mode (`report` mode) with the board closed. Tapping any played move, variation, or diagram in the narrative or selecting `Split` or `Board` smoothly opens the board. The 3-way view switcher (`[ 📖 Split | 📜 Report | ♟ Board ]`) lets users transition instantly.
  - Dual Evaluation Bar Layout (`InteractiveBoard.tsx`):
    - **Mobile Docked Split View (`isMobileDocked`):** Sleek vertical evaluation bar positioned alongside the right of the chessboard rather than horizontally below it. Consumes zero vertical height, freeing up ~36px and allowing docked board size to expand to 260px (an 18% increase in piece square size) while giving maximum vertical clearance to the narrative report below.
    - **Desktop Sidebar View (`!isMobileDocked`):** Full-width horizontal evaluation bar below the board with White initial pill `[W|`, center dynamic advantage label (`Equal Position 0.0`, `Clearly Better +1.8`, `Winning Attack +M2`) and score, and Black initial pill `|B]`.
  - Origin-Aware Stockfish 19 Web Worker Instantiation (`stockfishService.ts`): Resolves worker scripts via `getStockfishWorkerUrl()` using absolute origin/base paths (e.g. `/stockfish/stockfish-19-lite-single.js` or `/<repo>/stockfish/...` on GitHub Pages) rather than relative paths (`./stockfish/...`). Prevents SPA 404 HTML fallback syntax errors (`Unexpected token '<'`) when accessing deep routes like `/analysis/1`.
  - Lossless Report Diagram Rendering (`board_renderer.py`, `githubDirect.ts`, `github_sync.py`): Replaces board markers (`:::board`, legacy `{{BOARD}}`, `<!-- board: ... -->` comments, and relative `![...](./assets/diagram_N.svg)` markdown links) with base64 data-URI SVG `<figure class="board-figure" data-fen="...">` tags. Reconciles board positions from captions, PGN moves, and critical moments, ensuring reports display crisp, clickable chess diagrams across both backend and GitHub Direct modes on all browsers.
  - Integrated Header Controls on Mobile (`AnalysisPage.tsx`): Stockfish 19 live analysis toggle and settings icon button are embedded directly into the mobile view switcher bar when the board is active (`split` or `board` mode), cleanly hiding the redundant internal board header on mobile.
  - Dynamic Badge & Coordinate Scaling (`MoveBadgeGlyph.tsx`, `InteractiveBoard.tsx`, `index.css`): Move classification badges dynamically scale diameter (14px–24px) based on square size (`effectiveBoardSize / 8`), and board coordinates scale via CSS custom variable `--board-coord-size` (7px–11px), preventing badges from obscuring chess pieces on compact screens.
  - Remote Tag Synchronization & Direct Mode Tag Indexing (`api/main.py`, `githubDirect.ts`): Backend `/api/github/pull` automatically parses and reconciles coaching taxonomy tags from `report.md` when remote `payload.json` tags are empty, and GitHub Direct mode scans and caches folder metadata to display tags and populate available tag filter capsules without a backend server.
  - Dedicated Compact Mobile Header (`AnalysisPage.tsx`): Completely eliminates vertical element stacking on small screens (< 640px) with a streamlined 48px top bar (back navigation, truncated player matchup, outcome badge, PDF download, theme toggle, and collapsible details drawer). All secondary actions (opening details, tags, external game link, re-analysis) expand inside an on-demand drawer.
  - Zero-Overlap Guarantee: Keeps mobile headers strictly within standard document flow (`shrink-0`), removing floating absolute restore overlays on mobile screens to ensure ranks 7 and 8 of the chessboard, player info bars, and report text are 100% visible and accessible.
  - Responsive Mobile Games Card List (`GamesTable.tsx`): Touch-friendly card layout for small screens (< 640px) replacing wide 7-column desktop tables to eliminate horizontal scrolling.
  - Touch Ergonomics & Safe Areas: Primary chessboard navigation buttons adhere to Apple HIG and Google Material standards (≥38-44px hitboxes) with `overflow-x-auto` horizontally scrollable toolbars to fit narrow 360px viewports, board splitter touch dragging (`onTouchStart`/`onTouchMove`), and iOS notch/gesture bar safe area utilities (`pb-safe`, `pt-safe`).

### Module I: Frontend UI Architecture & Interactive Components

- **Tech Stack:** React 18+, TypeScript (`strict: true`), Vite, Tailwind CSS, Lucide React icons.
- **Key Components:**
  - `InteractiveBoard.tsx`: Main analysis interface integrating `@lichess-org/chessground` and browser-side **Stockfish 19 WASM**. Supports free-play exploration, auto-saved variations, live multi-PV arrows, move badges, opening continuations, docked mobile split mode, and touch drag-resizing.
  - `MoveContextMenu.tsx`: Context menu triggered via desktop right-click or mobile 450ms long-press on any move in the movelist. Provides Add/Edit Note, Annotate with AI, Delete Note, Delete variation, Delete from here, and Promote variation with boundary-aware viewport anchoring.
  - `InlineCommentEditor.tsx`: In-place inline textarea replacing comments in the movelist table with Enter-to-save and Esc-to-cancel, maintaining zero toolbar clutter and preserving board space.
  - `pgnWriter.ts`: Deterministic RFC-compliant standard PGN builder and parser (`buildAnnotatedPgn`, `extractCommentsAndClocksFromPgn`, `extractVariationsFromPgn`) ensuring comments `{ ... }` and variations `( ... )` remain 100% portable to Lichess, Chess.com, and ChessBase.
  - `EvaluationChart.tsx`: Centipawn trajectory chart across every ply with click-to-navigate integration.
  - `GamesTable.tsx`: Searchable, filterable game library table with responsive dual-view (desktop 7-column table with horizontal scroll, and touch-optimized card layout on mobile), tag capsules, platform badges, batch selection, and SSE analysis progress modals.
  - `MoveBadgeGlyph.tsx` & `badges.ts`: Visual move classification badges (Brilliant, Best Move, Inaccuracy, Mistake, Blunder, Missed Win, Checkmate).
  - `PlatformImportModal.tsx` & `ImportModal.tsx`: Platform batch synchronization and raw PGN ingestion.
  - `SyncModal.tsx`: GitHub study repository push and pull controls.
  - `TopNav.tsx`: Navigation header with theme toggle, GitHub Direct status indicator, and quick links.

---

## 4. Clean Code Standards & Verification Specification

### 4.1 Core Quality Principles & Operational Rules

- **Zero-Warning & Zero-Error Mandate:**
  - Both the backend test suite (`pytest`) and the frontend verification toolchain (`eslint`, `tsc`, `prettier`) must pass with **0 errors and 0 warnings**.
  - A task or change is **never complete** until both `./scripts/lint.sh` and `.venv/bin/pytest` succeed with zero warnings.
- **No Blind Rule or Warning Suppression:**
  - Agents and contributors must **never** add `filterwarnings = ["ignore:..."]` in `pyproject.toml` or `pytest.ini` to hide warnings.
  - Never insert `# noqa`, `# type: ignore`, or `/* eslint-disable */` comments simply to bypass linter checks.
  - Never demote linter rules from `"error"` to `"warn"` or `"off"` in `frontend/eslint.config.js` or `pyproject.toml`.
  - All issues must be resolved at their root cause in the application or test compatibility code.
- **Separation of Concerns:**
  - Keep pure domain models, chess analysis engine wrappers, and presentation layers strictly decoupled.
  - In the frontend, separate pure helper functions (e.g. [`frontend/src/lib/badges.ts`](frontend/src/lib/badges.ts)) from React components ([`frontend/src/components/Badge.tsx`](frontend/src/components/Badge.tsx)) to guarantee clean module boundaries and maintain React Fast Refresh support (`react-refresh/only-export-components`).
- **Strict Static Typing:**
  - Python: All functions, parameters, and return signatures require explicit type hints validated by `mypy` (`strict = true`) and linted by `ruff`.
  - TypeScript: Enforce `strict: true` with zero use of `any` (`@typescript-eslint/no-explicit-any: error`); use `unknown`, type narrowing, or explicit interfaces.
- **Exception Chaining & Async Hygiene:**
  - Python exception handling must always use explicit chaining (`raise HTTPException(...) from err`) to retain full diagnostic tracebacks.
  - Background asyncio tasks must maintain strong references (`_background_tasks.add(task)`) to prevent premature garbage collection.
- **React Hook & Effect Hygiene:**
  - Never call synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`) to avoid cascading re-renders.
  - Derive state during render when possible; execute state resets in user event handlers rather than reactive prop-syncing effects.
  - Use cleanup flags (`let ignore = false`) or `AbortController` in asynchronous effects to prevent state updates on unmounted components.

### 4.2 Testing Architecture & Standards

- **Comprehensive Test Coverage:** Every module in `src/` and endpoint in `api/` must have automated tests in `tests/` with deterministic assertions.
- **State Isolation:** All database and filesystem tests must use pytest's `tmp_path` fixture to ensure production databases (`outputs/history.db`) are never touched.
- **Hermetic Network Testing:** All external HTTP endpoints (Lichess API, Chess.com API, GitHub REST API) must be mocked using `httpx.MockTransport` or unit test patches.
- **Upstream Runtime Compatibility:** Upstream library deprecations (e.g. Python 3.14+ deprecation warnings from `chess.engine` or `google.genai`) must be resolved via clean compatibility shims in `tests/conftest.py`, not blanket warning filters.

### 4.3 Quality Toolchains

| Layer | Tools | Configurations |
| --- | --- | --- |
| **Python Backend** | `ruff` (linter + formatter), `mypy` (strict type checker) | `pyproject.toml` |
| **Python Testing** | `pytest` | `pyproject.toml`, `tests/conftest.py` |
| **Frontend UI** | `eslint`, `typescript-eslint`, `prettier` | `frontend/eslint.config.js`, `frontend/.prettierrc` |
| **Automation** | Bash verification scripts, `.pre-commit-config.yaml` | `scripts/lint.sh`, `scripts/format.sh`, `scripts/start.sh` |

### 4.4 Mandatory Verification Workflow

Before completing any task, execute:

1. `./scripts/lint.sh` (executes Ruff lint, Ruff format check, MyPy type check, ESLint, TypeScript check, Prettier check).
2. `.venv/bin/pytest` (all unit and integration tests must pass with 0 failures and 0 warnings).
3. `npm --prefix frontend run build` (guarantees production asset compilation succeeds).
4. `git commit` to ensure all changes, specs, and docs are cleanly tracked in version control.

### 4.5 Semantic Versioning Policy (`MAJOR.MINOR.PATCH`)

PlyProse follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`). All manifest declarations must remain synchronized across the codebase:

- `pyproject.toml` (`[project].version`)
- `api/main.py` (`app = FastAPI(title="PlyProse API", version="...")`)
- `src/__init__.py` (`__version__ = "..."`)
- `frontend/package.json` (`"version": "..."`)
- `frontend/package-lock.json` (`"version": "..."`)

- **PATCH (`x.y.Z`, e.g., `1.0.0` → `1.0.1`):** Bug fixes, internal logic adjustments, engine parsing corrections, test maintenance, styling tweaks, and non-breaking dependency updates.
- **MINOR (`x.Y.0`, e.g., `1.0.0` → `1.1.0`):** Backwards-compatible features, new chess platforms, new export formats, new REST endpoints, non-breaking schema additions, and new agent tools.
- **MAJOR (`X.0.0`, e.g., `1.0.0` → `2.0.0`):** Breaking REST API changes, incompatible SQLite schema migrations, foundational architecture shifts, or dropped runtime support (Python/Node).
