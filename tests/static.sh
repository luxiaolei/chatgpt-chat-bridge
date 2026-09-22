#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --check "$ROOT/src/main.js"
zsh -n "$ROOT/bin/chat-bridge"
zsh -n "$ROOT/scripts/install.sh"
zsh -n "$ROOT/scripts/uninstall.sh"
grep -q 'GPT-6 Pro' "$ROOT/src/main.js"
grep -q 'project-conductor' "$ROOT/skills/project-conductor/SKILL.md"
echo "static checks passed"
