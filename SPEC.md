# PlyProse — Software Design & Specification Document (SDD)

## 1. System Overview
A local web application that fetches a user's chess games from Lichess or Chess.com (or accepts raw PGN), analyzes the game locally using Stockfish and `python-chess` to build a 100% verified JSON fact sheet, and uses Gemini (`gemini-2.5-pro` / `gemini-2.5-flash`) with Function Calling to generate an accurate, chapter-based narrative coaching report exportable to Markdown and PDF.

---

## 2. Data Schemas (`src/models.py`)

```python
from pydantic import BaseModel, Field
from typing import List, Optional, Dict


class PieceInteraction(BaseModel):
    square: str
    piece: str  # e.g., "Black bishop on e7"
    attackers: List[str]  # e.g., ["White queen on e5", "White rook on e1"]
    defenders: List[str]  # e.g., ["Black queen on d8", "Black king on e8"]
    is_pinned: bool
    pinned_to: Optional[str] = None  # e.g., "e8"


class TacticalFacts(BaseModel):
    fen: str
    turn: str  # "White" or "Black"
    move_number: int
    is_check: bool
    legal_castling: Dict[str, bool]
    material_count: Dict[str, int]  # {"White": 39, "Black": 39}
    piece_placement: Dict[str, List[str]]  # {"White": ["Qe5", "Rd1", ...], "Black": [...]}
    attacked_or_pinned_pieces: List[PieceInteraction]
    hanging_pieces: List[str]  # Pieces where len(attackers) > 0 and len(defenders) == 0


class CriticalMoment(BaseModel):
    ply: int
    move_number: int
    color: str
    move_played_san: str
    eval_before_cp: Optional[int]  # From White's perspective
    eval_after_cp: Optional[int]
    mate_before: Optional[int]
    mate_after: Optional[int]
    classification: str  # "Inaccuracy", "Mistake", "Blunder", "Critical Turning Point"
    best_move_san: str
    pv_san: List[str]  # Top engine continuation (up to 6 plies)
    facts_before_move: TacticalFacts
    facts_after_played_move: TacticalFacts
    facts_after_best_move: TacticalFacts
    facts_at_end_of_pv: TacticalFacts


class GameAnalysisPayload(BaseModel):
    white_player: str
    black_player: str
    user_color: str  # "White", "Black", or "Both"
    result: str
    time_control: str
    opening_name: Optional[str]
    pgn_moves_summary: str
    total_plies: int
    critical_moments: List[CriticalMoment]
```

---

## 3. Module Specifications

### Module A: `src/fetcher.py`

* **`fetch_lichess_games(username: str, max_games: int = 10) -> List[dict]`**
* Endpoint: `GET https://lichess.org/api/games/user/{username}?max={max_games}&pgnInJson=true&opening=true`
* Headers: `Accept: application/x-ndjson`
* Returns list of dicts: `{"id", "white", "black", "date", "result", "time_control", "pgn"}`.


* **`fetch_chesscom_games(username: str, max_games: int = 10) -> List[dict]`**
* Step 1: `GET https://api.chess.com/pub/player/{username}/games/archives` (with custom `User-Agent` header as required by Chess.com).
* Step 2: Fetch the most recent monthly archive JSON, extract the last `max_games` items containing `"pgn"`, and normalize to the same dictionary structure.



### Module B: `src/inspector.py`

* **`extract_tactical_facts(board: chess.Board) -> TacticalFacts`**
* Iterates over `board.piece_map()`.
* Uses `board.attackers(color, square)` to list every attacker and defender with explicit piece type and square name (e.g., `"Black queen on d8"`).
* Uses `board.is_pinned(color, square)` and `board.pin(color, square)` to detect absolute pins to the King.
* Identifies hanging pieces (`len(attackers) > 0 and len(defenders) == 0`).


* **`verify_variation_tool(fen: str, san_moves: List[str]) -> dict`**
* Callable tool for Gemini. Instantiates `chess.Board(fen)`, validates and pushes each move in `san_moves` one by one.
* If any move is illegal, immediately returns `{"valid": False, "illegal_move": move_str, "legal_moves_sample": [...]}`.
* If valid, returns `{"valid": True, "resulting_facts": extract_tactical_facts(board).model_dump()}`.



### Module C: `src/analyzer.py`

