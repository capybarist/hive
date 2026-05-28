#!/usr/bin/env bash
# HIVE v0.8 — launch any number of BEEs from bees/*.env configs.
#
# v0.8 has no Python embedder, so this script just brings up one node process
# per bee config. Each bee carries its own in-process e5-base ONNX embedder.
#
# Usage:
#   bash start.sh                  — start all BEEs in bees/
#   bash start.sh bee-1 bee-2      — start specific BEEs
#   bash start.sh --clean          — wipe all BEE data then start all
#   bash start.sh --clean bee-1    — wipe and start specific BEE

cd "$(dirname "$(realpath "$0")")"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; }
alive() { curl -s --max-time 1 "$1" 2>/dev/null | grep -q '"ok"\|"status"'; }

# ── Handle --clean flag ─────────────────────────────────────────────────────
CLEAN=0
ARGS=()
for arg in "$@"; do
  [ "$arg" = "--clean" ] && CLEAN=1 || ARGS+=("$arg")
done

if [ ${#ARGS[@]} -gt 0 ]; then
  CONFIGS=()
  for name in "${ARGS[@]}"; do
    cfg="bees/${name}.env"
    [ -f "$cfg" ] || cfg="bees/${name}"
    [ -f "$cfg" ] || { err "Config not found: bees/${name}.env"; continue; }
    CONFIGS+=("$cfg")
  done
else
  CONFIGS=(bees/*.env)
fi

[ ${#CONFIGS[@]} -eq 0 ] && { err "No BEE configs found in bees/. Create bees/*.env files."; exit 1; }

echo ""
echo "  🐝  HIVE v0.8 — launching ${#CONFIGS[@]} BEE(s)$([ $CLEAN -eq 1 ] && echo ' [CLEAN]')"
echo "────────────────────────────────────────────"

if [ $CLEAN -eq 1 ]; then
  run "Wiping all BEE runtime data (LanceDB, Hypercore, identity)..."
  for port in 8080 8081 8082 8083 8090; do
    pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null
  done
  sleep 1
  for cfg in "${CONFIGS[@]}"; do
    unset BEE_DATA_DIR BEE_NAME
    set -a; source "$cfg" 2>/dev/null; set +a
    name="${BEE_NAME:-$(basename "$cfg" .env)}"
    abs_data="$(cd packages/api && realpath "$BEE_DATA_DIR" 2>/dev/null || echo "$BEE_DATA_DIR")"
    [ -d "$abs_data" ] && rm -rf "$abs_data"/* && ok "Cleared $name data: $abs_data"
  done
  echo ""
fi

# ── Launch each BEE ─────────────────────────────────────────────────────────
for cfg in "${CONFIGS[@]}"; do
  unset BEE_NAME BEE_PORT BEE_DATA_DIR BEE_PEER
  unset HIVE_OBJECTIVE HIVE_EXTRACT_MAX_FRAGMENTS HIVE_EXTRACT_INTERVAL_MS
  # shellcheck source=/dev/null
  set -a; source "$cfg"; set +a

  name="${BEE_NAME:-$(basename "$cfg" .env)}"
  port="${BEE_PORT:-8080}"
  data_dir="${BEE_DATA_DIR:-../../data}"
  abs_data="$(cd packages/api && realpath "$data_dir" 2>/dev/null || echo "$data_dir")"

  echo ""
  run "BEE: $name  (API :$port)"
  echo "     data: $abs_data"
  [ -n "$HIVE_OBJECTIVE" ] && echo "     objective: ${HIVE_OBJECTIVE:0:70}..."

  mkdir -p "$abs_data/identity" "$abs_data/corestore" "$abs_data/lancedb"

  if alive "http://127.0.0.1:$port/api/status"; then
    ok "API :$port already running"
  else
    # BEEs with a peer must wait for previous BEEs to register claims first.
    # Without this, simultaneous starts cause all BEEs to see unclaimed topics
    # and pick the same ones (race condition).
    if [ -n "$BEE_PEER" ]; then
      run "Waiting for peer $BEE_PEER to register its topic claims..."
      for i in $(seq 1 20); do
        alive "$BEE_PEER/api/status" && break
        sleep 1
      done
      sleep 12
      ok "Peer ready — starting $name"
    fi

    run "Starting API :$port ..."
    tmp_env=$(mktemp /tmp/hive_bee_XXXXXX)
    [ -f .env ] && { cat .env; echo; } >> "$tmp_env"
    { cat "$cfg"; echo; } >> "$tmp_env"
    printf '\nHIVE_PORT=%s\nHIVE_DATA_DIR=%s\n' "$port" "$abs_data" >> "$tmp_env"
    [ -n "$BEE_PEER" ] && printf 'HIVE_PEER=%s\n' "$BEE_PEER" >> "$tmp_env"

    # Unset LLM vars so --env-file is the sole source of truth (node --env-file
    # does not override variables already present in the inherited environment).
    ( cd packages/api && unset LLM_API_KEY LLM_PROVIDER LLM_MODEL && \
      nohup node --env-file="$tmp_env" --import tsx/esm src/api_server.ts \
        > "/tmp/hive_api_${name}.log" 2>&1 & )
  fi
done

echo ""
for cfg in "${CONFIGS[@]}"; do
  source "$cfg" 2>/dev/null
  port="${BEE_PORT:-8080}"
  for i in $(seq 1 30); do
    alive "http://127.0.0.1:$port/api/status" && break
    sleep 1
  done
done

echo ""
echo "════════════════════════════════════════════"
SPACE="${CODESPACE_NAME:-}"
for cfg in "${CONFIGS[@]}"; do
  source "$cfg" 2>/dev/null
  name="${BEE_NAME:-$(basename "$cfg" .env)}"
  port="${BEE_PORT:-8080}"
  STATUS=$(curl -s --max-time 3 "http://127.0.0.1:$port/api/status" 2>/dev/null)
  if echo "$STATUS" | grep -q '"ok"'; then
    node=$(echo "$STATUS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log((JSON.parse(s).nodeId||'?').slice(0,20))}catch{console.log('?')}})" 2>/dev/null)
    idx=$(echo "$STATUS"  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).indexed||'?')}catch{console.log('?')}})" 2>/dev/null)
    ok "$name :$port  →  $node  |  $idx vectors"
    if [ -n "$SPACE" ]; then
      echo "     UI → https://${SPACE}-${port}.app.github.dev"
    else
      echo "     UI → http://localhost:$port"
    fi
  else
    err "$name :$port — not responding (check /tmp/hive_api_${name}.log)"
  fi
done
echo "════════════════════════════════════════════"
echo ""
echo "Logs: /tmp/hive_api_{name}.log"
echo ""
