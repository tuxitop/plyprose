# PlyProse ♟️📖

> **Transforming every ply into prose.**  
> *Zero-hallucination chess narrative coaching powered by deterministic engine verification and LLM masterclass storytelling.*

---

## Overview

**PlyProse** is an automated, deep-dive chess coaching platform that bridges the gap between cold engine centipawn evaluations and intuitive human understanding. Rather than simply tagging moves as "blunder" or "mistake," PlyProse identifies pivotal psychological and tactical turning points, computes factual board states deterministically, and writes a rich, chapter-based narrative coaching masterclass tailored to your rating.

### Key Highlights
* **Zero-Hallucination Chess:** An LLM must never visualize a chessboard or calculate attackers in its head. All spatial relationships, hanging pieces, pins, material counts, and variations are deterministically computed via `python-chess` and Stockfish before being provided to the model.
* **Dual LLM Provider Support:**
  * **Google Gemini:** Direct integration with Gemini 2.5 Flash / Pro via the modern `google-genai` SDK with automatic tool calling (`verify_variation`, `inspect_square`).
  * **OpenAI-Compatible Endpoints:** Connect local or cloud inference providers (Ollama, LM Studio, llama.cpp, vLLM, OpenRouter, Groq) via the standard `openai` SDK with a manual tool-calling loop and graceful no-tools fallback.
* **Interactive Board & Live Engine:** Built with `@lichess-org/chessground` and browser-side **Stockfish 19 WASM**. Play through the game, click moves in the narrative report to jump to that moment, explore hypothetical variations in free-play mode, and analyze positions with live multi-PV arrows.
* **Evaluation Trajectory:** Visual graph showing evaluation swings across every ply, highlighting critical turning points and blunder recovery opportunities.
* **Platform Ingestion:** One-click fetching and batch synchronization from **Lichess** and **Chess.com**, as well as direct PGN pasting and file uploads.
* **Automated GitHub Study Repository:** Automatically commit your analyzed games, Markdown reports, metadata, and board diagrams directly into a dedicated GitHub repository.
* **Multi-Format Export:** Export reports to clean Markdown, standalone self-contained HTML with embedded vector SVGs, or publication-quality PDFs via **WeasyPrint**.

---

## Architecture

```
                       ┌────────────────────────────┐
                       │   Lichess / Chess.com /    │
                       │          Raw PGN           │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │     Stockfish Engine       │
                       │   (Centipawn / Mate / PV)  │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │     `python-chess`         │
                       │ (Deterministic Fact Sheet) │
                       │  - Hanging pieces / Pins   │
                       │  - Castling & Material     │
                       └─────────────┬──────────────┘
                                     │
                                     ▼
                       ┌────────────────────────────┐
                       │   LLM Coaching Dispatcher  │
                       │  (Gemini / OpenAI-Compat)  │
                       │  + Tool Verification Loop  │
                       └─────────────┬──────────────┘
                                     │
             ┌───────────────────────┴───────────────────────┐
             ▼                                               ▼
┌────────────────────────────┐                 ┌────────────────────────────┐
│      FastAPI Backend       │                 │   React + Vite Frontend    │
│  - REST + SSE Streaming    │◄───────────────►│  - Chessground + SF19 WASM │
│  - SQLite Storage          │                 │  - Interactive Report View │
│  - SVG/PNG/PDF Exporters   │                 │  - Eval Graph & Board Sync │
└────────────────────────────┘                 └────────────────────────────┘
```

---

## Prerequisites

