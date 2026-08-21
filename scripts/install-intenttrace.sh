#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

REPO="${INTENTTRACE_REPO:-$ROOT_DIR/.local/intenttrace}"
URL="${INTENTTRACE_REPO_URL:-https://github.com/Chivier/IntentTrace.git}"

if [[ -d "$REPO/.git" ]]; then
  echo "Updating IntentTrace..."
  git -C "$REPO" pull --ff-only
elif [[ -e "$REPO" ]]; then
  echo "IntentTrace path exists but is not a Git checkout: $REPO" >&2
  exit 1
else
  echo "Installing IntentTrace..."
  git clone --depth 1 "$URL" "$REPO"
fi

if [[ ! -d "$REPO/node_modules" ]]; then
  corepack pnpm@11.18.0 --dir "$REPO" install --frozen-lockfile
fi

for package in @intenttrace/schema @intenttrace/adapters @intenttrace/intent-reducer; do
  corepack pnpm@11.18.0 --dir "$REPO" --filter "$package" build
done

echo "IntentTrace is ready: $REPO"
