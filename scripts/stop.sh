#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.local/context-ledger.pid"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE")"
  if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid"
    for _ in {1..40}; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then break; fi
      sleep 0.1
    done
    echo "Stopped ContextLedger web service."
  fi
  rm -f "$PID_FILE"
fi

"$ROOT_DIR/scripts/local-db.sh" stop
