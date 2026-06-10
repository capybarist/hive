#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE v0.8 — Queen launcher.
#
# Starts a HIVE queen: joins Hyperswarm, replicates bee Hypercores into an
# in-process LanceDB, embeds only the query (e5-base ONNX int8) and serves
# /api/query + LLM synthesis.
#
# v0.8 cuts the Python embedder + the standalone Qdrant container. Everything
# is one node process — `HIVE_MODE=queen bash hive.sh` would do the same job
# verbatim; this launcher just prints a queen-flavoured banner and waits.
#
# Usage:
#   bash queen.sh                       # queen on default :8090
#
# Required env (for synthesis):
#   LLM_PROVIDER=gemini|claude|openai|groq   (default: groq — fast public path)
#   LLM_API_KEY=your_api_key_here
#
# Optional env:
#   HIVE_PORT           API port (default: 8090)
#   HIVE_DATA_DIR       Data directory (default: ~/.hive-queen)
#
# Direct ingest (docs/direct-mode.md) — accept signed fragment batches from
# direct-transport bees over HTTP, alongside normal P2P replication:
#   HIVE_INGEST_ENABLED=true HIVE_INGEST_TOKEN=<secret> \
#   HIVE_TRUSTED_BEES=<bee_id>:<pubkey>[,...] bash queen.sh
# For a local queen+bee direct pair in ONE command, use `bash direct.sh`.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$(realpath "$0")")"

[ -f .env ] && set -a && source .env && set +a

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }
info(){ echo -e "${C}ℹ${N} $1"; }

# v0.8.12: the internal health probe must send the bearer token when the node
# has HIVE_API_KEY auth enabled (v0.8.7+). Without this, /api/status returns
# 401, the probe never sees "ok", and queen.sh wrongly declares "failed to
# start" → exit → container restart loop every ~30s, which also tears down
# every P2P peer connection on each cycle.
HIVE_API_KEY="${HIVE_API_KEY:-}"
qcurl() {
  if [ -n "$HIVE_API_KEY" ]; then
    curl -s --max-time 2 -H "Authorization: Bearer $HIVE_API_KEY" "$@" 2>/dev/null
  else
    curl -s --max-time 2 "$@" 2>/dev/null
  fi
}
alive() { qcurl "$1" | grep -q '"ok"\|"status"\|"indexed"'; }

PORT="${HIVE_PORT:-8090}"
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive-queen}"

LLM_PROVIDER="${LLM_PROVIDER:-${QUEEN_LLM_PROVIDER:-${AGGREGATOR_LLM_PROVIDER:-groq}}}"
LLM_API_KEY="${LLM_API_KEY:-${QUEEN_LLM_API_KEY:-${AGGREGATOR_LLM_API_KEY:-}}}"
LLM_MODEL="${LLM_MODEL:-${QUEEN_LLM_MODEL:-${AGGREGATOR_LLM_MODEL:-}}}"

case "$LLM_PROVIDER" in
  gemini|claude|openai|groq|ollama) ;;
  *) err "Unknown LLM_PROVIDER='$LLM_PROVIDER'. Valid values: gemini, claude, openai, groq, ollama" ;;
esac
[ "$LLM_PROVIDER" != "ollama" ] && [ -z "$LLM_API_KEY" ] && err "LLM_API_KEY is required (used for synthesis queries)."

echo ""
echo "  🐝  HIVE — Queen  (v0.8 — in-process LanceDB, no Python, no Qdrant)"
echo "  Backend : lancedb"
echo "  LLM     : $LLM_PROVIDER"
echo "  Data    : $DATA_DIR"
echo "────────────────────────────────────────"

mkdir -p "$DATA_DIR/identity" "$DATA_DIR/corestore" "$DATA_DIR/lancedb"

if alive "http://127.0.0.1:$PORT/api/status"; then
  MODE=$(curl -s "http://127.0.0.1:$PORT/api/status" | \
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).mode||'?')}catch{console.log('?')}})" 2>/dev/null)
  ok "Queen :$PORT already running (mode: $MODE)"
else
  run "Starting queen on :$PORT..."

  tmp_env=$(mktemp /tmp/hive_queen_XXXXXX.env)
  [ -f .env ] && { cat .env; echo; } >> "$tmp_env"
  cat >> "$tmp_env" << EOF
HIVE_MODE=queen
HIVE_PORT=$PORT
HIVE_DATA_DIR=$DATA_DIR
LLM_PROVIDER=$LLM_PROVIDER
LLM_API_KEY=$LLM_API_KEY
LLM_MODEL=$LLM_MODEL
EOF

  # Unset LLM vars so --env-file is the sole source of truth. HIVE_MODE is
  # passed explicitly because it must override any inherited value. The Node
  # heap stays generous (2.5GB) since LanceDB writes are in-process and the
  # corestore replays peer history. `exec` so $! is node's real PID for the
  # signal-forwarding trap (v0.7.7.12).
  ( cd packages/api && unset LLM_API_KEY LLM_PROVIDER LLM_MODEL && \
    HIVE_MODE=queen NODE_OPTIONS="--max-old-space-size=2560" exec node --env-file="$tmp_env" \
      --import tsx/esm src/api_server.ts \
      > /tmp/hive_queen.log 2>&1 ) &
  NODE_PID=$!

  # v0.8.14: 120s, not 30s — a queen replicating large bee cores can take
  # well over 30s to open its corestore. The old cap killed a healthy
  # still-loading node → restart loop. See hive.sh for the full rationale.
  for i in $(seq 1 120); do
    alive "http://127.0.0.1:$PORT/api/status" && break
    sleep 1
  done
fi

STATUS=$(qcurl "http://127.0.0.1:$PORT/api/status")
if echo "$STATUS" | grep -q '"ok"'; then
  NODE=$(echo "$STATUS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).nodeId||'?')}catch{console.log('?')}})" 2>/dev/null)
  IDX=$(echo  "$STATUS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).indexed||0)}catch{console.log(0)}})" 2>/dev/null)
  echo ""
  ok "Queen running"
  echo "  Node ID : $NODE"
  echo "  Indexed : $IDX fragments"

  SPACE="${CODESPACE_NAME:-}"
  if [ -n "$SPACE" ]; then
    echo ""
    info "Make port $PORT public in VS Code → Ports tab, then use:"
    echo "  API → https://${SPACE}-${PORT}.app.github.dev"
  else
    echo "  API → http://localhost:$PORT"
  fi

  echo ""
  echo "  Logs → /tmp/hive_queen.log"
  echo ""
  info "Waiting for BEEs to connect via Hyperswarm..."
  echo ""
elif kill -0 "${NODE_PID:-}" 2>/dev/null; then
  # Still loading a large store — process alive, just slow. Hand off rather
  # than kill (the restart-loop fix). Healthcheck flips to healthy once ready.
  info "Queen still starting (large store) — handing off. Watch /tmp/hive_queen.log"
else
  err "Queen process exited during startup. Check /tmp/hive_queen.log"
fi

if [ -n "${NODE_PID:-}" ]; then
  trap 'echo "[queen.sh] stop signal — forwarding SIGTERM to node ($NODE_PID)"; kill -TERM "$NODE_PID" 2>/dev/null' TERM INT
  tail -f /tmp/hive_queen.log &
  TAIL_PID=$!
  while kill -0 "$NODE_PID" 2>/dev/null; do
    wait "$NODE_PID" 2>/dev/null || true
  done
  kill "$TAIL_PID" 2>/dev/null || true
  exit 0
fi

exec tail -f /tmp/hive_queen.log
