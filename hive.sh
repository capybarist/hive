#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE — single-BEE launcher (production)
#
# Usage:
#   bash hive.sh                         # start BEE on default port 8080
#   HIVE_PORT=8081 bash hive.sh          # custom port
#   HIVE_BOOTSTRAP=http://peer.example   # connect to existing network
#   BEE_TOPIC_DOMAIN=health bash hive.sh # soft topic preference
#
# Required env:
#   LLM_PROVIDER=gemini|claude|openai|groq   (default: gemini)
#   LLM_API_KEY=your_api_key_here
#
# Optional env:
#   LLM_MODEL                 (override default model for the provider)
#   HIVE_PORT                 (default: 8080)
#   HIVE_EMBEDDER_PORT        (default: 7700)
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

# ── Validate ──────────────────────────────────────────────────────────────────
LLM_PROVIDER="${LLM_PROVIDER:-gemini}"
case "$LLM_PROVIDER" in
  gemini|claude|openai|groq) ;;
  *) err "Unknown LLM_PROVIDER='$LLM_PROVIDER'. Valid values: gemini, claude, openai, groq" ;;
esac
[ -z "$LLM_API_KEY" ] && err "LLM_API_KEY is required. Set it in your environment or in a .env file."

# ── Config ────────────────────────────────────────────────────────────────────
PORT="${HIVE_PORT:-8080}"
EMB_PORT="${HIVE_EMBEDDER_PORT:-7700}"
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive}"
BOOTSTRAP="${HIVE_BOOTSTRAP:-}"
TOPIC_DOMAIN="${BEE_TOPIC_DOMAIN:-}"
MAX_FRAGS="${HIVE_EXTRACT_MAX_FRAGMENTS:-20}"
INTERVAL_MS="${HIVE_EXTRACT_INTERVAL_MS:-300000}"

echo ""
echo "  🐝  HIVE — starting BEE"
echo "────────────────────────────────────────"
echo "  Port    : $PORT (embedder: $EMB_PORT)"
echo "  Data    : $DATA_DIR"
echo "  Peer    : ${BOOTSTRAP:-none (seed mode)}"
echo "  Domain  : ${TOPIC_DOMAIN:-auto-discover}"
echo ""

mkdir -p "$DATA_DIR/vectors" "$DATA_DIR/identity" "$DATA_DIR/corestore"

# ── Embedder ──────────────────────────────────────────────────────────────────
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

# ── API + BEE ─────────────────────────────────────────────────────────────────
if alive "http://127.0.0.1:$PORT/api/status"; then
  ok "BEE :$PORT already running"
else
  run "Starting BEE on :$PORT ..."

  tmp_env=$(mktemp /tmp/hive_XXXXXX.env)
  [ -f .env ] && cat .env >> "$tmp_env"
  cat >> "$tmp_env" << EOF
HIVE_PORT=$PORT
HIVE_DATA_DIR=$DATA_DIR
EMBEDDER_URL=http://127.0.0.1:$EMB_PORT
HIVE_PEER=$BOOTSTRAP
BEE_TOPIC_DOMAIN=$TOPIC_DOMAIN
HIVE_EXTRACT_MAX_FRAGMENTS=$MAX_FRAGS
HIVE_EXTRACT_INTERVAL_MS=$INTERVAL_MS
EOF

  ( cd packages/api && nohup node --env-file="$tmp_env" --import tsx/esm src/api_server.ts \
      > "/tmp/hive_api.log" 2>&1 & )

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
  ok "BEE running"
  echo "  Node ID : $NODE"
  echo "  Vectors : $IDX"
  echo ""

  SPACE="${CODESPACE_NAME:-}"
  if [ -n "$SPACE" ]; then
    echo "  UI → https://${SPACE}-${PORT}.app.github.dev"
  else
    echo "  UI → http://localhost:$PORT"
  fi
  echo "  Logs → /tmp/hive_api.log  /tmp/hive_embedder.log"
else
  err "BEE failed to start. Check /tmp/hive_api.log"
fi
echo ""