1. **Python 3.11+**
2. **Node.js 18+** (Node 20+ recommended) and `npm`
3. **Stockfish Binary:** A locally installed Stockfish binary on your machine (e.g. `sudo apt install stockfish`, `brew install stockfish`, or downloaded from [stockfishchess.org](https://stockfishchess.org/download/)).
4. **Cairo & Pango (for PDF/PNG export):**
   * **Ubuntu/Debian:** `sudo apt install libcairo2 libpango-1.0-0 libpangocairo-1.0-0 libgdk-pixbuf2.0-0`
   * **macOS:** `brew install cairo pango gdk-pixbuf`
   * **Windows:** Follow GTK3/Cairo installation instructions for WeasyPrint.

---

## Development Setup

### 1. Clone & Set Up Python Environment

```bash
git clone https://github.com/your-username/plyprose.git
cd plyprose

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt
```

### 2. Set Up Frontend Environment

```bash
cd frontend
npm install
cd ..
```

### 3. Configure Environment Variables

Create a `.env` file at the root of the project (refer to [`.env.example`](.env.example)):

```bash
# Gemini API Key (get one free at https://aistudio.google.com/)
GEMINI_API_KEY="your-gemini-api-key"

# Path to your local Stockfish executable
STOCKFISH_PATH="/usr/games/stockfish" # or /usr/local/bin/stockfish, etc.

# Optional: Custom OpenAI-compatible endpoint (Ollama, LM Studio, etc.)
OPENAI_COMPAT_BASE_URL="http://localhost:11434/v1"
OPENAI_COMPAT_API_KEY="optional-or-not-needed"
OPENAI_COMPAT_MODEL="qwen2.5:latest"
```

*(Note: LLM providers, API keys, platforms, and usernames can also be configured and changed at runtime through the application's **Settings** page).*

---

## Running the Application

### Option A: Run Full Stack with One Command (Recommended)

Starts both the FastAPI backend (`:8000`) and the Vite frontend (`:5173`) simultaneously with coordinated graceful shutdown:

```bash
./scripts/start.sh
```

* **Frontend UI:** [http://localhost:5173](http://localhost:5173)
* **Backend API:** [http://localhost:8000](http://localhost:8000)
* **Interactive Swagger Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)

### Option B: Run Services Separately

In terminal 1 (Backend):
```bash
./scripts/start_api.sh
```

In terminal 2 (Frontend):
```bash
./scripts/start_ui.sh
```

---

## Clean Code & Quality Standards

PlyProse enforces an uncompromising Clean Code standard: **0 errors and 0 warnings** across both Python and TypeScript toolchains.

### Verification Commands

```bash
# Run all formatters, linters, type checkers across backend & frontend
./scripts/lint.sh

# Automatically format all Python (Ruff) and TypeScript/CSS (Prettier) code
./scripts/format.sh

# Run complete pytest test suite (100+ deterministic unit & integration tests)
.venv/bin/pytest
```

### Toolchain Stack
* **Python Backend:** `ruff` (linter & formatter), `mypy` (strict type checking), `pytest` (with hermetic mocking and `tmp_path` database isolation).
* **Frontend:** `eslint` (flat config), `@typescript-eslint` (strict mode, zero `any`), `eslint-plugin-react-hooks`, `prettier`.

---

## Production Deployment

### 1. Compile Frontend Assets

```bash
npm --prefix frontend run build
```
This produces an optimized production bundle in `frontend/dist/`.

### 2. Running FastAPI with Production ASGI Server

You can run Uvicorn with multiple workers behind an Nginx or Caddy reverse proxy:

```bash
source .venv/bin/activate
exec uvicorn api.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### 3. Reverse Proxy Configuration (Nginx Example)

```nginx
server {
    listen 80;
    server_name chess.yourdomain.com;

    # Serve compiled React frontend
    location / {
        root /path/to/plyprose/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # Proxy API and SSE streaming requests to FastAPI
    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Server-Sent Events (SSE) support for real-time progress
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
    }
}
```

### 4. Persistent Storage
Ensure the `outputs/` folder is persisted across container restarts or server deployments. It contains `outputs/history.db` (the SQLite analysis database) and cached reports.

---

## Credits & Acknowledgements

PlyProse is made possible by open-source chess and software engineering projects:

* **[python-chess](https://github.com/niklasf/python-chess)** by Niklas Fiekas: The bedrock library powering deterministic move validation, move generation, FEN generation, and board SVG rendering.
* **[Stockfish](https://stockfishchess.org/)**: The world's strongest chess engine, providing ground-truth positional evaluation and principal variations.
* **[Stockfish.js](https://github.com/nmrugg/stockfish.js)**: Stockfish compiled to WebAssembly, powering real-time client-side analysis directly in the browser.
* **[@lichess-org/chessground](https://github.com/lichess-org/chessground)** by Lichess: The gold-standard, buttery-smooth interactive chessboard UI.
* **[chess.js](https://github.com/jhlywa/chess.js)** by Jeff Hlywa: Client-side chess rules, PGN parsing, and move validation.
* **[Google Gemini](https://ai.google.dev/)** (`google-genai`): Modern generative AI models powering narrative coaching reports.
* **[FastAPI](https://fastapi.tiangolo.com/)** & **[Pydantic](https://docs.pydantic.dev/)** by Sebastián Ramírez: High-performance typed REST API and schema validation.
* **[WeasyPrint](https://weasyprint.org/)** & **[CairoSVG](https://cairosvg.org/)**: Document rendering engines for PDF exports and SVG conversion.
* **[Lucide Icons](https://lucide.dev/)**: Clean, modern iconography across the UI.

---

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

