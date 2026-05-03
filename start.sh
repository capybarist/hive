#!/usr/bin/env bash
# HIVE — start all services
# Usage: bash start.sh
# Run from anywhere inside the repo

cd "$(dirname "$(realpath "$0")")"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; }

alive() { curl -s --max-time 1 "$1" 2>/dev/null | grep -q '"ok"\|"status"'; }

echo ""
echo "  🐝  HIVE startup"
echo "──────────────────────────────────────"

# ── Embedder A (port 7700) ────────────────────────────────────────────────────
if alive http://127.0.0.1:7700/health; then
  ok "Embedder A :7700 already running"
else
  run "Starting Embedder A :7700..."
  pkill -f "HIVE_EMBEDDER_PORT=7700\|api_server.py" 2>/dev/null; sleep 0.5
  nohup python3 packages/embeddings/api_server.py > /tmp/hive_emb_a.log 2>&1 &
fi

# ── Embedder B (port 7701) ────────────────────────────────────────────────────
if alive http://127.0.0.1:7701/health; then
  ok "Embedder B :7701 already running"
else
  run "Starting Embedder B :7701..."
  nohup env HIVE_VECTORS_DIR="$(pwd)/data_b/vectors" HIVE_EMBEDDER_PORT=7701 \
    python3 packages/embeddings/api_server.py > /tmp/hive_emb_b.log 2>&1 &
fi

# ── Wait for embedders ────────────────────────────────────────────────────────
echo -n "  Waiting for embedders"
for i in $(seq 1 25); do
  alive http://127.0.0.1:7700/health && alive http://127.0.0.1:7701/health && break
  echo -n "."; sleep 2
done
echo ""

if alive http://127.0.0.1:7700/health && alive http://127.0.0.1:7701/health; then
  A=$(curl -s http://127.0.0.1:7700/health | python3 -c "import json,sys; print(json.load(sys.stdin)['indexed'])" 2>/dev/null)
  B=$(curl -s http://127.0.0.1:7701/health | python3 -c "import json,sys; print(json.load(sys.stdin)['indexed'])" 2>/dev/null)
  ok "Embedders ready — A: ${A} vectors | B: ${B} vectors"
else
  err "Embedders failed. Check /tmp/hive_emb_a.log or /tmp/hive_emb_b.log"
  exit 1
fi

# ── API A (port 8080) ─────────────────────────────────────────────────────────
if alive http://127.0.0.1:8080/api/status; then
  ok "API Node A :8080 already running"
else
  run "Starting API Node A :8080..."
  ( cd packages/api && nohup npm start > /tmp/hive_api_a.log 2>&1 & )
  sleep 5
fi

# ── API B (port 8081) ─────────────────────────────────────────────────────────
if alive http://127.0.0.1:8081/api/status; then
  ok "API Node B :8081 already running"
else
  run "Starting API Node B :8081..."
  ( cd packages/api && nohup npm run start:b > /tmp/hive_api_b.log 2>&1 & )
  sleep 5
fi

# ── Final check ───────────────────────────────────────────────────────────────
echo ""
for PORT in 8080 8081; do
  STATUS=$(curl -s --max-time 3 http://127.0.0.1:$PORT/api/status 2>/dev/null)
  if echo "$STATUS" | grep -q '"ok"'; then
    NODE=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin)['nodeId'][:20])" 2>/dev/null)
    IDX=$(echo "$STATUS"  | python3 -c "import json,sys; print(json.load(sys.stdin)['indexed'])"    2>/dev/null)
    PRS=$(echo "$STATUS"  | python3 -c "import json,sys; print(json.load(sys.stdin)['peers'])"      2>/dev/null)
    ok "Node :$PORT  $NODE  $IDX vectors  $PRS peers"
  else
    err "Node :$PORT not responding — check /tmp/hive_api_$([ $PORT = 8080 ] && echo a || echo b).log"
  fi
done

SPACE="${CODESPACE_NAME:-}"
echo ""
if [ -n "$SPACE" ]; then
  echo "  Node A → https://${SPACE}-8080.app.github.dev"
  echo "  Node B → https://${SPACE}-8081.app.github.dev"
else
  echo "  Node A → http://localhost:8080"
  echo "  Node B → http://localhost:8081"
fi
echo ""
