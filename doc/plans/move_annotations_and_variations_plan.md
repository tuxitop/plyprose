# Implementation Plan: Move & Variation Annotations, Context Menus, and Upfront AI Commentary

## Goal Description
Enhance PlyProse with a chess-native annotation and variation workflow matching major platforms (Lichess, Chess.com, ChessBase):
1. **Right-Click (Desktop) & Long-Press (Mobile) Context Menus** on movelist moves for note editing, AI annotation, and variation management without adding toolbar clutter.
2. **In-Place Inline Note Editor:** Clicking "Add/Edit Note" transforms the comment area directly in the movelist into an inline textarea with Save/Cancel—zero disruptive modals or overlays.
3. **Always-Visible Comments:** Persistent display in the movelist:
   - Full-width blockquote row underneath move pairs for mainline moves.
   - Inline bracketed text `{ ... }` inside variations.
4. **Standard PGN Specification:** Both user notes and AI comments are stored directly in standard PGN `{ ... }` comments and `( ... )` variations. AI comments use plain text with a `✨ ` prefix, remaining 100% portable to any chess app or website.
5. **Upfront AI Move Commentary:** In the initial game analysis, the AI coach annotates 4–8 pivotal mainline moves (including at least one opening improvement area) plus moves in variations as needed.
6. **Auto-Saved Variations & Hybrid Persistence:** Any variation played on the board remains saved in the game's move tree unless deleted. Instant local saving to browser storage and backend SQLite; debounced 15s / page exit auto-commit in GitHub Direct mode.

---

## User Review Required

> [!IMPORTANT]
> **Zero Toolbar Clutter & In-Place Editing:** No extra buttons, toolbars, or modal overlays will be added. Actions are triggered via contextual **Right-Click** (desktop) or **Long-Press (450ms)** (mobile) on the move pill. Editing comments happens **in-place** directly within the movelist row.

> [!IMPORTANT]
> **Auto-Saved Variations:** Move variations played on the board are retained permanently in the game's PGN / move tree unless explicitly deleted via the context menu (**"Delete from here"** or **"Delete variation"**).

---

## Architecture & Data Flow

```mermaid
flowchart TD
    subgraph UI ["InteractiveBoard & MoveList"]
        MovePill["Move Pill (Mainline or Variation)"]
        ContextMenu["Context Menu<br/>(Desktop Right-Click / Mobile 450ms Long-Press)"]
        InlineEditor["In-Place Inline Textarea<br/>(Replaces comment row in movelist)"]
        
        MovePill -->|Right-Click / Long-Press| ContextMenu
        ContextMenu -->|Add / Edit Note| InlineEditor
        ContextMenu -->|Annotate with AI| AskAI["POST /api/coach/annotate-move"]
        ContextMenu -->|Delete / Truncate / Promote| VarTree["Variation Tree Manager"]
        InlineEditor -->|Save (Enter/Blur)| VarTree
    end

    subgraph State ["Client State & PGN Serialization"]
        VarTree -->|Auto-Merge| PGNBuilder["Standard PGN Builder<br/>1. e4 { ✨ Note } (1... c5 { Sicilian })"]
    end

    subgraph Persistence ["Hybrid Auto-Save Layer"]
        PGNBuilder -->|Instant Save| LocalStore["localStorage / IndexedDB Cache"]
        LocalStore -->|Local Server Mode| APISave["POST /api/games/{id}/pgn"]
        APISave --> SQLite[("outputs/history.db & game.pgn")]
        
        LocalStore -->|GitHub Direct Mode (15s idle debounce)| GHCommit["GitHub Git Data API<br/>(Commit updated game.pgn)"]
        GHCommit --> GHRepo[("GitHub Private Study Repo")]
    end
```

---

## Proposed Changes

### Component 1: Data Models & PGN Tree Manager (`src/models.py`, `src/storage.py`, `src/analyzer.py`)

#### [MODIFY] `src/models.py`
Add schemas for move-level annotations and PGN synchronization:
```python
class MoveAnnotation(BaseModel):
    ply: int
    san: str
    comment: str
    is_ai: bool = False
    created_at: str | None = None


class UpdatePgnRequest(BaseModel):
    pgn: str
    annotations: list[MoveAnnotation] = Field(default_factory=list)
```

#### [MODIFY] `src/storage.py`
Add `update_game_pgn(game_id: str, new_pgn: str)` to atomically update:
1. SQLite `games` table in `outputs/history.db` (`pgn` column).
2. On-disk `outputs/{game_key}/game.pgn`.

---

### Component 2: AI Upfront Commentary & Single-Move Annotation (`prompts/system_coach.md`, `src/coach_agent.py`, `src/openai_agent.py`)

#### [MODIFY] `prompts/system_coach.md`
Add explicit prompt directive:
- Instruct the coach agent to provide concise, 1-sentence annotations on **4–8 pivotal mainline moves** (including at least one opening improvement area).
- Where variations are recommended, allow concise 1-sentence comments explaining key alternative moves inside the variations.
- Format upfront move annotations in a structured `### Move Annotations` section or directly inside the critical moments table so they can be parsed and embedded as `{ ✨ ... }` in the initial game PGN.

