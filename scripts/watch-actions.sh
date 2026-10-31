#!/usr/bin/env bash
# Acompanha o run mais recente do GitHub Actions em tempo real.
# Uso:
#   ./scripts/watch-actions.sh                  # último run de qualquer workflow
#   ./scripts/watch-actions.sh ranking          # último run do workflow "ranking"
#   ./scripts/watch-actions.sh backtest         # último run do workflow "backtest"

set -euo pipefail

WORKFLOW="${1:-}"

if [ -n "$WORKFLOW" ]; then
  RUN_ID=$(gh run list --workflow="${WORKFLOW}.yml" --limit=1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  if [ -z "$RUN_ID" ]; then
    RUN_ID=$(gh run list --workflow="${WORKFLOW}" --limit=1 --json databaseId -q '.[0].databaseId')
  fi
else
  RUN_ID=$(gh run list --limit=1 --json databaseId -q '.[0].databaseId')
fi

if [ -z "$RUN_ID" ]; then
  echo "Nenhum run encontrado${WORKFLOW:+ para '$WORKFLOW'}."
  exit 1
fi

echo "Run ID: $RUN_ID"
gh run watch "$RUN_ID" --exit-status
