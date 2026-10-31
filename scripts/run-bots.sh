#!/usr/bin/env bash
# Runs the orchestrator outside Docker and restarts it if it exits (crash or kill).
# Usage: scripts/run-bots.sh   (from the repo root; loads .env, talks to localhost server + Ollama)
# Stop:  pkill -f run-bots.sh; pkill -f "^node dist/index.js"
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a
export OLLAMA_BASE_URL="${OLLAMA_LOCAL_URL:-http://localhost:11434}" MC_HOST=localhost RCON_HOST=localhost
mkdir -p logs
while true; do
  node dist/index.js >> logs/orchestrator.out 2>&1
  code=$?
  echo "$(date +%T) WARN  [supervisor] orchestrator exited with code $code; restarting in 5s" >> logs/orchestrator.out
  sleep 5
done
