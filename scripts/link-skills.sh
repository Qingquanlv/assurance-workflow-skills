#!/usr/bin/env bash
#
# link-skills.sh — Expose this repo's aws-* skills to the oh-my-openagent
# (oh-my-opencode) plugin by symlinking them into a directory the plugin scans.
#
# Why: the omo plugin replaces OpenCode's native `skill` tool with its own,
# and its discovery does NOT read opencode.json's `skills.paths`. It only scans
# fixed locations such as ~/.config/opencode/skills/. So skills registered via
# `skills.paths` are invisible. Symlinking them into a scanned dir fixes that.
#
# Usage:
#   scripts/link-skills.sh            # link into ~/.config/opencode/skills (global)
#   scripts/link-skills.sh --project  # link into <repo>/.opencode/skills (project-local)
#   scripts/link-skills.sh --target DIR
#   scripts/link-skills.sh --prune    # also remove stale aws-* symlinks first
#
# After running, restart OpenCode so the skill list cache refreshes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/skills"

TARGET=""
PRUNE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      TARGET="$REPO_ROOT/.opencode/skills"
      shift
      ;;
    --target)
      TARGET="${2:?--target requires a directory}"
      shift 2
      ;;
    --prune)
      PRUNE=1
      shift
      ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  TARGET="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills"
fi

if [[ ! -d "$SRC_DIR" ]]; then
  echo "Source skills dir not found: $SRC_DIR" >&2
  exit 1
fi

mkdir -p "$TARGET"

if [[ "$PRUNE" -eq 1 ]]; then
  for link in "$TARGET"/aws-*; do
    [[ -L "$link" ]] || continue
    dest="$(readlink "$link")"
    if [[ "$dest" == "$SRC_DIR/"* && ! -e "$link" ]]; then
      echo "prune (broken): $(basename "$link")"
      rm -f "$link"
    fi
  done
fi

count=0
for d in "$SRC_DIR"/aws-*/; do
  [[ -d "$d" ]] || continue
  name="$(basename "$d")"
  [[ -f "$d/SKILL.md" ]] || { echo "skip (no SKILL.md): $name" >&2; continue; }
  ln -sfn "${d%/}" "$TARGET/$name"
  count=$((count + 1))
done

echo "Linked $count skill(s) into: $TARGET"
echo "Restart OpenCode to refresh the skill list cache."
