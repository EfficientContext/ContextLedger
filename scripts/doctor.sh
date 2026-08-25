#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi
FAILURES=0
WARNINGS=0

pass() { printf '✓ %s\n' "$1"; }
warn() { printf '! %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
fail() { printf '✗ %s\n' "$1"; FAILURES=$((FAILURES + 1)); }

check_command() {
  local command_name="$1"
  local label="$2"
  if command -v "$command_name" >/dev/null 2>&1; then
    pass "$label: $(command -v "$command_name")"
  else
    fail "$label is not installed"
  fi
}

echo "ContextLedger doctor"
echo

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if (( node_major >= 22 )); then
    pass "Node.js $(node -v)"
  else
    fail "Node.js 22+ is required; found $(node -v)"
  fi
else
  fail "Node.js is not installed"
fi

check_command npm "npm"

if [[ -d "$ROOT_DIR/node_modules" ]]; then
  pass "Node dependencies are installed"
else
  fail "Node dependencies are missing; run context-ledger setup"
fi

if [[ -f "$ROOT_DIR/.env" ]]; then
  pass ".env exists"
else
  fail ".env is missing; run context-ledger setup"
fi

if "$ROOT_DIR/scripts/local-db.sh" status >/dev/null 2>&1; then
  pass "PostgreSQL is accepting connections"
  if [[ -f "$ROOT_DIR/dist/src/interfaces/cli/main.js" ]] &&
    CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" whoami --json >/dev/null 2>&1; then
    identity="$(
      CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" whoami 2>/dev/null
    )"
    pass "Identity: $identity"
  else
    fail "Configured user or tenant was not found; ask the workspace admin to add the user"
  fi
else
  fail "PostgreSQL is not ready; run context-ledger start"
fi

if curl -fsS "http://127.0.0.1:${PORT:-4318}/health" >/dev/null 2>&1; then
  pass "Web service is running at http://127.0.0.1:${PORT:-4318}"
else
  warn "Web service is not running; run context-ledger start"
fi

for skill in research-writing-skill scientific-toolkit-skill shuorenhua; do
  if [[ -f "$ROOT_DIR/.local/skills/$skill/SKILL.md" ]]; then
    pass "Writer skill installed: $skill"
  else
    fail "Writer skill missing: $skill; run context-ledger setup"
  fi
done

intenttrace_repo="${INTENTTRACE_REPO:-$ROOT_DIR/.local/intenttrace}"
if [[ -f "$intenttrace_repo/packages/adapters/dist/index.js" ]] &&
  [[ -f "$intenttrace_repo/packages/intent-reducer/dist/index.js" ]]; then
  pass "IntentTrace integration is ready: $intenttrace_repo"
else
  fail "IntentTrace is missing or not built; run scripts/install-intenttrace.sh"
fi

active_provider="cli"
active_model=""
if [[ -f "$ROOT_DIR/dist/src/interfaces/cli/main.js" ]]; then
  model_status="$({
    CONTEXT_LEDGER_HOME="$ROOT_DIR" node "$ROOT_DIR/dist/src/interfaces/cli/main.js" model status --json
  } 2>/dev/null || true)"
  if [[ -n "$model_status" ]]; then
    active_provider="$(printf '%s' "$model_status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).active.provider))' 2>/dev/null || printf 'cli')"
    active_model="$(printf '%s' "$model_status" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).active.model||""))' 2>/dev/null || true)"
  fi
fi

if [[ "$active_provider" != "cli" ]]; then
  pass "Report writer configured: $active_provider / $active_model"
else
  writer=""
  for candidate in tclaude claude tcodex codex; do
    if command -v "$candidate" >/dev/null 2>&1; then
      if [[ "$candidate" == "tclaude" ]]; then
        if tclaude -- auth status 2>/dev/null | grep -q '"loggedIn": true'; then
          writer="$candidate"
          break
        fi
      elif [[ "$candidate" == "claude" ]]; then
        if claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
          writer="$candidate"
          break
        fi
      elif [[ "$candidate" == "tcodex" ]]; then
        writer="$candidate"
        break
      elif "$candidate" -- login status >/dev/null 2>&1; then
        writer="$candidate"
        break
      fi
    fi
  done
  if [[ -n "$writer" ]]; then
    pass "Report writer available: $writer"
  else
    fail "Log in to Claude Code or Codex, or configure an API provider with: ctx model set"
  fi
fi

codex_cli=""
if command -v codex >/dev/null 2>&1; then
  codex_cli="codex"
elif command -v tcodex >/dev/null 2>&1; then
  codex_cli="tcodex"
fi
if [[ -n "$codex_cli" ]]; then
  if "$codex_cli" mcp get context-ledger >/dev/null 2>&1; then
    pass "Codex MCP connection is configured"
  else
    warn "Codex MCP is not configured; run context-ledger connect codex"
  fi
else
  warn "Codex CLI is not installed"
fi

claude_cli=""
if command -v claude >/dev/null 2>&1; then
  claude_cli="claude"
elif command -v tclaude >/dev/null 2>&1; then
  claude_cli="tclaude --"
fi
if [[ -n "$claude_cli" ]]; then
  if eval "$claude_cli mcp get context-ledger" >/dev/null 2>&1; then
    pass "Claude Code MCP connection is configured"
  else
    warn "Claude Code MCP is not configured; run context-ledger connect claude"
  fi
else
  warn "Claude Code is not installed"
fi

echo
if (( FAILURES > 0 )); then
  echo "$FAILURES error(s), $WARNINGS warning(s)."
  exit 1
fi
echo "Ready. $WARNINGS warning(s)."
echo
echo "Try:"
echo "  context-ledger capture \"what changed and how it was validated\""
echo "  context-ledger model"
echo "  context-ledger report"
echo "  context-ledger details latest"
