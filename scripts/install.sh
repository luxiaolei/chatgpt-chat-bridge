#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${CHAT_BRIDGE_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${CHAT_BRIDGE_SHARE_DIR:-$HOME/.local/share/chatgpt-chat-bridge}"
SKILLS_DIR="${CHAT_BRIDGE_SKILLS_DIR:-$HOME/.agents/skills}"

mkdir -p "$BIN_DIR" "$SHARE_DIR" "$SKILLS_DIR/chat-bridge" "$SKILLS_DIR/project-conductor"
cp "$ROOT/src/main.js" "$SHARE_DIR/main.js"
cp "$ROOT/src/control-routing.js" "$SHARE_DIR/control-routing.js"
cp "$ROOT/scripts/install-watchdog.sh" "$SHARE_DIR/install-watchdog.sh"
cp "$ROOT/scripts/uninstall-watchdog.sh" "$SHARE_DIR/uninstall-watchdog.sh"
cp "$ROOT/bin/chat-bridge" "$BIN_DIR/chat-bridge"
cp "$ROOT/skills/chat-bridge/SKILL.md" "$SKILLS_DIR/chat-bridge/SKILL.md"
cp "$ROOT/skills/project-conductor/SKILL.md" "$SKILLS_DIR/project-conductor/SKILL.md"
chmod +x "$BIN_DIR/chat-bridge" "$SHARE_DIR/install-watchdog.sh" "$SHARE_DIR/uninstall-watchdog.sh"

echo "Installed chat-bridge:"
echo "  CLI:    $BIN_DIR/chat-bridge"
echo "  Runtime:$SHARE_DIR/main.js"
echo "  Watchdog installer: $SHARE_DIR/install-watchdog.sh"
echo "  Skills: $SKILLS_DIR/chat-bridge, $SKILLS_DIR/project-conductor"
