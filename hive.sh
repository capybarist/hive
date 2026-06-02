#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE v0.8 — node launcher.
#
# Reads `HIVE_MODE` (default: bee) and brings up exactly what that mode needs.
# v0.8 has no Python embedder — everything is one Node process: extractor +
# Hypercore + Hyperswarm (+ in-process LanceDB when the role calls for it).
#
# Supported modes:
#   bee   — DEFAULT. Producer only: extracts, embeds (e5-base ONNX int8 in the
#           same node process), signs, appends to its Hypercore. No query API.
#   queen — Consumer only: replicates peer Hypercores into in-process LanceDB,
#           embeds only the QUERY, serves /api/query + LLM synthesis. No
#           local extractor. Run via `bash queen.sh` for the queen-flavoured
#           startup banner.
#   hive  — All-in-one. Single-machine dev / quickstart. Both roles in one
#           process, including the local-Hypercore → LanceDB pipe.
#
# Usage:
#   bash hive.sh                         # bee (default in v0.8)
#   HIVE_MODE=hive bash hive.sh          # all-in-one (dev / single-machine)
#   HIVE_PORT=8081 bash hive.sh          # custom port
#   BEE_TOPIC_DOMAIN=health bash hive.sh # soft topic preference
#
# LLM is only required for query/synthesis (queen + hive modes); a producer
# bee runs with no LLM key at all in v0.6+.
#   LLM_PROVIDER=gemini|claude|openai|groq|ollama   (default: gemini)
#   LLM_API_KEY=your_api_key_here
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$(realpath "$0")")"

[ -f .env ] && set -a && source .env && set +a

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }

alive() { curl -s --max-time 1 "$1" 2>/dev/null | grep -q '"ok"\|"status"'; }

# ── Mode resolution ─────────────────────────────────────────────────────────
RAW_MODE="${HIVE_MODE:-bee}"
case "$RAW_MODE" in
  bee|queen|hive) MODE="$RAW_MODE" ;;
  aggregator)
    echo "⚠  HIVE_MODE=aggregator is the v0.6 alias — using queen. Update your env."
    MODE="queen"
    ;;
  *)
    echo "⚠  Unknown HIVE_MODE=$RAW_MODE — falling back to 'bee'. Valid: bee | queen | hive."
    MODE="bee"
    ;;
esac
export HIVE_MODE="$MODE"

NEEDS_LLM="false"
case "$MODE" in
  bee)   NEEDS_LLM="false" ;;
  queen) NEEDS_LLM="true"  ;;
  hive)  NEEDS_LLM="true"  ;;
esac

if [ "$NEEDS_LLM" = "true" ]; then
  LLM_PROVIDER="${LLM_PROVIDER:-gemini}"
  case "$LLM_PROVIDER" in
    gemini|claude|openai|groq|ollama) ;;
    *) err "Unknown LLM_PROVIDER='$LLM_PROVIDER'. Valid values: gemini, claude, openai, groq, ollama" ;;
  esac
  [ "$LLM_PROVIDER" != "ollama" ] && [ -z "$LLM_API_KEY" ] && err "LLM_API_KEY is required for HIVE_MODE=$MODE. Set it in .env."
fi

PORT="${HIVE_PORT:-8080}"
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive}"
TOPIC_DOMAIN="${BEE_TOPIC_DOMAIN:-}"
MAX_FRAGS="${HIVE_EXTRACT_MAX_FRAGMENTS:-20}"
INTERVAL_MS="${HIVE_EXTRACT_INTERVAL_MS:-300000}"

case "$MODE" in
  bee)   TITLE="HIVE — starting BEE (producer)" ;;
  queen) TITLE="HIVE — starting QUEEN (consumer / indexer)" ;;
  hive)  TITLE="HIVE — starting HIVE (all-in-one)" ;;
esac

