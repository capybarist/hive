#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE — Queen launcher (v0.7+, renamed from aggregator.sh)
#
# Starts a HIVE queen node: connects to the P2P network, indexes all
# fragments from every BEE it follows, and exposes a public query API.
# No extraction — read-only from the network's perspective.
#
# The queen is what v0.6 called "aggregator". The rename keeps the bee
# metaphor consistent: bees forage, queens organise. See CLAUDE.md
# v0.7.0 section for the full rationale.
#
# Usage:
#   bash queen.sh                                      # HNSW mode (testing)
#   QDRANT_URL=http://localhost:6333 bash queen.sh     # Qdrant mode (production)
#
# Required env:
#   LLM_PROVIDER=gemini|claude|openai|groq   (default: gemini)
#   LLM_API_KEY=your_api_key_here       (for synthesis queries)
#
# Optional env:
#   QDRANT_URL          Qdrant server URL. If set, uses Qdrant backend.
#                       If not set, uses in-process HNSW (testing only).
#   HIVE_PORT           API port (default: 8090)
#   HIVE_EMBEDDER_PORT  Embedder port (default: 7790)
#   HIVE_DATA_DIR       Data directory (default: ~/.hive-queen)
#   HIVE_PEER           Bootstrap BEE URL to connect on startup
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$(realpath "$0")")"

[ -f .env ] && set -a && source .env && set +a

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }
info(){ echo -e "${C}ℹ${N} $1"; }

alive() { curl -s --max-time 2 "$1" 2>/dev/null | grep -q '"ok"\|"status"\|"indexed"'; }

# ── Config ────────────────────────────────────────────────────────────────────
PORT="${HIVE_PORT:-8090}"
EMB_PORT="${HIVE_EMBEDDER_PORT:-7790}"
DATA_DIR="${HIVE_DATA_DIR:-$HOME/.hive-queen}"
BOOTSTRAP="${HIVE_PEER:-}"
QDRANT_URL="${QDRANT_URL:-}"

# ── Qdrant — wait for it instead of falling back silently ───────────────────
# v0.6.4.4: if QDRANT_URL was set explicitly (Docker Compose path, env-driven
# deployment) we wait up to 60s for it to become ready. Falling back to HNSW
# silently in that case loses the persistent index (the bug we hit when the
# queen restarted faster than Qdrant on Hetzner).
#
# If QDRANT_URL is empty, we use the legacy auto-start path: try localhost,
# auto-launch via docker if available, otherwise HNSW.
QDRANT_URL_EXPLICIT="${QDRANT_URL:-}"
QDRANT_URL="${QDRANT_URL:-http://localhost:6333}"

qdrant_ready() {
  # /readyz returns 200 only when storage is fully open. /healthz is too eager.
  curl -s --max-time 2 -o /dev/null -w '%{http_code}' "$QDRANT_URL/readyz" 2>/dev/null | grep -q '^200$' \
    || curl -s --max-time 2 "$QDRANT_URL/healthz" 2>/dev/null | grep -q 'healthz check passed'
}

if qdrant_ready; then
  ok "Qdrant already running at $QDRANT_URL"
elif [ -n "$QDRANT_URL_EXPLICIT" ]; then
  # Explicit URL — wait, don't auto-start, don't fall back silently.
  echo -n "  Waiting for Qdrant at $QDRANT_URL"
  for i in $(seq 1 60); do
    qdrant_ready && break
    echo -n "."; sleep 1
  done
  echo ""
  if qdrant_ready; then
    ok "Qdrant ready"
  else
    err "Qdrant at $QDRANT_URL never became ready after 60s — aborting to avoid losing the persistent index"
  fi
elif command -v docker &>/dev/null; then
  run "Starting Qdrant via Docker..."
  docker run -d --rm -p 6333:6333 qdrant/qdrant > /dev/null 2>&1
  echo -n "  Waiting for Qdrant"
  for i in $(seq 1 20); do
    qdrant_ready && break
    echo -n "."; sleep 1
  done
  echo ""
  qdrant_ready \
    && ok "Qdrant ready" \
    || { run "Qdrant failed to start — falling back to HNSW"; QDRANT_URL=""; }
else
  run "Docker not available — using HNSW backend (set QDRANT_URL to use Qdrant)"
  QDRANT_URL=""
fi

if [ -n "$QDRANT_URL" ]; then
  BACKEND="qdrant"
else
  BACKEND="hnsw"
fi

# ── Validate ──────────────────────────────────────────────────────────────────
LLM_PROVIDER="${LLM_PROVIDER:-gemini}"
case "$LLM_PROVIDER" in
  gemini|claude|openai|groq|ollama) ;;
  *) err "Unknown LLM_PROVIDER='$LLM_PROVIDER'. Valid values: gemini, claude, openai, groq, ollama" ;;
