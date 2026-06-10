#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# HIVE — direct-mode local sandbox (docs/direct-mode.md).
#
# One command brings up a wired BEE→QUEEN pair on this machine with NO P2P
# in between: the bee runs HIVE_TRANSPORT=direct and POSTs signed fragment
# batches to the queen's /internal/ingest. The script does the allowlist
# handshake for you (pre-creates the bee identity, puts bee_id:pubkey in the
# queen's HIVE_TRUSTED_BEES) — the manual two-step from docs/direct-mode.md
# is only needed when bee and queen live on different machines.
#
# Usage:
#   bash direct.sh                       # queen :8090 + direct bee :8080
#   HIVE_OBJECTIVE='"Quantum computing"' bash direct.sh
#   bash direct.sh clean                 # stop is Ctrl+C; clean wipes the sandbox
#
# Optional env:
#   HIVE_DIRECT_DIR     sandbox root (default: ~/.hive-direct)
#   DIRECT_QUEEN_PORT   queen API port (default: 8090)
#   DIRECT_BEE_PORT     bee API port  (default: 8080)
#   HIVE_INGEST_TOKEN   shared secret (default: generated once, persisted)
#   LLM_PROVIDER/KEY    only needed for synthesis; raw-fragment queries
#                       (`"use_llm": false`) work with no LLM at all.
#
# NOTE the queen still joins the public Hyperswarm commons (direct ingest and
# p2p replication coexist by design), so /api/status `indexed` may include
# fragments replicated from public bees. Filter queries by the sandbox bee's
# node_id (printed below) to see exactly what travelled over HTTP.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$(realpath "$0")")"

[ -f .env ] && set -a && source .env && set +a

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }
info(){ echo -e "${C}ℹ${N} $1"; }

alive() { curl -s --max-time 1 "$1" 2>/dev/null | grep -q '"ok"\|"status"'; }

SANDBOX="${HIVE_DIRECT_DIR:-$HOME/.hive-direct}"
QUEEN_PORT="${DIRECT_QUEEN_PORT:-8090}"
BEE_PORT="${DIRECT_BEE_PORT:-8080}"
QUEEN_DATA="$SANDBOX/queen"
BEE_DATA="$SANDBOX/bee"
QUEEN_LOG="/tmp/hive_direct_queen.log"
BEE_LOG="/tmp/hive_direct_bee.log"

if [ "${1:-}" = "clean" ]; then
  rm -rf "$SANDBOX"
  ok "Sandbox wiped ($SANDBOX)"
  exit 0
fi

mkdir -p "$QUEEN_DATA" "$BEE_DATA"

# ── Shared ingest token (generated once, reused across restarts) ────────────
TOKEN_FILE="$SANDBOX/ingest.token"
if [ -z "${HIVE_INGEST_TOKEN:-}" ]; then
  if [ ! -f "$TOKEN_FILE" ]; then
    (openssl rand -hex 24 2>/dev/null || echo "dev-$RANDOM$RANDOM$RANDOM") > "$TOKEN_FILE"
  fi
  HIVE_INGEST_TOKEN="$(cat "$TOKEN_FILE")"
fi

