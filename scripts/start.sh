#!/usr/bin/env bash
set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OPEN_BROWSER=false
for arg in "$@"; do
  case "$arg" in
    --open|-o)
      OPEN_BROWSER=true
      ;;
  esac
done

API_PID=""
UI_PID=""

cleanup() {
  echo ""
  echo "Shutting down servers..."
  if [ -n "$API_PID" ] && kill -0 "$API_PID" 2>/dev/null; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [ -n "$UI_PID" ] && kill -0 "$UI_PID" 2>/dev/null; then
    kill "$UI_PID" 2>/dev/null || true
  fi
  wait "$API_PID" 2>/dev/null || true
  wait "$UI_PID" 2>/dev/null || true
  echo "All servers stopped."
}

trap cleanup INT TERM EXIT

echo "=================================================="
echo "🚀 Starting PlyProse Full Stack"
echo "=================================================="

# 1. Start Backend API
echo "Starting FastAPI backend on http://0.0.0.0:8000..."
"$REPO_ROOT/scripts/start_api.sh" &
API_PID=$!

# Wait briefly to let backend bind port
sleep 1

# 2. Start Frontend UI
echo "Starting Vite frontend on http://0.0.0.0:5173..."
"$REPO_ROOT/scripts/start_ui.sh" &
UI_PID=$!

if [ "$OPEN_BROWSER" = true ]; then
  (
    sleep 2
    if command -v explorer.exe >/dev/null 2>&1; then
      explorer.exe "http://localhost:5173" >/dev/null 2>&1 || true
    elif command -v cmd.exe >/dev/null 2>&1; then
      cmd.exe /c start "http://localhost:5173" >/dev/null 2>&1 || true
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://localhost:5173" >/dev/null 2>&1 || true
    fi
  ) &
fi

echo ""
echo "✨ Services are running:"
echo "   - Backend API: http://localhost:8000 (API Docs: http://localhost:8000/docs)"
echo "   - Frontend UI: http://localhost:5173"
echo "Press Ctrl+C to stop both servers."
echo ""

# Wait for both background processes
wait "$API_PID" "$UI_PID"