* **`analyze_pgn(pgn_str: str, stockfish_path: str, user_color: str = "Both", time_per_move: float = 0.15) -> GameAnalysisPayload`**
* Parses the PGN via `chess.pgn.read_game()`.
* Runs Stockfish via `chess.engine.SimpleEngine.popen_uci(stockfish_path)`.
* Evaluates every position. When the centipawn swing against the moving side is `>= 80` cp (or a mate status changes), records a `CriticalMoment`.
* Populates `facts_before_move`, `facts_after_played_move`, `facts_after_best_move`, and `facts_at_end_of_pv` using `extract_tactical_facts`.



### Module D: `src/coach_agent.py`

* **`generate_narrative_report(payload: GameAnalysisPayload, model_name: str = "gemini-2.5-pro") -> str`**
* Loads system prompt from `prompts/system_coach.md`.
* Passes `verify_variation_tool` inside `GenerateContentConfig(tools=[verify_variation_tool], temperature=0.2)`.
* Instructs Gemini to rely strictly on the provided `GameAnalysisPayload` JSON and call `verify_variation_tool` whenever it discusses any line not already fully expanded in `CriticalMoment`.


### Module D2: `src/openai_agent.py` & `src/llm.py`

* **`generate_narrative_report(payload, model_name, base_url, api_key, tools_enabled=True, max_turns=8) -> str`** (`openai_agent.py`)
* Works with any OpenAI-compatible endpoint (OpenAI, Ollama `/v1`, LM Studio, llama.cpp, vLLM, OpenRouter, Groq) via the `openai` SDK with configurable `base_url`.
* Shares the same system prompt (`prompts/system_coach.md`), user prompt, and deterministic tools (`verify_variation_tool`, `inspect_square`) as the Gemini agent; tool schemas are hand-written OpenAI function JSON schemas.
* Implements a manual tool-calling loop (no automatic function calling in the OpenAI SDK): executes tool calls against `TOOL_REGISTRY`, returns tool results as `role=tool` messages, capped at `max_turns`.
* If the server rejects requests containing `tools`, retries once without tools and prepends a note that model-initiated variation verification was disabled (the model still receives the full deterministic `GameAnalysisPayload` JSON, so grounding survives).
* Falls back to the same verified deterministic summary on unreachable endpoints or empty responses.

* **`generate_narrative_report(payload, provider, model_name, api_key, base_url, client) -> str`** (`llm.py`)
* Provider dispatcher: routes `"gemini"` to `coach_agent` and `"openai-compat"` to `openai_agent`.
* `model_label(provider, model_name) -> str` builds provenance-prefixed labels stored in history, e.g. `gemini:gemini-2.5-pro`, `openai-compat:gpt-4o-mini` (stored in the existing `model_name` column, no schema change).



### Module E: `src/exporter.py` & UI

* **`exporter.py`**:
* `render_critical_svgs(payload: GameAnalysisPayload) -> Dict[int, str]`: Uses `chess.svg.board()` to render board diagrams for each critical moment.
* `inline_svg_uses(svg: str) -> str`: Expands every `<use href="#id">` reference into an inline copy of the referenced glyph. Required because HTML sanitizers (like DOMPurify) strip `<use>`, and `python-chess` draws each piece as a `<use>` element.
* `build_board_html_document(svg: str, size: int) -> str`: Wraps a board SVG into a standalone HTML document rendered inside an iframe or standalone view (unsanitized).
* `markdown_to_pdf(md_text: str, output_path: str) -> bytes`: Converts the Markdown report to styled HTML and renders a clean PDF via `weasyprint`.


* **Web Architecture (`api/` and `frontend/`)**:
* Backend: FastAPI application (`api/main.py`) exposing REST endpoints for game analysis, history, PGN parsing, and LLM configuration.
* Frontend: React/Vite/Tailwind single-page application (`frontend/`) with interactive chessboard, critical moment viewer, analysis controls, and PDF/Markdown report export.

---

## 4. Clean Code Standards & Verification Specification

### 4.1 Core Quality Principles & Operational Rules
* **Zero-Warning & Zero-Error Mandate:**
  * Both the backend test suite (`pytest`) and the frontend verification toolchain (`eslint`, `tsc`, `prettier`) must pass with **0 errors and 0 warnings**.
  * A task or change is **never complete** until both `./scripts/lint.sh` and `.venv/bin/pytest` succeed with zero warnings.
* **No Blind Rule or Warning Suppression:**
  * Agents and contributors must **never** add `filterwarnings = ["ignore:..."]` in `pyproject.toml` or `pytest.ini` to hide warnings.
  * Never insert `# noqa`, `# type: ignore`, or `/* eslint-disable */` comments simply to bypass linter checks.
  * Never demote linter rules from `"error"` to `"warn"` or `"off"` in `frontend/eslint.config.js` or `pyproject.toml`.
  * All issues must be resolved at their root cause in the application or test compatibility code.