echo ""
echo "  🐝  $TITLE  (v0.8 — all-Node)"
echo "────────────────────────────────────────"
echo "  Mode    : $MODE"
echo "  Port    : $PORT"
echo "  Data    : $DATA_DIR"
[ "$MODE" = "bee" ] || [ "$MODE" = "hive" ] && echo "  Domain  : ${TOPIC_DOMAIN:-auto-discover}"
echo ""

mkdir -p "$DATA_DIR/identity" "$DATA_DIR/corestore" "$DATA_DIR/lancedb"

if alive "http://127.0.0.1:$PORT/api/status"; then
  ok "Node :$PORT already running"
else
  run "Starting node on :$PORT ..."

  tmp_env=$(mktemp /tmp/hive_XXXXXX.env)
  [ -f .env ] && cat .env >> "$tmp_env"
  cat >> "$tmp_env" << EOF
HIVE_MODE=$MODE
HIVE_PORT=$PORT
HIVE_DATA_DIR=$DATA_DIR
BEE_TOPIC_DOMAIN=$TOPIC_DOMAIN
HIVE_EXTRACT_MAX_FRAGMENTS=$MAX_FRAGS
HIVE_EXTRACT_INTERVAL_MS=$INTERVAL_MS
EOF

  # `exec` so the subshell BECOMES node → $! is node's real PID, which the
  # signal-forwarding trap below uses to shut it down cleanly (v0.7.7.12).
  ( cd packages/api && exec node --env-file="$tmp_env" --import tsx/esm src/api_server.ts \
      > "/tmp/hive_api.log" 2>&1 ) &
  NODE_PID=$!

  # v0.9.5: wait up to 300s (was 120s). A large corestore (a long-lived
  # Wikipedia bee hit ~400k fragments) plus a cold e5 ONNX warmup can take
  # minutes — especially under memory pressure when several nodes warm at once
  # on a small box. We NEVER kill the node from here (see the hand-off below);
  # this loop only governs how long we wait before printing the status line.
  for i in $(seq 1 300); do
    alive "http://127.0.0.1:$PORT/api/status" && break
    sleep 1
  done
fi

STATUS=$(curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null)
if echo "$STATUS" | grep -q '"ok"'; then
  NODE=$(echo "$STATUS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).nodeId||'?')}catch{console.log('?')}})" 2>/dev/null)
  IDX=$(echo "$STATUS"  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).indexed||0)}catch{console.log(0)}})" 2>/dev/null)
  echo ""
  ok "Node running (mode: $MODE)"
  echo "  Node ID : $NODE"
  [ "$MODE" != "bee" ] && echo "  Indexed : $IDX vectors"
  echo ""

  SPACE="${CODESPACE_NAME:-}"
  if [ -n "$SPACE" ]; then
    echo "  UI → https://${SPACE}-${PORT}.app.github.dev"
  else
    echo "  UI → http://localhost:$PORT"
  fi
  echo "  Logs → /tmp/hive_api.log"
elif kill -0 "${NODE_PID:-}" 2>/dev/null; then
  # Not "ok" yet but the node process is ALIVE — it's still loading a big
  # store. Never kill it here; hand off to the keep-alive loop and let the
  # Docker healthcheck flip to healthy once ready. This is the critical
  # difference from the old behavior that caused the restart loop.
  info "Node still starting (large store) — handing off. Watch /tmp/hive_api.log"
else
  err "Node process exited during startup. Check /tmp/hive_api.log"
fi
echo ""

# Keep the foreground process alive, stream logs, AND forward container stop
# signals to node so it flushes its corestore before exit (v0.7.7.12).
if [ -n "${NODE_PID:-}" ]; then
  trap 'echo "[hive.sh] stop signal — forwarding SIGTERM to node ($NODE_PID)"; kill -TERM "$NODE_PID" 2>/dev/null' TERM INT
  tail -f /tmp/hive_api.log &
  TAIL_PID=$!
  while kill -0 "$NODE_PID" 2>/dev/null; do
    wait "$NODE_PID" 2>/dev/null || true
  done
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
fi

exec tail -f /tmp/hive_api.log
