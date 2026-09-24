#!/bin/zsh
set -euo pipefail
ACCOUNT="${1:-}"
SUFFIX=""
if [[ -n "$ACCOUNT" ]]; then
  SAFE_ACCOUNT="${ACCOUNT//[^A-Za-z0-9_.-]/-}"
  SUFFIX=".$SAFE_ACCOUNT"
fi
LABEL="com.chatgpt-chat-bridge.watchdog$SUFFIX"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [[ -f "$PLIST" ]]; then
  launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
else
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi
echo "Removed watchdog: $LABEL"
