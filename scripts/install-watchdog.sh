#!/bin/zsh
set -euo pipefail
INTERVAL="${1:-60}"
[[ "$INTERVAL" == <-> ]] || { echo "interval must be integer seconds" >&2; exit 2; }
(( INTERVAL >= 10 )) || { echo "interval must be >= 10 seconds" >&2; exit 2; }
BIN="${CHAT_BRIDGE_BIN:-$HOME/.local/bin/chat-bridge}"
[[ -x "$BIN" ]] || { echo "chat-bridge not found: $BIN" >&2; exit 127; }
LABEL="com.chatgpt-chat-bridge.watchdog"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/chatgpt-chat-bridge"
mkdir -p "${PLIST:h}" "$LOG_DIR"
python3 - "$PLIST" "$BIN" "$INTERVAL" "$LOG_DIR" <<'PY'
import plistlib,sys
path,bin_path,interval,log_dir=sys.argv[1:]
data={
  "Label":"com.chatgpt-chat-bridge.watchdog",
  "ProgramArguments":[bin_path,"watch","--quiet"],
  "RunAtLoad":True,
  "StartInterval":int(interval),
  "ProcessType":"Background",
  "StandardOutPath":f"{log_dir}/watchdog.log",
  "StandardErrorPath":f"{log_dir}/watchdog.err.log",
}
with open(path,"wb") as f: plistlib.dump(data,f)
PY
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
echo "Installed watchdog: $LABEL (every ${INTERVAL}s)"
echo "  plist: $PLIST"
echo "  logs:  $LOG_DIR/watchdog.log, $LOG_DIR/watchdog.err.log"
