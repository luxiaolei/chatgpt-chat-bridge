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
import pathlib, sys, time
p=pathlib.Path(sys.argv[1])
with p.open("a") as f:
    f.write(f"{time.time():.6f}\n")
PY
sleep 0.2
EOF
chmod +x "$FAKE"

export EGO_BROWSER_BIN="$FAKE"
export CHAT_BRIDGE_FAKE_LOG="$LOG"
export CHAT_BRIDGE_CONFIG_DIR="$TMP/config"
export CHAT_BRIDGE_STATE_DIR="$TMP/state"
export CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=5
export CHAT_BRIDGE_UI_HEAVY_INTERVAL_SEC=15

"$ROOT/bin/chat-bridge" projects >/dev/null &
P1=$!
sleep 0.1
"$ROOT/bin/chat-bridge" projects >/dev/null &
P2=$!
wait "$P1"
wait "$P2"

python3 - "$LOG" <<'PY'
import pathlib, sys
rows=[float(x) for x in pathlib.Path(sys.argv[1]).read_text().splitlines() if x.strip()]
assert len(rows)==2, rows
gap=rows[1]-rows[0]
assert gap >= 5.0, f"UI pacing gap too small: {gap:.3f}s"
print(f"pacing concurrency gap {gap:.3f}s")
PY

if CHAT_BRIDGE_UI_MIN_INTERVAL_SEC=4 "$ROOT/bin/chat-bridge" projects >/dev/null 2>&1; then
  echo "pacing minimum below 5 seconds must be rejected" >&2
  exit 1
fi

echo "pacing checks passed"
