#!/bin/zsh
set -euo pipefail
BIN="${CHAT_BRIDGE_BIN:-$HOME/.local/bin/chat-bridge}"
[[ -x "$BIN" ]] || { echo "chat-bridge not found: $BIN" >&2; exit 127; }
LABEL="com.chatgpt-chat-bridge.coordinator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/chatgpt-chat-bridge"
mkdir -p "${PLIST:h}" "$LOG_DIR"
python3 - "$PLIST" "$BIN" "$LABEL" "$LOG_DIR" <<'PY'
import os, plistlib, sys
path, binary, label, log_dir = sys.argv[1:]
data = {
  "Label": label,
  "ProgramArguments": [binary, "queue", "serve"],
  "EnvironmentVariables": {
    "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.path.expanduser("~/.local/bin"),
    "CHAT_BRIDGE_BIN": binary,
    **{key: os.environ[key] for key in ("CHAT_BRIDGE_CONFIG_DIR", "CHAT_BRIDGE_STATE_DIR") if key in os.environ},
  },
  "RunAtLoad": True,
  "KeepAlive": True,
  "ProcessType": "Background",
  "StandardOutPath": f"{log_dir}/coordinator.log",
  "StandardErrorPath": f"{log_dir}/coordinator.err.log",
}
with open(path, "wb") as stream:
  os.fchmod(stream.fileno(), 0o600)
  plistlib.dump(data, stream)
PY
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Installed coordinator: $LABEL"
