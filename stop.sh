#!/usr/bin/env bash
# HIVE v0.8 — stop all node processes for the local dev launcher.
#
# Usage:
#   bash stop.sh          — stop everything
#   bash stop.sh --force  — skip graceful shutdown, kill -9 immediately
#
# v0.8 has no Python embedder, so there is no separate embedder process to kill.

cd "$(dirname "$(realpath "$0")")"

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; }

FORCE=0
[ "$1" = "--force" ] && FORCE=1

killed=0

kill_pattern() {
  local label="$1"
  local pattern="$2"
  local pids
  pids=$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')
  [ -z "$pids" ] && return

  if [ $FORCE -eq 0 ]; then
    # Graceful SIGTERM first
    echo "$pids" | xargs kill -SIGTERM 2>/dev/null
    sleep 1
    pids=$(pgrep -f "$pattern" 2>/dev/null | tr '\n' ' ')
    [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
  else
    echo "$pids" | xargs kill -9 2>/dev/null
  fi

  local count
  count=$(echo "$pids" | wc -w | tr -d ' ')
  ok "Stopped $label ($count process(es))"
  killed=$((killed + count))
}

echo ""
echo "  HIVE — stopping all node processes$([ $FORCE -eq 1 ] && echo ' [--force]')"
echo "────────────────────────────────────────"

# BEE/Queen API servers (node + tsx)
kill_pattern "HIVE node processes" "packages/api.*api_server"

# Clean up temp env files created by start.sh / hive.sh / queen.sh
tmp_files=$(ls /tmp/hive_*.env 2>/dev/null)
if [ -n "$tmp_files" ]; then
  count=$(echo "$tmp_files" | wc -l | tr -d ' ')
  rm -f /tmp/hive_*.env
  ok "Removed $count temp env file(s)"
fi

# ── Verify ports are free (and force-kill stragglers if --force) ────────────
echo ""
still_running=()
for port in 8080 8081 8082 8083 8090; do
  pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -z "$pid" ] && continue
  if [ $FORCE -eq 1 ]; then
    kill -9 "$pid" 2>/dev/null && ok "Force-killed pid $pid on port $port" || err "Could not kill pid $pid"
    killed=$((killed + 1))
  else
    still_running+=("port $port (pid=$pid)")
  fi
done

if [ $FORCE -eq 1 ]; then
  still_running=()
  for port in 8080 8081 8082 8083 8090; do
    pid=$(ss -tlnp 2>/dev/null | grep ":${port} " | grep -oP 'pid=\K[0-9]+' | head -1)
    [ -n "$pid" ] && still_running+=("port $port (pid=$pid)")
  done
fi

if [ ${#still_running[@]} -gt 0 ]; then
  err "Still occupied: ${still_running[*]}"
  [ $FORCE -eq 0 ] && err "Run with --force to kill immediately"
  exit 1
elif [ $killed -eq 0 ]; then
  run "No HIVE processes were running"
else
  ok "All done — ports 8080-8083 and 8090 are free"
fi
echo ""
