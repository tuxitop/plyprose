# Project Context: PlyProse (Verified Chess Narrative Coach)

## Core Architecture Principle: Zero-Hallucination Chess
An LLM must NEVER mentally visualize a chessboard, guess legal moves, or count attackers/defenders in its head. 
All spatial, tactical, and engine facts MUST be computed deterministically via `python-chess` and Stockfish (`chess.engine`), serialized into structured JSON, and verified via tool calling.

---

## Clean Code & Engineering Standards for Agents

### 1. Zero-Warning & Zero-Error Policy
* Both the Python test suite (`pytest`) and the frontend verification toolchain (`eslint`, `tsc`, `prettier`) must run with **0 errors and 0 warnings**.
* A task or change is **NOT complete** until both `./scripts/lint.sh` and `pytest` report completely clean output with zero warnings.

### 2. Strict Prohibition on Warning & Rule Suppression
* **No Blind Filtering:** Never add `filterwarnings = ["ignore:..."]` in `pyproject.toml` or `pytest.ini` to sweep deprecations or warnings under the rug. Fix the root cause in the application or compatibility test harness directly.
* **No Suppression Comments:** Never insert `# noqa`, `# type: ignore`, or `/* eslint-disable */` merely to bypass checks. Only fix the code or refine typing contracts.
* **No Demoting Rules:** Do not demote linter rules from `"error"` to `"warn"` or `"off"` in `eslint.config.js` or `pyproject.toml`.

### 3. Proper Testing Standards
* **Comprehensive Coverage:** Every feature, service, or endpoint must be tested in `tests/` with deterministic assertions.
* **State Isolation:** Tests must use `tmp_path` fixtures for database creation to ensure `outputs/history.db` and local databases are never touched or modified during test runs.
* **Hermetic Network Testing:** All external HTTP calls (Lichess, Chess.com, GitHub API) must be mocked using `httpx.MockTransport` or unit test patches.
* **Compatibility Handoffs:** Upstream runtime deprecations (e.g., Python 3.14+ library changes in `chess.engine` or `google.genai`) must be cleanly handled via explicit compatibility fixtures in `tests/conftest.py`, not blanket warning filters.

### 4. Language & Architectural Boundaries
* **Backend (Python 3.11+):**
  * Strict type hints on all functions, parameters, and return signatures validated by `mypy` (`strict = true`).
  * Pydantic v2 schemas for all external boundaries, API requests, and responses.
  * Formatted and linted by `ruff` (PEP 8, import sorting, comprehension rules, modern language idioms).
  * Explicit Exception Chaining: Always chain exceptions (`raise HTTPException(...) from err`) to retain diagnostic tracebacks.
  * Async Task Lifecycle: Keep strong references to background asyncio tasks (`_background_tasks.add(task)`) to prevent premature garbage collection.
* **Frontend (React 18+ & TypeScript):**
  * Strict TypeScript (`strict: true`, zero `any` usage; use `unknown`, type narrowing, or specific interfaces).
  * **Separation of Concerns:** Keep pure helper utilities and data transformations in `frontend/src/lib/` (e.g. `lib/badges.ts`) rather than React component files (`components/Badge.tsx`) to guarantee clean module boundaries and React Fast Refresh support (`react-refresh/only-export-components`).
  * **React Hook & Effect Hygiene:**
    * Never call synchronous `setState` in effect bodies (`react-hooks/set-state-in-effect`).
    * Manage state resets and mutations in user event handlers rather than reactive prop-syncing effects.
    * Use cleanup flags (`let ignore = false`) or `AbortController` in async data-fetching effects to prevent state updates on unmounted components.
  * Deterministic formatting enforced by Prettier.
* **LLM SDKs:**
  * Use the modern `google-genai` SDK (`from google import genai` and `from google.genai import types`) for Gemini. Do NOT use the deprecated `google-generativeai` package.
  * For custom OpenAI-compatible endpoints, use the `openai` Python SDK with a configurable `base_url` and a manual tool-calling loop in `src/openai_agent.py`, routed through `src/llm.py`.

