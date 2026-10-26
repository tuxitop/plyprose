#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "=== Formatting Python code with Ruff ==="
.venv/bin/ruff format .
.venv/bin/ruff check --fix .

echo "=== Formatting Frontend code with Prettier & ESLint ==="
npm --prefix frontend run format
npm --prefix frontend run lint:fix

echo ""
echo "✨ All code formatted according to Clean Code rules!"