* **Separation of Concerns:** 
  * Keep pure domain models, chess analysis engine wrappers, and presentation layers strictly decoupled.
  * In the frontend, separate pure helper functions (e.g. [`frontend/src/lib/badges.ts`](frontend/src/lib/badges.ts)) from React components ([`frontend/src/components/Badge.tsx`](frontend/src/components/Badge.tsx)) to ensure clean module boundaries and maintain React Fast Refresh support (`react-refresh/only-export-components`).
* **Strict Static Typing:**
  * Python: All functions, parameters, and return signatures require explicit type hints validated by `mypy` and linted by `ruff`.
  * TypeScript: Enforce `strict: true` with zero use of `any` (`@typescript-eslint/no-explicit-any: error`); use `unknown`, type narrowing, or explicit interfaces.
* **Exception Chaining & Async Hygiene:**
  * Python exception handling must always use explicit chaining (`raise HTTPException(...) from err`) to retain full diagnostic tracebacks.
  * Background asyncio tasks must maintain strong references (`_background_tasks.add(task)`) to prevent garbage collection during execution.
* **React Hook & Effect Hygiene:**
  * Never call synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`) to avoid cascading re-renders.
  * Derive state during render when possible; execute state resets in user event handlers rather than reactive prop-syncing effects.
  * Use cleanup flags (`let ignore = false`) or `AbortController` in asynchronous effects to prevent state updates on unmounted components.

### 4.2 Testing Architecture & Standards
* **Comprehensive Test Coverage:** Every module in `src/` and endpoint in `api/` must have automated tests in `tests/`.
* **State Isolation:** All database and filesystem tests must use pytest's `tmp_path` fixture to ensure production databases (`outputs/history.db`) are never touched.
* **Hermetic Network Testing:** All external HTTP endpoints (Lichess API, Chess.com API, GitHub REST API) must be mocked using `httpx.MockTransport` or unit test patches.
* **Upstream Runtime Compatibility:** Upstream library deprecations (e.g. Python 3.14+ deprecation warnings from `chess.engine` or `google.genai`) must be resolved via clean compatibility shims in `tests/conftest.py`, not blanket warning filters.

### 4.3 Quality Toolchains

| Layer | Tools | Configurations |
|---|---|---|
| **Python Backend** | `ruff` (linter + formatter), `mypy` (type checker) | `pyproject.toml` |
| **Python Testing** | `pytest` | `pyproject.toml`, `tests/conftest.py` |
| **Frontend UI** | `eslint`, `typescript-eslint`, `prettier` | `frontend/eslint.config.js`, `frontend/.prettierrc` |
| **Automation** | Bash verification scripts, `.pre-commit-config.yaml` | `scripts/lint.sh`, `scripts/format.sh`, `scripts/start.sh` |

### 4.4 Verification Workflow
1. **Full Verification:** Execute `./scripts/lint.sh` to validate Ruff, MyPy, ESLint, TypeScript, and Prettier checks (must pass with 0 errors, 0 warnings).
2. **Automated Formatting:** Execute `./scripts/format.sh` to apply formatters automatically.
3. **Automated Test Suite:** Execute `.venv/bin/pytest` to verify all unit and integration tests (must pass with 0 failures, 0 warnings).
4. **Local Development:** Execute `./scripts/start.sh` to run both backend and frontend servers with coordinated lifecycle management.

### 4.5 Semantic Versioning Policy (`MAJOR.MINOR.PATCH`)
PlyProse follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`). All manifest declarations must remain synchronized:
* `pyproject.toml` (`[project].version`)
* `api/main.py` (`app = FastAPI(title="PlyProse API", version="...")`)
* `src/__init__.py` (`__version__ = "..."`)
* `frontend/package.json` (`"version": "..."`)
* `frontend/package-lock.json` (`"version": "..."`)

* **PATCH (`x.y.Z`, e.g., `1.0.0` → `1.0.1`):** Bug fixes, internal logic adjustments, engine parsing corrections, test maintenance, styling tweaks, and non-breaking dependency updates.
* **MINOR (`x.Y.0`, e.g., `1.0.0` → `1.1.0`):** Backwards-compatible features, new chess platforms, new export formats, new REST endpoints, non-breaking schema additions, and new agent tools.
* **MAJOR (`X.0.0`, e.g., `1.0.0` → `2.0.0`):** Breaking REST API changes, incompatible SQLite schema migrations, foundational architecture shifts, or dropped runtime support (Python/Node).