### 5. Semantic Versioning Policy (`MAJOR.MINOR.PATCH`)
PlyProse follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`). When updating the project version, ensure all manifest declarations remain synchronized across the codebase:
* `pyproject.toml` (`[project].version`)
* `api/main.py` (`app = FastAPI(title="PlyProse API", version="...")`)
* `src/__init__.py` (`__version__ = "..."`)
* `frontend/package.json` (`"version": "..."`)
* `frontend/package-lock.json` (`"version": "..."`)

#### How and When to Bump Versions:
* **PATCH (`x.y.Z`, e.g., `1.0.0` → `1.0.1`):**
  * **Bug Fixes:** Internal logic fixes, engine evaluation parsing corrections, corner-case crash resolutions.
  * **Refactoring & Performance:** Internal non-breaking optimizations, caching enhancements, database query indexing.
  * **Clean Code & Maintenance:** Linting fixes, typing contract enhancements, test harness maintenance, styling tweaks.
  * **Non-Breaking Dependency Updates:** Minor and patch dependency bumps that do not modify external API signatures.
* **MINOR (`x.Y.0`, e.g., `1.0.0` → `1.1.0`):**
  * **New Features (Backwards-Compatible):** Adding support for a new chess platform, new game import methods, new export formats (e.g., annotated PGN, EPUB), or new coaching chapters.
  * **API Extensions:** New non-breaking REST endpoints, optional request parameters, or supplemental response fields.
  * **UI/UX Additions:** New visual views (e.g., new charts, themes, player comparison tools, or interactive analysis widgets) that maintain existing navigation patterns.
  * **Agent Tools:** Introducing new deterministic inspection or verification tools available to the LLM agent.
* **MAJOR (`X.0.0`, e.g., `1.0.0` → `2.0.0`):**
  * **Breaking API Changes:** Removing or renaming REST endpoints, altering required request payloads, or breaking response schema structures.
  * **Database Schema Migrations:** Non-backwards-compatible schema changes to `outputs/history.db` requiring manual migration or data transformation.
  * **Foundational Architecture Changes:** Replacing the primary engine interface, overhaul of core LLM prompt/fact serialization contracts, or replacing backend/frontend frameworks.
  * **Platform Support Drops:** Dropping support for previously supported runtimes (e.g., Python 3.11 or Node 18).

### 6. Mandatory Verification Checklist
Before completing any task, execute:
1. `./scripts/lint.sh` (executes Ruff lint, Ruff format check, MyPy type check, ESLint, TypeScript check, Prettier check).
2. `.venv/bin/pytest` (all unit and integration tests must pass with 0 failures and 0 warnings).
3. `npm --prefix frontend run build` (guarantees production asset compilation succeeds).

---

## Directory Structure
- `SPEC.md`: Full specification of modules, schemas, workflows, and clean code standards.
- `prompts/system_coach.md`: The system instruction for the Gemini coaching agent.
- `src/models.py`: Pydantic schemas for GameData, TacticalFacts, CriticalMoment, and AnalysisPayload.
- `src/fetcher.py`: Public API clients for Lichess and Chess.com.
- `src/inspector.py`: Deterministic `python-chess` fact extractor (attackers, defenders, pins, castling rights, material).
- `src/analyzer.py`: Stockfish engine wrapper that identifies critical swings and attaches `TacticalFacts`.
- `src/coach_agent.py`: Gemini API integration with `verify_variation` and `inspect_square` automatic function-calling tools.
- `src/openai_agent.py`: OpenAI-compatible endpoint integration (configurable `base_url`) with the same tools via a manual function-calling loop and graceful no-tools retry.
- `src/llm.py`: Provider dispatcher routing report generation to Gemini or any OpenAI-compatible endpoint; builds provenance-prefixed model labels for history.
- `src/exporter.py`: Markdown and PDF report generator (with embedded SVG board diagrams).
- `api/`: FastAPI backend and REST endpoints (`scripts/start_api.sh`).
- `frontend/`: React/Vite/Tailwind frontend (`scripts/start_ui.sh`).
- `scripts/`: Dev startup and verification scripts:
  - `scripts/start.sh`: Starts both backend and frontend servers simultaneously with graceful shutdown.
  - `scripts/start_api.sh`: Starts the FastAPI development server.
  - `scripts/start_ui.sh`: Starts the Vite development server.
  - `scripts/lint.sh`: Complete Clean Code verification (Ruff, MyPy, ESLint, TypeScript, Prettier).
  - `scripts/format.sh`: Automated formatting for Python and TypeScript/CSS.
- `tests/`: Pytest test suite with Python 3.14+ compatibility harness in `tests/conftest.py`.