esac
[ "$LLM_PROVIDER" != "ollama" ] && [ -z "$LLM_API_KEY" ] && err "LLM_API_KEY is required (used for synthesis queries)."

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "  🐝  HIVE — Queen"
echo "  Backend : $BACKEND$([ -n "$QDRANT_URL" ] && echo " ($QDRANT_URL)")"
echo "  LLM     : $LLM_PROVIDER"
echo "  Data    : $DATA_DIR"
[ -n "$BOOTSTRAP" ] && echo "  Peer    : $BOOTSTRAP"
echo "────────────────────────────────────────"

# ── Python embedder ───────────────────────────────────────────────────────────
if alive "http://127.0.0.1:$EMB_PORT/health"; then
  ok "Embedder :$EMB_PORT already running"
else
  run "Starting embedder on :$EMB_PORT (backend: $BACKEND)..."

  EMBEDDER_ENV="HIVE_EMBEDDER_PORT=$EMB_PORT EMBEDDER_BACKEND=$BACKEND"
  [ -n "$QDRANT_URL" ] && EMBEDDER_ENV="$EMBEDDER_ENV QDRANT_URL=$QDRANT_URL"

  ( cd packages/embeddings && \
    eval "nohup env $EMBEDDER_ENV python api_server.py \
      > /tmp/hive_embedder.log 2>&1 &" )

  echo -n "  Loading model"
  for i in $(seq 1 45); do
    alive "http://127.0.0.1:$EMB_PORT/health" && break
    echo -n "."; sleep 2
  done
  echo ""
  alive "http://127.0.0.1:$EMB_PORT/health" || err "Embedder failed. Check /tmp/hive_embedder.log"

  BACKEND_REPORTED=$(curl -s "http://127.0.0.1:$EMB_PORT/health" | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('backend','?'))" 2>/dev/null)
  ok "Embedder ready (backend: $BACKEND_REPORTED)"
fi

# ── Queen node ────────────────────────────────────────────────────────────────
if alive "http://127.0.0.1:$PORT/api/status"; then
  MODE=$(curl -s "http://127.0.0.1:$PORT/api/status" | \
    python3 -c "import json,sys; print(json.load(sys.stdin).get('mode','?'))" 2>/dev/null)
  ok "Queen :$PORT already running (mode: $MODE)"
else
  run "Starting queen on :$PORT..."

  tmp_env=$(mktemp /tmp/hive_queen_XXXXXX.env)
  [ -f .env ] && { cat .env; echo; } >> "$tmp_env"
  cat >> "$tmp_env" << EOF
HIVE_MODE=queen
HIVE_PORT=$PORT
HIVE_DATA_DIR=$DATA_DIR
EMBEDDER_URL=http://127.0.0.1:$EMB_PORT
EMBEDDER_BACKEND=$BACKEND
HIVE_PEER=$BOOTSTRAP
LLM_PROVIDER=$LLM_PROVIDER
LLM_API_KEY=$LLM_API_KEY
LLM_MODEL=${LLM_MODEL:-}
EOF
  [ -n "$QDRANT_URL" ] && echo "QDRANT_URL=$QDRANT_URL" >> "$tmp_env"

  # Unset LLM vars so --env-file is the sole source of truth.
  # HIVE_MODE is passed explicitly because it must override any inherited value.
  #
  # v0.7.6.1 — --max-old-space-size=2560 raises the V8 heap from the ~1.5 GB
  # default to 2.5 GB. Default was crashing the queen on Hetzner with
  # "FATAL ERROR: Reached heap limit Allocation failed". Root cause: the
  # `seen` Set in watchRemoteCore grows to 600k+ string entries while the
  # queen replays a bee's Hypercore from offset 0, plus the replication
  # buffer and remote manifests. The 4 GB box has plenty of headroom; the
  # limit was Node's own heap, not the container.
  ( cd packages/api && unset LLM_API_KEY LLM_PROVIDER LLM_MODEL && \
    HIVE_MODE=queen NODE_OPTIONS="--max-old-space-size=2560" nohup node --env-file="$tmp_env" \
      --import tsx/esm src/api_server.ts \
      > /tmp/hive_queen.log 2>&1 & )

  for i in $(seq 1 20); do
    alive "http://127.0.0.1:$PORT/api/status" && break
    sleep 1
  done
fi

# ── Summary ───────────────────────────────────────────────────────────────────
STATUS=$(curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null)
if echo "$STATUS" | grep -q '"ok"'; then
  NODE=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('nodeId','?'))" 2>/dev/null)
  IDX=$(echo  "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('indexed',0))" 2>/dev/null)
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
  echo "  Logs → /tmp/hive_queen.log  /tmp/hive_embedder.log"
  echo ""
  [ -n "$BOOTSTRAP" ] && info "Connected to bootstrap BEE: $BOOTSTRAP"
  info "Waiting for BEEs to connect via Hyperswarm..."
  echo ""
else
  err "Queen failed to start. Check /tmp/hive_queen.log"
fi

# Keep the container alive and stream logs to stdout.
exec tail -f /tmp/hive_queen.log /tmp/hive_embedder.log
