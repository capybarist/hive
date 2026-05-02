#!/usr/bin/env bash
# HIVE startup script — run from the hive/ directory
# Usage: ./start.sh

set -e
cd "$(dirname "$0")"

YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[HIVE]${NC} $1"; }
warn() { echo -e "${YELLOW}[HIVE]${NC} $1"; }
err()  { echo -e "${RED}[HIVE]${NC} $1"; }

# ── Kill anything already on these ports ──────────────────────────────────────
for PORT in 7700 7701 8080 8081; do
  PID=$(ss -tlnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null && warn "Killed stale process on :$PORT (PID $PID)"
done
sleep 1

# ── Embedder A (Node A, port 7700, data/vectors) ─────────────────────────────
log "Starting Embedder A on :7700 ..."
nohup python3 packages/embeddings/api_server.py \
  > /tmp/hive_emb_a.log 2>&1 &
EMB_A_PID=$!

# ── Embedder B (Node B, port 7701, data_b/vectors) ───────────────────────────
log "Starting Embedder B on :7701 ..."
HIVE_VECTORS_DIR="$(pwd)/data_b/vectors" HIVE_EMBEDDER_PORT=7701 \
  nohup python3 packages/embeddings/api_server.py \
  > /tmp/hive_emb_b.log 2>&1 &
EMB_B_PID=$!

# ── Wait for embedders (model loads in ~20s) ──────────────────────────────────
warn "Waiting for embedding model to load (~20s)..."
for i in $(seq 1 30); do
  A_OK=$(curl -s --max-time 1 http://127.0.0.1:7700/health 2>/dev/null | grep -c '"ok"' || true)
  B_OK=$(curl -s --max-time 1 http://127.0.0.1:7701/health 2>/dev/null | grep -c '"ok"' || true)
  [ "$A_OK" -ge 1 ] && [ "$B_OK" -ge 1 ] && break
  sleep 2
done

A_STATUS=$(curl -s http://127.0.0.1:7700/health 2>/dev/null)
B_STATUS=$(curl -s http://127.0.0.1:7701/health 2>/dev/null)
log "Embedder A: $A_STATUS"
log "Embedder B: $B_STATUS"

# ── API A (Node A, port 8080) ─────────────────────────────────────────────────
log "Starting API Node A on :8080 ..."
cd packages/api
nohup node --env-file=../../.env --import tsx/esm src/api_server.ts \
  > /tmp/hive_api_a.log 2>&1 &
API_A_PID=$!
sleep 3

# ── API B (Node B, port 8081) ─────────────────────────────────────────────────
log "Starting API Node B on :8081 ..."
nohup node --env-file=../../.env --env-file=../../.env.node-b --import tsx/esm src/api_server.ts \
  > /tmp/hive_api_b.log 2>&1 &
API_B_PID=$!
cd ../..

# ── Wait for APIs ─────────────────────────────────────────────────────────────
warn "Waiting for API servers..."
for i in $(seq 1 20); do
  A_OK=$(curl -s --max-time 1 http://127.0.0.1:8080/api/status 2>/dev/null | grep -c '"ok"' || true)
  B_OK=$(curl -s --max-time 1 http://127.0.0.1:8081/api/status 2>/dev/null | grep -c '"ok"' || true)
  [ "$A_OK" -ge 1 ] && [ "$B_OK" -ge 1 ] && break
  sleep 2
done

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
for PORT in 8080 8081; do
  STATUS=$(curl -s http://127.0.0.1:$PORT/api/status 2>/dev/null)
  if echo "$STATUS" | grep -q '"ok"'; then
    NODE=$(echo "$STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['nodeId'])" 2>/dev/null)
    IDX=$(echo "$STATUS"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['indexed'])" 2>/dev/null)
    PRS=$(echo "$STATUS"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['peers'])" 2>/dev/null)
    log "Node :$PORT → $NODE | $IDX vectors | $PRS peers"
  else
    err "Node :$PORT — NOT RESPONDING (check /tmp/hive_api_$([ $PORT = 8080 ] && echo a || echo b).log)"
  fi
done
echo "════════════════════════════════════════════════════"
echo ""

CODESPACE="${CODESPACE_NAME:-localhost}"
if [ "$CODESPACE" != "localhost" ]; then
  echo "  Node A UI → https://${CODESPACE}-8080.app.github.dev"
  echo "  Node B UI → https://${CODESPACE}-8081.app.github.dev"
  echo ""
  echo "  ⚠  In VS Code Ports tab: set both ports to PUBLIC"
else
  echo "  Node A UI → http://localhost:8080"
  echo "  Node B UI → http://localhost:8081"
fi
echo ""
echo "Logs: /tmp/hive_emb_a.log  /tmp/hive_emb_b.log"
echo "      /tmp/hive_api_a.log  /tmp/hive_api_b.log"