#### [MODIFY] `src/coach_agent.py` & `src/openai_agent.py`
- Parse upfront move annotations generated during report creation and weave them into the game's PGN using `python-chess`.
- Add `annotate_single_move_prompt(...)` for on-demand annotation of any arbitrary move requested via the context menu.

---

### Component 3: Backend REST Endpoints (`api/main.py`)

#### [MODIFY] `api/main.py`
1. **`POST /api/games/{game_id}/pgn`**:
   - Validates updated PGN syntax using `python-chess`.
   - Persists updated PGN to SQLite and triggers background GitHub sync if configured.
2. **`POST /api/coach/annotate-move`**:
   - Input: `{ game_id: str, ply: int, san: str }`.
   - Reconstructs FEN, extracts `TacticalFacts`, runs engine verification, prompts LLM for a 1-sentence verified note, and returns `{ comment: "✨ <note>" }`.

---

### Component 4: Move List Context Menu & In-Place Editing (`frontend/src/`)

#### [NEW] `frontend/src/components/MoveContextMenu.tsx`
Context menu component positioned at cursor (desktop right-click) or anchored above touch target (mobile long-press):
- **💬 Add Note / Edit Note**
- **✨ Annotate with AI**
- **🗑️ Delete Note** (only if move has a comment)
- **✂️ Delete from here** (active when inside a variation)
- **❌ Delete variation** (active when inside a variation)
- **⭐ Promote variation** (swaps variation with parent line / mainline)

#### [MODIFY] `frontend/src/components/InteractiveBoard.tsx`
1. **Event Listeners for Right-Click & Mobile Long-Press:**
   - Attach `onContextMenu` (prevents browser default, opens custom context menu).
   - Attach touch handlers (`onTouchStart`, `onTouchMove`, `onTouchEnd`) with a `450ms` timer for long-press on mobile.
2. **In-Place Inline Note Editor:**
   - When "Add Note" or "Edit Note" is selected (or user clicks an existing comment), the comment block turns into an inline `<textarea>` in the move list row.
   - Includes compact "Save" / "Cancel" controls (or Enter to save, Shift+Enter for newline, Esc to cancel).
3. **Always-Visible Comments in Move List:**
   - Mainline moves: Rendered as a full-width blockquote row directly underneath the move pair.
   - Variations: Rendered as inline bracketed text `{ ... }` within the indented variation stream.
4. **Persistent Auto-Saved Variations:**
   - Variations played on the board are retained in `savedVariations` state.
   - Standard tree operations:
     - *Delete variation:* removes variation branch from state.
     - *Delete from here:* truncates variation from the target move index.
     - *Promote variation:* promotes branch to mainline / parent line.
5. **PGN Serializer & Auto-Sync:**
   - Serializes comments and variations into standard PGN.
   - Instant local storage cache save.
   - In local mode: debounced `POST /api/games/{id}/pgn`.
   - In GitHub Direct mode: debounced 15s auto-commit via `githubDirect.ts`.

#### [MODIFY] `frontend/src/lib/githubDirect.ts`
Add debounced commit helper `saveAnnotatedPgnDirect(gameFolder: string, newPgn: string)`:
- Pushes updated `game.pgn` to GitHub with commit message: `Annotate moves: <game_title>`.
- Displays subtle syncing indicator `● Syncing to GitHub...` / `✓ Synced`.

---

## Verification Plan

### Automated Tests
1. **Model, Storage & PGN Tests:**
   ```bash
   .venv/bin/pytest tests/test_storage.py tests/test_fetcher.py
   ```
   - Verify `update_game_pgn` updates SQLite records and preserves PGN headers.
   - Verify PGN comment `{ ... }` and RAV variation `( ... )` serialization.
2. **AI Annotation Endpoint Tests:**
   ```bash
   .venv/bin/pytest tests/test_coach_agent.py tests/test_api_games.py
   ```
   - Test `POST /api/coach/annotate-move` returns valid, verified commentary with `✨ ` prefix.
3. **Frontend Verification & Type Checking:**
   ```bash
   ./scripts/lint.sh
   npm --prefix frontend run build
   ```
   - Zero lint errors, zero warnings, TypeScript compilation passes cleanly.

### Manual Verification
1. **Desktop Right-Click Context Menu:**
   - Right-click move 14 in movelist -> select "Add Note" -> type note inline -> press Save -> verify comment displays as a blockquote row underneath the move.
2. **Mobile Long-Press:**
   - On mobile view (< 640px), touch and hold a move for 450ms -> verify context menu opens cleanly at the touch location without layout shift.
3. **Persistent Variations & Variation Management:**
   - Play a 3-move variation on the board -> return to mainline -> verify the variation line stays in the move list.
   - Right-click move 2 in the variation -> select "Delete from here" -> verify move 2 and 3 are removed, move 1 is kept.
   - Right-click move 1 -> select "Delete variation" -> verify variation is removed.
4. **On-Demand AI Annotation:**
   - Right-click any move -> select "Annotate with AI" -> verify `✨ <concise explanation>` appears inline and can be edited.
5. **Portability Check:**
   - Copy the exported PGN -> paste into Lichess Analysis / Chess.com -> verify all comments and variations open correctly.
