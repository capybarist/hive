#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE — node launcher (v0.7+)
#
# Reads `HIVE_MODE` (default: bee) and brings up exactly what that mode
# needs. The supported modes are:
#
#   bee   — DEFAULT. Producer only: extractor + own Hypercore + Hyperswarm.
#           No embedder, no LLM, no /api/query. ~150 MB target. Right
#           choice if you want to contribute to the network.
#   queen — Consumer only: embedder + Qdrant + LLM + /api/query. No local
#           extractor, no local Hypercore writes. Run `bash queen.sh`
#           instead — it handles Qdrant readiness too.
#   hive  — All-in-one. Extractor + embedder + LLM + queries in a single
#           process. Convenient for local dev or single-machine demos.
#
# This script starts the embedder only when the mode actually needs it
# (bee mode does not). The api_server resolves the rest from HIVE_MODE.
#
# Usage:
#   bash hive.sh                         # bee (default in v0.7.0.6+)
#   HIVE_MODE=hive bash hive.sh          # all-in-one (dev / single-machine)
#   HIVE_PORT=8081 bash hive.sh          # custom port
#   HIVE_BOOTSTRAP=http://peer.example   # connect to existing network
#   BEE_TOPIC_DOMAIN=health bash hive.sh # soft topic preference
#
# Required env (only when the LLM is needed — queen / hive):
#   LLM_PROVIDER=gemini|claude|openai|groq   (default: gemini)
#   LLM_API_KEY=your_api_key_here
#
# Optional env:
#   HIVE_MODE                 (default: bee)
#   LLM_MODEL                 (override default model for the provider)
#   HIVE_PORT                 (default: 8080)
#   HIVE_EMBEDDER_PORT        (default: 7700; ignored in bee mode)
#   HIVE_DATA_DIR             (default: ~/.hive)
#   HIVE_BOOTSTRAP            (default: none — standalone seed)
#   BEE_TOPIC_DOMAIN          (default: none — fully autonomous)
#   HIVE_EXTRACT_MAX_FRAGMENTS (default: 20)
#   HIVE_EXTRACT_INTERVAL_MS  (default: 300000 — 5min)
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$(realpath "$0")")"

# Load .env if present (optional)
[ -f .env ] && set -a && source .env && set +a

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }

alive() { curl -s --max-time 1 "$1" 2>/dev/null | grep -q '"ok"\|"status"'; }

# ── Mode resolution ───────────────────────────────────────────────────────────
RAW_MODE="${HIVE_MODE:-bee}"
case "$RAW_MODE" in
  bee|queen|hive) MODE="$RAW_MODE" ;;
  aggregator)
    echo "⚠  HIVE_MODE=aggregator is a v0.6 alias — using queen. Update your env."
    MODE="queen"
    ;;
  *)
    echo "⚠  Unknown HIVE_MODE=$RAW_MODE — falling back to 'bee'. Valid: bee | queen | hive."
    MODE="bee"
    ;;
esac
# Re-export the canonical mode so the api_server sees the same value.
export HIVE_MODE="$MODE"

# bee mode has no LLM (no /api/query and no synthesis), so the LLM check
# only applies to queen/hive. This is what makes a fresh `bash hive.sh`
# work for somebody with no API key: it just produces fragments.
NEEDS_LLM="false"
NEEDS_EMBEDDER="false"
case "$MODE" in
  bee)            NEEDS_EMBEDDER="false"; NEEDS_LLM="false" ;;
  queen)          NEEDS_EMBEDDER="true";  NEEDS_LLM="true"  ;;
  hive)           NEEDS_EMBEDDER="true";  NEEDS_LLM="true"  ;;
esac

# ── Validate (when applicable) ────────────────────────────────────────────────
if [ "$NEEDS_LLM" = "true" ]; then
  LLM_PROVIDER="${LLM_PROVIDER:-gemini}"
  case "$LLM_PROVIDER" in
    gemini|claude|openai|groq|ollama) ;;
    *) err "Unknown LLM_PROVIDER='$LLM_PROVIDER'. Valid values: gemini, claude, openai, groq, ollama" ;;
  esac
  [ "$LLM_PROVIDER" != "ollama" ] && [ -z "$LLM_API_KEY" ] && err "LLM_API_KEY is required for HIVE_MODE=$MODE. Set it in .env."
fi

# ── Config ────────────────────────────────────────────────────────────────────
PORT="${HIVE_PORT:-8080}"
EMB_PORT="${HIVE_EMBEDDER_PORT:-7700}"
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive}"
BOOTSTRAP="${HIVE_BOOTSTRAP:-}"
TOPIC_DOMAIN="${BEE_TOPIC_DOMAIN:-}"
MAX_FRAGS="${HIVE_EXTRACT_MAX_FRAGMENTS:-20}"
INTERVAL_MS="${HIVE_EXTRACT_INTERVAL_MS:-300000}"

# Friendly title per mode
case "$MODE" in
  bee)   TITLE="HIVE — starting BEE (producer only)" ;;
  queen) TITLE="HIVE — starting QUEEN (consumer / indexer)" ;;
  hive)  TITLE="HIVE — starting HIVE (all-in-one)" ;;
esac

