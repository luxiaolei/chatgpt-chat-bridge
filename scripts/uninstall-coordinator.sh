#!/bin/zsh
set -euo pipefail
LABEL="com.chatgpt-chat-bridge.coordinator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [[ -f "$PLIST" ]]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
fi
echo "Removed coordinator: $LABEL"
