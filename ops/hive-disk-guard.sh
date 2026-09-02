#!/usr/bin/env bash
# Hard ceiling for the public HIVE demo.
#
# The disk has filled twice (2026-06-09, 2026-09-02). Both times the chain was
# the same: bees forage without a bound → LanceDB grows → compaction needs
# headroom it no longer has → queen stalls → MVCC versions pile up → 0 bytes and
# every container dead. Rate limits only slow that down; nothing stopped it.
#
# So: stop foraging at a threshold that still leaves the queen room to compact.
# The queen keeps serving the demo read-only, which is the point of the node.
# Restarting the bees is deliberate — see /var/log/hive-disk-guard.log.
set -euo pipefail
THRESHOLD=${THRESHOLD:-70}
LOG=/var/log/hive-disk-guard.log
USED=$(df --output=pcent / | tail -1 | tr -dc '0-9')

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }

if [ "$USED" -ge "$THRESHOLD" ]; then
  stopped=""
  for b in hive-bee-1 hive-bee-2; do
    if running "$b"; then
      docker update --restart=no "$b" >/dev/null 2>&1 || true
      docker stop "$b" >/dev/null 2>&1 || true
      stopped="$stopped $b"
    fi
  done
  [ -n "$stopped" ] && echo "$(date -Is) disk ${USED}% >= ${THRESHOLD}% — stopped:$stopped" >> "$LOG"
fi
