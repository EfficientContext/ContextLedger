#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
LOCAL_DIR="$ROOT_DIR/.local"
PGDATA="$LOCAL_DIR/postgres"
LOG_FILE="$LOCAL_DIR/postgres.log"
PORT="${CONTEXT_LEDGER_POSTGRES_PORT:-55432}"
DB_MODE="${CONTEXT_LEDGER_DB_MODE:-auto}"

resolve_pg_bin() {
  if [[ -n "${PG_BIN:-}" && -x "$PG_BIN/postgres" ]]; then
    return 0
  fi
  if command -v brew >/dev/null 2>&1; then
    local brew_prefix
    brew_prefix="$(brew --prefix postgresql@17 2>/dev/null || true)"
    if [[ -n "$brew_prefix" && -x "$brew_prefix/bin/postgres" ]]; then
      PG_BIN="$brew_prefix/bin"
      return 0
    fi
  fi
  if command -v pg_config >/dev/null 2>&1; then
    local pg_bindir
    pg_bindir="$(pg_config --bindir 2>/dev/null || true)"
    if [[ -n "$pg_bindir" && -x "$pg_bindir/postgres" ]]; then
      PG_BIN="$pg_bindir"
      return 0
    fi
  fi
  return 1
}

if [[ "$DB_MODE" == "auto" ]]; then
  if resolve_pg_bin; then
    DB_MODE="local"
  elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DB_MODE="docker"
  else
    echo "ContextLedger needs Docker Compose or PostgreSQL 17." >&2
    echo "Easiest option: install Docker Desktop, then rerun context-ledger setup." >&2
    echo "macOS without Docker: brew install postgresql@17" >&2
    exit 1
  fi
elif [[ "$DB_MODE" == "local" ]]; then
  if ! resolve_pg_bin; then
    echo "CONTEXT_LEDGER_DB_MODE=local requires PostgreSQL 17." >&2
    exit 1
  fi
elif [[ "$DB_MODE" == "docker" ]]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    echo "CONTEXT_LEDGER_DB_MODE=docker requires Docker Compose." >&2
    exit 1
  fi
elif [[ "$DB_MODE" == "external" ]]; then
  :
else
  echo "Unknown CONTEXT_LEDGER_DB_MODE: $DB_MODE" >&2
  exit 2
fi

mkdir -p "$LOCAL_DIR"

init_cluster() {
  if [[ -f "$PGDATA/PG_VERSION" ]]; then
    return
  fi

  "$PG_BIN/initdb" -D "$PGDATA" -A trust --no-locale -E UTF8 >/dev/null
  "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOG_FILE" -o "-p $PORT -h 127.0.0.1" start
  "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -d postgres -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'contextledger_admin') THEN
    CREATE ROLE contextledger_admin LOGIN SUPERUSER PASSWORD 'contextledger_admin';
  END IF;
END
$$;
SQL
  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = 'contextledger'" | grep -q 1; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PORT" -O contextledger_admin contextledger
  fi
  PGPASSWORD=contextledger_admin "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U contextledger_admin -d contextledger \
    -v ON_ERROR_STOP=1 -f "$ROOT_DIR/infra/initdb/0001_app_role.sql"
}

case "${1:-}" in
  start)
    if [[ "$DB_MODE" == "external" ]]; then
      CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/scripts/db-probe.mjs"
    elif [[ "$DB_MODE" == "docker" ]]; then
      docker compose -f "$ROOT_DIR/docker-compose.yml" up -d postgres
      for _ in {1..80}; do
        if docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T postgres \
          pg_isready -U contextledger_admin -d contextledger >/dev/null 2>&1; then
          break
        fi
        sleep 0.25
      done
      docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T postgres \
        pg_isready -U contextledger_admin -d contextledger >/dev/null
    else
      init_cluster
      if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -d contextledger >/dev/null 2>&1; then
        if [[ -f "$PGDATA/postmaster.pid" ]]; then
          existing_pid="$(head -n 1 "$PGDATA/postmaster.pid" 2>/dev/null || true)"
          if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" >/dev/null 2>&1; then
            echo "PostgreSQL process $existing_pid exists but is not accepting connections on port $PORT." >&2
            echo "Run context-ledger stop, then context-ledger start. If that fails, inspect $LOG_FILE." >&2
            exit 1
          fi
        fi
        "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$LOG_FILE" -o "-p $PORT -h 127.0.0.1" start
      fi
    fi
    if [[ "$DB_MODE" == "external" ]]; then
      echo "External PostgreSQL is reachable."
    else
      echo "PostgreSQL ($DB_MODE): 127.0.0.1:$PORT"
    fi
    ;;
  stop)
    if [[ "$DB_MODE" == "external" ]]; then
      echo "External PostgreSQL is not managed by ContextLedger."
    elif [[ "$DB_MODE" == "docker" ]]; then
      docker compose -f "$ROOT_DIR/docker-compose.yml" stop postgres
    elif [[ -f "$PGDATA/postmaster.pid" ]]; then
      "$PG_BIN/pg_ctl" -D "$PGDATA" stop
    else
      echo "PostgreSQL 未运行"
    fi
    ;;
  status)
    if [[ "$DB_MODE" == "external" ]]; then
      CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/scripts/db-probe.mjs"
    elif [[ "$DB_MODE" == "docker" ]]; then
      docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T postgres \
        pg_isready -U contextledger_admin -d contextledger
    else
      "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PORT" -d contextledger
    fi
    ;;
  *)
    echo "用法: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
