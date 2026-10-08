#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
  touch "$TMP/release"
  if [[ -n "${P1:-}" ]]; then wait "$P1" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
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
if [[ -n "${CHAT_BRIDGE_FAKE_RELEASE_FILE:-}" ]]; then
  for _ in {1..600}; do
    [[ -f "$CHAT_BRIDGE_FAKE_RELEASE_FILE" ]] && exit 0
    sleep 0.05
  done
  echo "pacing fixture release was not signalled" >&2
  exit 1
fi
EOF
chmod +x "$FAKE"

export EGO_BROWSER_BIN="$FAKE"
export CHAT_BRIDGE_FAKE_LOG="$LOG"
export CHAT_BRIDGE_CONFIG_DIR="$TMP/config"
export CHAT_BRIDGE_STATE_DIR="$TMP/state"
unset CHAT_BRIDGE_FROM_SPACE CHAT_BRIDGE_FROM_ACCOUNT_ID
export CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=10
export CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC=30
export CHAT_BRIDGE_MAX_INLINE_WAIT_SEC=5
export CHAT_BRIDGE_LOCK_WAIT_SEC=1
PACE_SCOPE="$(python3 "$ROOT/src/web-preflight.py" scope "$CHAT_BRIDGE_CONFIG_DIR" "$CHAT_BRIDGE_STATE_DIR" projects)"

# Concurrent commands cannot both enter Ego/browser work.
export CHAT_BRIDGE_STATE_DIR="$TMP/concurrent-state"
export CHAT_BRIDGE_FAKE_RELEASE_FILE="$TMP/release"
echo "pacing phase: concurrent lock"
"$ROOT/bin/chat-bridge" projects >/dev/null &
P1=$!
for _ in {1..600}; do
  [[ -s "$LOG" ]] && break
  sleep 0.05
done
[[ -s "$LOG" ]] || { echo "pacing fixture did not enter mock Ego" >&2; exit 1; }
set +e
CHAT_BRIDGE_LOCK_WAIT_SEC=0.5 "$ROOT/bin/chat-bridge" projects >/dev/null 2>"$TMP/concurrent.err"
RC=$?
set -e
touch "$TMP/release"
wait "$P1"
unset CHAT_BRIDGE_FAKE_RELEASE_FILE
[[ "$RC" == "75" ]]
python3 - "$TMP/concurrent.err" <<'PY'
import json,pathlib,sys
data=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert data["status"]=="DEFERRED", data
assert data["reason"]=="UI_LOCK_BUSY", data
assert data["deliveryStage"]=="PRE_SEND", data
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
assert data["deliveryStage"]=="PRE_SEND", data
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
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.heavy.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
pathlib.Path(sys.argv[2]).write_text(str(time.time()-11)+"\n")
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
assert data["deliveryStage"]=="PRE_SEND", data
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

# Runtime fixtures must use the authority after coordinator initialization.
set_runtime_fixture() {
  python3 - "$ROOT/src/state-store.py" "$CHAT_BRIDGE_CONFIG_DIR" "$CHAT_BRIDGE_STATE_DIR" "$1" <<'PY'
import json,subprocess,sys
script,config,state,value=sys.argv[1:]
base=json.loads(subprocess.check_output([sys.executable,script,"get",config,state,"runtime"],text=True))
subprocess.run([sys.executable,script,"put",config,state,"runtime"],
               input=json.dumps({"base":base,"next":json.loads(value)}),text=True,check=True,stdout=subprocess.DEVNULL)
PY
}

# Idle watchdog skips without starting Ego even when no cooldown is active.
mkdir -p "$CHAT_BRIDGE_STATE_DIR"
set_runtime_fixture '{"version":2,"projects":{},"tasks":{},"sessions":{}}'
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "2" ]]

# An active task and its separate scoped prune obey the same pacing lane.
set_runtime_fixture '{"version":2,"projects":{},"tasks":{"T-1":{"taskId":"T-1","project":"X","role":"worker","status":"RUNNING"}},"sessions":{}}'
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
PY
"$ROOT/bin/chat-bridge" watch --quiet >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "4" ]]

# A busy pacing lock also fails fast.
echo "pacing phase: explicit busy lock"
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
# Watch reads must not keep resetting the heavy-operation interval.
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.heavy.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
pathlib.Path(sys.argv[2]).write_text(str(time.time()-31)+"\n")
PY
"$ROOT/bin/chat-bridge" new --project X --name Y --message Z >/dev/null
[[ "$(wc -l < "$LOG" | tr -d ' ')" == "5" ]]
HEAVY_STAMP="$(cat "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.heavy.last")"
python3 - "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.last" <<'PY'
import pathlib,sys,time
pathlib.Path(sys.argv[1]).write_text(str(time.time()-11)+"\n")
PY
"$ROOT/bin/chat-bridge" projects >/dev/null
[[ "$(cat "$CHAT_BRIDGE_STATE_DIR/ui-pacing-$PACE_SCOPE.heavy.last")" == "$HEAVY_STAMP" ]]
set +e
"$ROOT/bin/chat-bridge" new --project X --name Y --message Z >/dev/null 2>"$TMP/repeated-heavy.err"
RC=$?
set -e
[[ "$RC" == "75" ]]
grep -q 'PACING_DEFERRED' "$TMP/repeated-heavy.err"

if CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=9 "$ROOT/bin/chat-bridge" help >/dev/null 2>&1; then
  echo "normal pacing below 10 seconds must be rejected" >&2
  exit 1
fi
if CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC=29 "$ROOT/bin/chat-bridge" help >/dev/null 2>&1; then
  echo "heavy pacing below 30 seconds must be rejected" >&2
  exit 1
fi

echo "pacing/cooldown checks passed"
