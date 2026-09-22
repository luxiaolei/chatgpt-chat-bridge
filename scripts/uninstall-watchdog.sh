#!/bin/zsh
set -euo pipefail
LABEL="com.chatgpt-chat-bridge.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [[ -f "$PLIST" ]]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
else
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi
echo "Removed watchdog: $LABEL"
