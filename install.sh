#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/package.json" && -x "$SCRIPT_DIR/bin/context-ledger" ]]; then
  exec "$SCRIPT_DIR/bin/context-ledger" setup "$@"
fi

REPO_URL="${CONTEXT_LEDGER_REPO_URL:-https://github.com/EfficientContext/ContextLedger.git}"
INSTALL_DIR="${CONTEXT_LEDGER_INSTALL_DIR:-$HOME/.context-ledger}"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required." >&2
  exit 1
fi

if [[ -d "$INSTALL_DIR/.git" ]]; then
  echo "Updating ContextLedger in $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only
elif [[ -e "$INSTALL_DIR" ]]; then
  echo "$INSTALL_DIR already exists and is not a ContextLedger checkout." >&2
  exit 1
else
  echo "Installing ContextLedger in $INSTALL_DIR..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

exec "$INSTALL_DIR/bin/context-ledger" setup
