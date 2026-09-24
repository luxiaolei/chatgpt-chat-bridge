#!/bin/zsh
set -euo pipefail
INTERVAL="${1:-60}"
ACCOUNT="${2:-}"
[[ "$INTERVAL" == <-> ]] || { echo "interval must be integer seconds" >&2; exit 2; }
(( INTERVAL >= 10 )) || { echo "interval must be >= 10 seconds" >&2; exit 2; }
BIN="${CHAT_BRIDGE_BIN:-$HOME/.local/bin/chat-bridge}"
[[ -x "$BIN" ]] || { echo "chat-bridge not found: $BIN" >&2; exit 127; }
SUFFIX=""
if [[ -n "$ACCOUNT" ]]; then
  SAFE_ACCOUNT="${ACCOUNT//[^A-Za-z0-9_.-]/-}"
  SUFFIX=".$SAFE_ACCOUNT"
fi
LABEL="com.chatgpt-chat-bridge.watchdog$SUFFIX"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/chatgpt-chat-bridge"
mkdir -p "${PLIST:h}" "$LOG_DIR"
python3 - "$PLIST" "$BIN" "$INTERVAL" "$LOG_DIR" "$LABEL" "$ACCOUNT" <<'PY'
import plistlib,sys
path,bin_path,interval,log_dir,label,account=sys.argv[1:]
args=[bin_path,"watch","--quiet"]
if account:
    args += ["--account",account]
data={
  "Label":label,
  "ProgramArguments":args,
  "RunAtLoad":True,
  "StartInterval":int(interval),
  "ProcessType":"Background",
  "StandardOutPath":f"{log_dir}/watchdog{'.'+account if account else ''}.log",
  "StandardErrorPath":f"{log_dir}/watchdog{'.'+account if account else ''}.err.log",
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
