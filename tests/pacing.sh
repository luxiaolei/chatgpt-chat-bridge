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
sleep "${CHAT_BRIDGE_FAKE_SLEEP_SEC:-0}"
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
PACE_SCOPE="$(python3 "$ROOT/src/web-preflight.py" scope "$CHAT_BRIDGE_CONFIG_DIR" "$CHAT_BRIDGE_STATE_DIR" projects)"

# Concurrent commands cannot both enter Ego/browser work.
export CHAT_BRIDGE_STATE_DIR="$TMP/concurrent-state"
export CHAT_BRIDGE_FAKE_SLEEP_SEC=2
"$ROOT/bin/chat-bridge" projects >/dev/null &
P1=$!
for _ in {1..40}; do
  [[ -s "$LOG" ]] && break
  sleep 0.05
done
set +e
CHAT_BRIDGE_LOCK_WAIT_SEC=0.5 "$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/concurrent.err"
RC=$?
set -e
wait "$P1"
unset CHAT_BRIDGE_FAKE_SLEEP_SEC
[[ "$RC" == "75" ]]
python3 - "$TMP/concurrent.err" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["status"]=="DEFERRED", data
assert data["reason"]=="UI_LOCK_BUSY", data
PY
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "1" ]]
rm -f "$LOG"
export CHAT_BRIDGE_STATE_DIR="$TMP/state"

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
python3 - "$TMP/defer.err" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["status"]=="DEFERRED", data
assert data["reason"]=="UI_PACING", data
assert data["retryAfterSec"]>=1, data
PY
python3 - "$ELAPSED" <<'PY'
import sys
assert float(sys.argv[1]) < 6, sys.argv[1]
PY
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "1" ]]

# Age the stamp so the next normal command is admitted without waiting.
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" <<'PY'
import pathlib,sys,time
p=pathlib.Path(sys.argv[1]); p.parent.mkdir(parents=True,exist_ok=True); p.write_text(str(time.time()-11)+"\n")
PY
"$ROOT/bin/chat-bridge" projects >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# Heavy command is deferred when only the normal 10s interval has elapsed.
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" <<'PY'
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

# Status is local and clearing protection requires explicit confirmation.
"$ROOT/bin/chat-bridge" cooldown status >"$TMP/cooldown-status.json"
python3 - "$TMP/cooldown-status.json" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["active"] is True, data
PY
set +e
"$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/cooldown.err"
RC=$?
set -e
[[ "$RC" == "75" ]]
python3 - "$TMP/cooldown.err" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["status"]=="COOLDOWN", data
assert data["reason"]=="CHATGPT_RATE_LIMIT", data
assert data["retryAfterSec"]>=1, data
PY
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# Watchdog skips cleanly during cooldown.
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]
set +e
"$ROOT/bin/chat-bridge" cooldown clear >/dev/null 2>"$TMP/clear.err"
RC=$?
set -e
[[ "$RC" == "2" ]]
[[ -f "$CHAT_BRIDGE_STATE_DIR/web-cooldown.json" ]]
"$ROOT/bin/chat-bridge" cooldown clear --confirm >/dev/null
[[ ! -e "$CHAT_BRIDGE_STATE_DIR/web-cooldown.json" ]]

# Idle watchdog skips without starting Ego even when no cooldown is active.
mkdir -p "$CHAT_BRIDGE_STATE_DIR"
echo '{"version":2,"projects":{},"tasks":{},"sessions":{}}' > "$CHAT_BRIDGE_STATE_DIR/runtime.json"
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# An active task with no cooldown reaches Ego/browser work.
echo '{"version":2,"projects":{},"tasks":{"T-1":{"taskId":"T-1","project":"X","role":"worker","status":"RUNNING"}},"sessions":{}}' > "$CHAT_BRIDGE_STATE_DIR/runtime.json"
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
PY
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "3" ]]

# A busy pacing lock also fails fast.
mkdir -p "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.lock"
echo "$$" > "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.lock/pid"
set +e
CHAT_BRIDGE_LOCK_WAIT_SEC=0.5 "$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/lock.err"
RC=$?
set -e
rm -rf "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.lock"
[[ "$RC" == "75" ]]
python3 - "$TMP/lock.err" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["status"]=="DEFERRED", data
assert data["reason"]=="UI_LOCK_BUSY", data
PY

# Hard safety floors remain enforced.
if CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=9 "$ROOT/bin/chat-bridge" help >/dev/null 2>&1; then
  echo "normal pacing below 10 seconds must be rejected" >&2
  exit 1
fi
if CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC=29 "$ROOT/bin/chat-bridge" help >/dev/null 2>&1; then
  echo "heavy pacing below 30 seconds must be rejected" >&2
  exit 1
fi

echo "pacing/cooldown checks passed"
