#!/bin/zsh
set -euo pipefail

BIN_DIR="${CHAT_BRIDGE_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${CHAT_BRIDGE_SHARE_DIR:-$HOME/.local/share/chatgpt-chat-bridge}"
SKILLS_DIR="${CHAT_BRIDGE_SKILLS_DIR:-$HOME/.agents/skills}"

rm -f "$BIN_DIR/chat-bridge"
rm -rf "$SHARE_DIR"
rm -rf "$SKILLS_DIR/chat-bridge" "$SKILLS_DIR/project-conductor"

echo "Removed chat-bridge runtime and skills."
echo "Registry was preserved at ~/.config/chat-bridge/registry.json"
