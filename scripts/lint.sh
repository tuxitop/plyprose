#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== [1/5] Python: Ruff Linter ==="
.venv/bin/ruff check .

echo "=== [2/5] Python: Ruff Formatter Check ==="
.venv/bin/ruff format --check .

echo "=== [3/5] Python: MyPy Static Type Check ==="
.venv/bin/mypy src api

echo "=== [4/5] Frontend: ESLint & TypeScript Type Check ==="
npm --prefix frontend run lint
npm --prefix frontend run typecheck

echo "=== [5/5] Frontend: Prettier Formatting Check ==="
npm --prefix frontend run format:check

echo ""
echo "✨ All Clean Code and syntax checks passed cleanly!"
