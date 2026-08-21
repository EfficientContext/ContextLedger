#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT_DIR/.local/skills"
CACHE="$ROOT_DIR/.local/skill-sources"
SHUORENHUA_REPO="$CACHE/shuorenhua"
ACADEMIC_REPO="$CACHE/codex-claude-academic-skills"

mkdir -p "$DEST" "$CACHE"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required to install the report skills." >&2
  exit 1
fi

sync_repo() {
  local url="$1"
  local destination="$2"
  if [[ -d "$destination/.git" ]]; then
    git -C "$destination" pull --ff-only
  else
    git clone --depth 1 "$url" "$destination"
  fi
}

sync_repo https://github.com/MrGeDiao/shuorenhua.git "$SHUORENHUA_REPO"
sync_repo https://github.com/zLanqing/codex-claude-academic-skills.git "$ACADEMIC_REPO"

mkdir -p \
  "$DEST/shuorenhua" \
  "$DEST/research-writing-skill" \
  "$DEST/scientific-toolkit-skill"

cp "$SHUORENHUA_REPO/SKILL.md" "$DEST/shuorenhua/SKILL.md"
cp -R "$SHUORENHUA_REPO/references" "$DEST/shuorenhua/" 2>/dev/null || true
cp -R "$ACADEMIC_REPO/research-writing-skill/." "$DEST/research-writing-skill/"
cp -R "$ACADEMIC_REPO/scientific-toolkit-skill/." "$DEST/scientific-toolkit-skill/"

echo "Installed report skills in $DEST"
