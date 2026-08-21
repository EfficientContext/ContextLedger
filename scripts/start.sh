#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
NO_OPEN=0
FOREGROUND=0

usage() {
  cat <<'EOF'
Usage: context-ledger start [--no-open] [--foreground]

Start PostgreSQL, apply migrations, build the app, and start the web UI.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-open) NO_OPEN=1 ;;
    --foreground) FOREGROUND=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ ! -d "$ROOT_DIR/node_modules" ]]; then
  echo "Dependencies are missing. Run: context-ledger setup" >&2
  exit 1
fi

"$ROOT_DIR/scripts/local-db.sh" start
if [[ "${CONTEXT_LEDGER_RUN_MIGRATIONS:-true}" != "false" ]]; then
  CONTEXT_LEDGER_HOME="$ROOT_DIR" npm --prefix "$ROOT_DIR" run migrate >/dev/null
fi
CONTEXT_LEDGER_HOME="$ROOT_DIR" npm --prefix "$ROOT_DIR" run build >/dev/null

url="http://127.0.0.1:${PORT:-4318}"
if curl -fsS "$url/health" >/dev/null 2>&1; then
  echo "ContextLedger is already running: $url"
  if (( ! NO_OPEN )) && command -v open >/dev/null 2>&1; then
    open "$url"
  fi
  exit 0
fi

cd "$ROOT_DIR"
export CONTEXT_LEDGER_HOME="$ROOT_DIR"
if (( FOREGROUND )); then
  echo "ContextLedger: $url"
  echo "Press Ctrl-C to stop the web server. PostgreSQL stays running."
  exec node dist/src/interfaces/http/server.js
fi

mkdir -p "$ROOT_DIR/.local"
LOG_FILE="$ROOT_DIR/.local/context-ledger.log"
PID_FILE="$ROOT_DIR/.local/context-ledger.pid"
pid="$(node "$ROOT_DIR/scripts/launch-server.mjs")"
echo "$pid" >"$PID_FILE"

for _ in {1..80}; do
  if curl -fsS "$url/health" >/dev/null 2>&1; then
    echo "ContextLedger is running: $url"
    echo "Logs: $LOG_FILE"
    if (( ! NO_OPEN )) && command -v open >/dev/null 2>&1; then
      open "$url"
    fi
    exit 0
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    echo "ContextLedger failed to start. See $LOG_FILE" >&2
    exit 1
  fi
  sleep 0.25
done

echo "ContextLedger did not become ready. See $LOG_FILE" >&2
exit 1
