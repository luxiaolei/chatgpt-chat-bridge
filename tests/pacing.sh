#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAKE="$TMP/ego-browser"
LOG="$TMP/times.log"

cat > "$FAKE" <<'EOF'
#!/bin/zsh
set -euo pipefail
cat >/dev/null
python3 - "$CHAT_BRIDGE_FAKE_LOG" <<'PY'
import pathlib,sys,time
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True)
with p.open("a") as f: f.write(f"{time.time():.6f}\n")
PY
EOF
chmod +x "$FAKE"

export EGO_BROWSER_BIN="$FAKE"
export CHAT_BRIDGE_FAKE_LOG="$LOG"
export CHAT_BRIDGE_CONFIG_DIR="$TMP/config"
export CHAT_BRIDGE_STATE_DIR="$TMP/state"
export CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=10
export CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC=30
export CHAT_BRIDGE_MAX_INLINE_WAIT_SEC=5
export CHAT_BRIDGE_LOCK_WAIT_SEC=1

# First UI command is admitted.
"$ROOT/bin/chat-bridge" projects >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "1" ]]

# Immediate second command must fail fast instead of sleeping ~10s.
set +e
START="$(python3 - <<'PY'
import time; print(time.time())
PY
)"
"$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/defer.err"
RC=$?
ELAPSED="$(python3 - "$START" <<'PY'
import sys,time; print(time.time()-float(sys.argv[1]))
PY
)"
set -e
[[ "$RC" == "75" ]]
grep -q 'PACING_DEFERRED' "$TMP/defer.err"
python3 - "$ELAPSED" <<'PY'
import sys
assert float(sys.argv[1]) < 6, sys.argv[1]
PY
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "1" ]]

# Age the stamp so the next normal command is admitted without waiting.
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing.last" <<'PY'
import pathlib,sys,time
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(str(time.time()-11)+"\n")
PY
"$ROOT/bin/chat-bridge" projects >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# Heavy command is deferred when only the normal 10s interval has elapsed.
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
PY
set +e
"$ROOT/bin/chat-bridge" new --project X --name Y --message Z >/dev/null 2>"$TMP/heavy.err"
RC=$?
set -e
[[ "$RC" == "75" ]]
grep -q 'PACING_DEFERRED' "$TMP/heavy.err"

# Active shared cooldown rejects manual UI work immediately and never invokes Ego.
python3 - "$CHAT_BRIDGE_STATE_DIR/web-cooldown.json" <<'PY'
import json,pathlib,sys
from datetime import datetime,timedelta,timezone
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True)
p.write_text(json.dumps({"strikes":2,"until":(datetime.now(timezone.utc)+timedelta(minutes=3)).isoformat().replace("+00:00","Z")}))
PY
set +e
"$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/cooldown.err"
RC=$?
set -e
[[ "$RC" == "75" ]]
grep -q 'WEB_COOLDOWN_ACTIVE' "$TMP/cooldown.err"
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# Watchdog skips cleanly during cooldown.
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]
rm -f "$CHAT_BRIDGE_STATE_DIR/web-cooldown.json"

# Idle watchdog skips without starting Ego even when no cooldown is active.
mkdir -p "$CHAT_BRIDGE_STATE_DIR"
echo '{"version":2,"projects":{},"tasks":{},"sessions":{}}' > "$CHAT_BRIDGE_STATE_DIR/runtime.json"
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# A busy pacing lock also fails fast.
mkdir -p "$CHAT_BRIDGE_STATE_DIR/ui-pacing.lock"
echo "$$" > "$CHAT_BRIDGE_STATE_DIR/ui-pacing.lock/pid"
set +e
CHAT_BRIDGE_LOCK_WAIT_SEC=0.5 "$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/lock.err"
RC=$?
set -e
rm -rf "$CHAT_BRIDGE_STATE_DIR/ui-pacing.lock"
[[ "$RC" == "75" ]]
grep -q 'PACING_DEFERRED lock busy' "$TMP/lock.err"

# Hard minimum remains enforced.
if CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=4 "$ROOT/bin/chat-bridge" projects >/dev/null 2>&1; then
  echo "pacing minimum below 5 seconds must be rejected" >&2
  exit 1
fi

echo "pacing/cooldown checks passed"
