#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --check "$ROOT/src/main.js"
zsh -n "$ROOT/bin/chat-bridge"
zsh -n "$ROOT/scripts/install.sh"
zsh -n "$ROOT/scripts/uninstall.sh"
zsh -n "$ROOT/scripts/install-watchdog.sh"
zsh -n "$ROOT/scripts/uninstall-watchdog.sh"
grep -q 'GPT-6 Pro' "$ROOT/src/main.js"
grep -q 'project-conductor' "$ROOT/skills/project-conductor/SKILL.md"
grep -q 'task.newPage()' "$ROOT/src/main.js"
grep -q 'delete is destructive; pass --confirm' "$ROOT/src/main.js"
grep -q 'delete-conversation-confirm-button' "$ROOT/src/main.js"
grep -q 'space prune' "$ROOT/src/main.js"
grep -q 'runtime.json' "$ROOT/src/main.js"
grep -q 'spaceName' "$ROOT/src/main.js"
grep -q 'Unknown active chat' "$ROOT/src/main.js"
grep -q '"type": "module"' "$ROOT/package.json"
if grep -q 'chat-bridge-new-' "$ROOT/src/main.js"; then
  echo "per-session Space creation path must not return" >&2
  exit 1
fi

grep -q 'RUNNING_ACTIVE' "$ROOT/src/main.js"
grep -q 'SUSPECT_STALL' "$ROOT/src/main.js"
grep -q 'data-message-id' "$ROOT/src/main.js"
grep -q 'MutationObserver' "$ROOT/src/main.js"
grep -q 'gradedRecover' "$ROOT/src/main.js"
grep -q 'cmd==="watch"' "$ROOT/src/main.js"
grep -q 'AWAITING_DURABLE_UPDATE' "$ROOT/src/main.js"
grep -q 'StartInterval' "$ROOT/scripts/install-watchdog.sh"
grep -q '"version": "0.4.3"' "$ROOT/package.json"
grep -q 'waitForConversationReady' "$ROOT/src/main.js"
grep -q 'UI_MIN_INTERVAL_SEC="${CHAT_BRIDGE_UI_MIN_INTERVAL_SEC:-5}"' "$ROOT/bin/chat-bridge"
grep -q 'UI_HEAVY_INTERVAL_SEC="${CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC:-15}"' "$ROOT/bin/chat-bridge"
grep -q 'INTERVAL="${1:-30}"' "$ROOT/scripts/install-watchdog.sh"
grep -q 'CHAT_BRIDGE_WATCH_TASK_GAP_MS||5000' "$ROOT/src/main.js"
grep -q 'notificationTargets' "$ROOT/src/main.js"
grep -q 'rootController' "$ROOT/src/main.js"
grep -q 'control-routing.js' "$ROOT/bin/chat-bridge"
grep -q 'page-pool.js' "$ROOT/bin/chat-bridge"
grep -q 'pageDetachCandidates' "$ROOT/src/main.js"
grep -q 'composerText' "$ROOT/src/main.js"
grep -q 'newManagedPage' "$ROOT/src/main.js"
if grep -q 'notifyConductor' "$ROOT/src/main.js"; then
  echo "watchdog must not hard-code conductor routing" >&2
  exit 1
fi
echo "static checks passed"
