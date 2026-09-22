#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${CHAT_BRIDGE_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${CHAT_BRIDGE_SHARE_DIR:-$HOME/.local/share/chatgpt-chat-bridge}"
SKILLS_DIR="${CHAT_BRIDGE_SKILLS_DIR:-$HOME/.agents/skills}"

mkdir -p "$BIN_DIR" "$SHARE_DIR" "$SKILLS_DIR/chat-bridge" "$SKILLS_DIR/project-conductor"
cp "$ROOT/src/main.js" "$SHARE_DIR/main.js"
cp "$ROOT/bin/chat-bridge" "$BIN_DIR/chat-bridge"
cp "$ROOT/skills/chat-bridge/SKILL.md" "$SKILLS_DIR/chat-bridge/SKILL.md"
cp "$ROOT/skills/project-conductor/SKILL.md" "$SKILLS_DIR/project-conductor/SKILL.md"
chmod +x "$BIN_DIR/chat-bridge"

echo "Installed chat-bridge:"
echo "  CLI:    $BIN_DIR/chat-bridge"
echo "  Runtime:$SHARE_DIR/main.js"
echo "  Skills: $SKILLS_DIR/chat-bridge, $SKILLS_DIR/project-conductor"