echo ""
echo "  🐝  $TITLE"
echo "────────────────────────────────────────"
echo "  Mode    : $MODE"
echo "  Port    : $PORT$([ "$NEEDS_EMBEDDER" = "true" ] && echo " (embedder: $EMB_PORT)" || echo " (no embedder)")"
echo "  Data    : $DATA_DIR"
echo "  Peer    : ${BOOTSTRAP:-none (seed mode)}"
[ "$MODE" = "bee" ] || [ "$MODE" = "hive" ] && echo "  Domain  : ${TOPIC_DOMAIN:-auto-discover}"
echo ""

mkdir -p "$DATA_DIR/vectors" "$DATA_DIR/identity" "$DATA_DIR/corestore"

# ── Embedder (only when the mode needs it) ────────────────────────────────────
if [ "$NEEDS_EMBEDDER" = "true" ]; then
  if alive "http://127.0.0.1:$EMB_PORT/health"; then
    ok "Embedder :$EMB_PORT already running"
  else
    run "Starting embedder on :$EMB_PORT ..."
    HIVE_VECTORS_DIR="$DATA_DIR/vectors" HIVE_EMBEDDER_PORT="$EMB_PORT" \
      nohup python3 packages/embeddings/api_server.py \
      > "/tmp/hive_embedder.log" 2>&1 &

    echo -n "  Loading model"
    for i in $(seq 1 45); do
      alive "http://127.0.0.1:$EMB_PORT/health" && break
      echo -n "."; sleep 2
    done
    echo ""
    alive "http://127.0.0.1:$EMB_PORT/health" || err "Embedder failed. Check /tmp/hive_embedder.log"
    ok "Embedder ready ($(curl -s http://127.0.0.1:$EMB_PORT/health | python3 -c 'import json,sys; print(json.load(sys.stdin).get("indexed",0))') vectors)"
  fi
else
  ok "Bee mode — no embedder needed"
fi

# ── API + node ────────────────────────────────────────────────────────────────
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
EMBEDDER_URL=http://127.0.0.1:$EMB_PORT
HIVE_PEER=$BOOTSTRAP
BEE_TOPIC_DOMAIN=$TOPIC_DOMAIN
HIVE_EXTRACT_MAX_FRAGMENTS=$MAX_FRAGS
HIVE_EXTRACT_INTERVAL_MS=$INTERVAL_MS
EOF

  # `exec` so the subshell BECOMES node → $! is node's real PID, which the
  # signal-forwarding trap below uses to shut it down cleanly (v0.7.7.12).
  ( cd packages/api && exec node --env-file="$tmp_env" --import tsx/esm src/api_server.ts \
      > "/tmp/hive_api.log" 2>&1 ) &
  NODE_PID=$!

  for i in $(seq 1 20); do
    alive "http://127.0.0.1:$PORT/api/status" && break
    sleep 1
  done
fi

# ── Summary ───────────────────────────────────────────────────────────────────
STATUS=$(curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null)
if echo "$STATUS" | grep -q '"ok"'; then
  NODE=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('nodeId','?'))" 2>/dev/null)
  IDX=$(echo "$STATUS"  | python3 -c "import json,sys; print(json.load(sys.stdin).get('indexed','?'))" 2>/dev/null)
  echo ""
  ok "Node running (mode: $MODE)"
  echo "  Node ID : $NODE"
  [ "$NEEDS_EMBEDDER" = "true" ] && echo "  Vectors : $IDX"
  echo ""

  SPACE="${CODESPACE_NAME:-}"
  if [ -n "$SPACE" ]; then
    echo "  UI → https://${SPACE}-${PORT}.app.github.dev"
  else
    echo "  UI → http://localhost:$PORT"
  fi
  if [ "$NEEDS_EMBEDDER" = "true" ]; then
    echo "  Logs → /tmp/hive_api.log  /tmp/hive_embedder.log"
  else
    echo "  Logs → /tmp/hive_api.log"
  fi
else
  err "Node failed to start. Check /tmp/hive_api.log"
fi
echo ""

# Keep the foreground process alive, stream logs, AND forward container stop
# signals to node so it flushes its corestore before exit.
# v0.7.7.12 — was `exec tail`, which made tail PID 1; node was then SIGKILLed
# without a chance to close its Hypercore cleanly, which forked the bee's core
# (the 2026-05-27 incident). Now: trap SIGTERM/SIGINT → forward to node → wait
# for node's graceful shutdown to finish. Needs docker `stop_grace_period`
# longer than the node shutdown (compose sets 30s).
if [ -n "${NODE_PID:-}" ]; then
  trap 'echo "[hive.sh] stop signal — forwarding SIGTERM to node ($NODE_PID)"; kill -TERM "$NODE_PID" 2>/dev/null' TERM INT
  if [ "$NEEDS_EMBEDDER" = "true" ]; then
    tail -f /tmp/hive_api.log /tmp/hive_embedder.log &
  else
    tail -f /tmp/hive_api.log &
  fi
  TAIL_PID=$!
  # `wait` returns when the trap fires; loop until node has truly exited so we
  # don't let the container stop before the clean shutdown finishes.
  while kill -0 "$NODE_PID" 2>/dev/null; do
    wait "$NODE_PID" 2>/dev/null || true
  done
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
fi

# Fallback (node PID unknown): original behaviour.
if [ "$NEEDS_EMBEDDER" = "true" ]; then
  exec tail -f /tmp/hive_api.log /tmp/hive_embedder.log
else
  exec tail -f /tmp/hive_api.log
fi
