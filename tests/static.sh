#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --check "$ROOT/src/main.js"
zsh -n "$ROOT/bin/chat-bridge"
zsh -n "$ROOT/scripts/install.sh"
zsh -n "$ROOT/scripts/uninstall.sh"
grep -q 'GPT-6 Pro' "$ROOT/src/main.js"
grep -q 'project-conductor' "$ROOT/skills/project-conductor/SKILL.md"
grep -q 'task.newPage()' "$ROOT/src/main.js"
grep -q 'delete is destructive; pass --confirm' "$ROOT/src/main.js"
grep -q 'runtime.json' "$ROOT/src/main.js"
grep -q 'spaceName' "$ROOT/src/main.js"
grep -q 'Unknown active chat' "$ROOT/src/main.js"
grep -q '"type": "module"' "$ROOT/package.json"
if grep -q 'chat-bridge-new-' "$ROOT/src/main.js"; then
  echo "per-session Space creation path must not return" >&2
  exit 1
fi
echo "static checks passed"
