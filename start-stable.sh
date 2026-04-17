#!/bin/bash
# Stable CPM startup: Vite (hot-reload frontend) + Node (stable backend)
# Backend only restarts when the "Restart CPM" button is clicked.
# Vite stays running across backend restarts.
cd "$(dirname "$0")"

# Ensure compiled server uses the same DB as dev mode
export DATABASE_PATH="$(pwd)/data/cpm.db"

# Initial server build
echo "[cpm] Building server..."
npm run build:server

# Start Vite in background (survives backend restarts)
npx vite &
VITE_PID=$!
trap "kill $VITE_PID 2>/dev/null" EXIT

# Loop the backend — restarts when process.exit() is called (via Restart CPM button)
while true; do
  echo "[cpm] Starting server..."
  node dist/server/index.js
  EXIT_CODE=$?
  echo "[cpm] Server exited (code $EXIT_CODE), restarting in 1s..."
  sleep 1
done
