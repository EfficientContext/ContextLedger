#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-all}"
BIN_DIR="$ROOT_DIR/bin"
MCP_COMMAND="$BIN_DIR/context-ledger-mcp"

usage() {
  cat <<'EOF'
Usage: context-ledger connect [codex|claude|all]

Register ContextLedger as a user-level STDIO MCP server.
EOF
}

if [[ "$TARGET" == "-h" || "$TARGET" == "--help" ]]; then
  usage
  exit 0
fi
if [[ "$TARGET" != "codex" && "$TARGET" != "claude" && "$TARGET" != "all" ]]; then
  usage >&2
  exit 2
fi

if [[ ! -f "$ROOT_DIR/dist/src/interfaces/mcp/server.js" ]]; then
  CONTEXT_LEDGER_HOME="$ROOT_DIR" npm --prefix "$ROOT_DIR" run build
fi

connect_codex() {
  local cli=""
  if command -v codex >/dev/null 2>&1; then
    cli="codex"
  elif command -v tcodex >/dev/null 2>&1; then
    cli="tcodex"
  else
    echo "Codex CLI was not found. Install Codex, then rerun context-ledger connect codex." >&2
    return 1
  fi

  "$cli" mcp remove context-ledger >/dev/null 2>&1 || true
  "$cli" mcp add context-ledger -- "$MCP_COMMAND"
  echo "Codex connected. Start a new Codex session and run /mcp to verify."
}

connect_claude() {
  local -a cli
  if command -v claude >/dev/null 2>&1; then
    cli=(claude)
  elif command -v tclaude >/dev/null 2>&1; then
    cli=(tclaude --)
  else
    echo "Claude Code was not found. Install Claude Code, then rerun context-ledger connect claude." >&2
    return 1
  fi

  "${cli[@]}" mcp remove --scope user context-ledger >/dev/null 2>&1 || true
  "${cli[@]}" mcp add --scope user --transport stdio context-ledger -- "$MCP_COMMAND"
  echo "Claude Code connected. Start a new Claude Code session and run /mcp to verify."
}

case "$TARGET" in
  codex) connect_codex ;;
  claude) connect_claude ;;
  all)
    status=0
    connect_codex || status=1
    connect_claude || status=1
    exit "$status"
    ;;
esac
