#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_ENV="$ROOT_DIR/.env.example"
INSTALL_DEPS=1
INSTALL_SKILLS=1
CONNECT_AGENTS=1
START_APP=1
DATABASE_URL_ARG=""
MIGRATION_DATABASE_URL_ARG=""
TENANT_ARG=""
EMAIL_ARG=""
DB_MODE_ARG=""

usage() {
  cat <<'EOF'
Usage: context-ledger setup [options]

Prepare a local ContextLedger installation.

Options:
  --no-install     Skip npm install
  --no-skills      Skip local report-skill installation
  --no-connect     Do not configure detected Codex or Claude Code clients
  --no-start       Prepare the app without starting the web server
  --database-url URL
                   Use an existing PostgreSQL database
  --migration-database-url URL
                   Admin URL for schema migration and team management
  --tenant SLUG    Tenant to use
  --email EMAIL    User identity for this installation
  --db-mode MODE   auto, local, docker, or external
  -h, --help       Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) INSTALL_DEPS=0 ;;
    --no-skills) INSTALL_SKILLS=0 ;;
    --no-connect) CONNECT_AGENTS=0 ;;
    --no-start) START_APP=0 ;;
    --database-url) DATABASE_URL_ARG="${2:?Missing value for --database-url}"; shift ;;
    --migration-database-url) MIGRATION_DATABASE_URL_ARG="${2:?Missing value for --migration-database-url}"; shift ;;
    --tenant) TENANT_ARG="${2:?Missing value for --tenant}"; shift ;;
    --email) EMAIL_ARG="${2:?Missing value for --email}"; shift ;;
    --db-mode) DB_MODE_ARG="${2:?Missing value for --db-mode}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it first, then rerun context-ledger setup." >&2
  exit 1
fi

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "Node.js 22+ is required. Found $(node -v)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$EXAMPLE_ENV" "$ENV_FILE"
  echo "Created $ENV_FILE"
fi

if (( INSTALL_DEPS )); then
  echo "Installing Node dependencies..."
  npm --prefix "$ROOT_DIR" install
  source_command="$ROOT_DIR/bin/context-ledger"
  if (cd "$ROOT_DIR" && npm link --force >/dev/null 2>&1); then
    echo "Installed the context-ledger and ctx commands."
  else
    USER_BIN="$HOME/.local/bin"
    mkdir -p "$USER_BIN"
    ln -sf "$source_command" "$USER_BIN/context-ledger"
    ln -sf "$source_command" "$USER_BIN/ctx"
    echo "Installed context-ledger and ctx in $USER_BIN."
    case ":$PATH:" in
      *":$USER_BIN:"*) ;;
      *)
        echo "Add this once to your shell profile:"
        echo "  export PATH=\"$USER_BIN:\$PATH\""
        ;;
    esac
  fi
fi

if (( INSTALL_SKILLS )); then
  "$ROOT_DIR/scripts/install-writer-skills.sh"
fi

CONTEXT_LEDGER_HOME="$ROOT_DIR" npm --prefix "$ROOT_DIR" run build

if [[ -n "$DATABASE_URL_ARG" || -n "$TENANT_ARG" || -n "$EMAIL_ARG" || -n "$DB_MODE_ARG" ]]; then
  if [[ -z "$DATABASE_URL_ARG" || -z "$EMAIL_ARG" ]]; then
    echo "--database-url and --email are required when configuring a shared database." >&2
    exit 2
  fi
  configure_args=(
    configure
    --database-url "$DATABASE_URL_ARG"
    --tenant "${TENANT_ARG:-local}"
    --email "$EMAIL_ARG"
    --db-mode "${DB_MODE_ARG:-external}"
  )
  if [[ -n "$MIGRATION_DATABASE_URL_ARG" ]]; then
    configure_args+=(--migration-database-url "$MIGRATION_DATABASE_URL_ARG")
  fi
  CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" "${configure_args[@]}"
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

"$ROOT_DIR/scripts/local-db.sh" start
if [[ "${CONTEXT_LEDGER_RUN_MIGRATIONS:-true}" != "false" ]]; then
  CONTEXT_LEDGER_HOME="$ROOT_DIR" npm --prefix "$ROOT_DIR" run migrate
  if [[ -n "$DATABASE_URL_ARG" && -n "$MIGRATION_DATABASE_URL_ARG" ]]; then
    tenant="${TENANT_ARG:-local}"
    CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" team init "$tenant" --name "$tenant"
    CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" team add-user "$EMAIL_ARG" \
      --tenant "$tenant" \
      --timezone "${TZ:-UTC}" \
      --role owner
  fi
else
  echo "Skipping migrations. The shared database must already be initialized by an administrator."
fi

if (( CONNECT_AGENTS )); then
  if command -v codex >/dev/null 2>&1 || command -v tcodex >/dev/null 2>&1; then
    "$ROOT_DIR/scripts/connect.sh" codex || true
  fi
  if command -v claude >/dev/null 2>&1 || command -v tclaude >/dev/null 2>&1; then
    "$ROOT_DIR/scripts/connect.sh" claude || true
  fi
fi

echo
echo "ContextLedger is ready."
echo
echo "Daily commands:"
echo "  ctx capture \"what changed and how it was validated\""
echo "  ctx report"
echo "  ctx details latest"
echo "  ctx detail TAG"
echo
echo "Check the installation with: context-ledger doctor"
if (( START_APP )); then
  echo
  exec "$ROOT_DIR/scripts/start.sh"
fi