# ── Allowlist handshake: pre-create the bee identity, derive bee_id:pubkey ──
run "Resolving bee identity (allowlist handshake)…"
TRUSTED=$(node --import tsx/esm -e "
import { loadOrCreateIdentity } from './packages/core/src/node_identity.js';
const id = loadOrCreateIdentity('$BEE_DATA/identity');
console.log(id.nodeId + ':' + id.publicKeyHex);" 2>/dev/null | tail -1)
BEE_ID="${TRUSTED%%:*}"
[ -n "$BEE_ID" ] || err "Could not create/read the bee identity. Run 'npm install' first?"
ok "Bee identity: $BEE_ID"

echo ""
echo "  🐝  HIVE — direct-mode sandbox (bee → queen over HTTP, no P2P between them)"
echo "────────────────────────────────────────"
echo "  Queen   : :$QUEEN_PORT  ($QUEEN_DATA)"
echo "  Bee     : :$BEE_PORT  ($BEE_DATA, HIVE_TRANSPORT=direct)"
echo "  Token   : $HIVE_INGEST_TOKEN"
echo ""

# ── Queen (ingest enabled) ───────────────────────────────────────────────────
QUEEN_PID=""
if alive "http://127.0.0.1:$QUEEN_PORT/api/status"; then
  ok "Queen :$QUEEN_PORT already running"
else
  run "Starting queen on :$QUEEN_PORT …"
  qenv=$(mktemp /tmp/hive_direct_queen_XXXXXX.env)
  [ -f .env ] && { cat .env; echo; } >> "$qenv"
  cat >> "$qenv" << EOF
HIVE_MODE=queen
HIVE_PORT=$QUEEN_PORT
HIVE_DATA_DIR=$QUEEN_DATA
HIVE_INGEST_ENABLED=true
HIVE_INGEST_TOKEN=$HIVE_INGEST_TOKEN
HIVE_TRUSTED_BEES=$TRUSTED
RUST_LOG=error
EOF
  ( cd packages/api && exec node --env-file="$qenv" --import tsx/esm src/api_server.ts \
      > "$QUEEN_LOG" 2>&1 ) &
  QUEEN_PID=$!
  for i in $(seq 1 120); do alive "http://127.0.0.1:$QUEEN_PORT/api/status" && break; sleep 1; done
  alive "http://127.0.0.1:$QUEEN_PORT/api/status" || err "Queen did not come up — check $QUEEN_LOG"
  ok "Queen up (ingest ✓, 1 trusted bee)"
fi

# ── Bee (direct transport) ───────────────────────────────────────────────────
BEE_PID=""
if alive "http://127.0.0.1:$BEE_PORT/api/status"; then
  ok "Bee :$BEE_PORT already running"
else
  run "Starting direct bee on :$BEE_PORT …"
  benv=$(mktemp /tmp/hive_direct_bee_XXXXXX.env)
  [ -f .env ] && { cat .env; echo; } >> "$benv"
  cat >> "$benv" << EOF
HIVE_MODE=bee
HIVE_PORT=$BEE_PORT
HIVE_DATA_DIR=$BEE_DATA
HIVE_TRANSPORT=direct
HIVE_QUEEN_URL=http://127.0.0.1:$QUEEN_PORT
HIVE_INGEST_TOKEN=$HIVE_INGEST_TOKEN
HIVE_AUTOSTART=1
HIVE_OBJECTIVE=${HIVE_OBJECTIVE:-Find knowledge about "Photosynthesis"}
HIVE_EXTRACT_MAX_FRAGMENTS=${HIVE_EXTRACT_MAX_FRAGMENTS:-12}
HIVE_EXTRACT_BUDGET_MINUTES=${HIVE_EXTRACT_BUDGET_MINUTES:-3}
HIVE_EXTRACT_INTERVAL_MS=${HIVE_EXTRACT_INTERVAL_MS:-30000}
RUST_LOG=error
EOF
  ( cd packages/api && exec node --env-file="$benv" --import tsx/esm src/api_server.ts \
      > "$BEE_LOG" 2>&1 ) &
  BEE_PID=$!
  for i in $(seq 1 120); do alive "http://127.0.0.1:$BEE_PORT/api/status" && break; sleep 1; done
  alive "http://127.0.0.1:$BEE_PORT/api/status" || err "Bee did not come up — check $BEE_LOG"
  ok "Bee up (direct → http://127.0.0.1:$QUEEN_PORT)"
fi

echo ""
ok "Sandbox running. First delivery appears after the first extraction cycle (~30–60 s):"
echo "    bee   log: grep '\[direct\] delivered batch' $BEE_LOG"
echo "    queen log: grep '\[ingest\]' $QUEEN_LOG"
echo ""
echo "  Query what travelled over HTTP (no LLM needed):"
echo "    curl -s -X POST http://127.0.0.1:$QUEEN_PORT/api/query -H 'content-type: application/json' \\"
echo "      -d '{\"question\":\"How do plants convert light into energy?\",\"use_llm\":false,\"filters\":{\"node_id\":\"$BEE_ID\"}}'"
echo ""
echo "  UI: queen http://localhost:$QUEEN_PORT · bee http://localhost:$BEE_PORT (badge: bee · direct)"
echo "  Ctrl+C stops both. 'bash direct.sh clean' wipes the sandbox."
echo ""

# Keep foreground; forward stop signals to both nodes so stores flush cleanly.
trap 'echo "[direct.sh] stop — forwarding SIGTERM"; kill -TERM ${QUEEN_PID:-} ${BEE_PID:-} 2>/dev/null' TERM INT
tail -f "$BEE_LOG" "$QUEEN_LOG" &
TAIL_PID=$!
while { [ -n "$QUEEN_PID" ] && kill -0 "$QUEEN_PID" 2>/dev/null; } || { [ -n "$BEE_PID" ] && kill -0 "$BEE_PID" 2>/dev/null; }; do
  sleep 2
done
kill "$TAIL_PID" 2>/dev/null || true
