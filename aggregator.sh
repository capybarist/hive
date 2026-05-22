#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# DEPRECATED in v0.7.0.
#
# `aggregator` was renamed to `queen` to keep the bee metaphor consistent
# (bees forage, queens organise). The script is now a thin wrapper that
# forwards to queen.sh and prints a one-time deprecation notice. It will
# be removed in v0.8.0.
#
# Migrate by replacing any `bash aggregator.sh` invocation with
# `bash queen.sh`. Environment variables and behaviour are identical.
# ─────────────────────────────────────────────────────────────────────────────
cd "$(dirname "$(realpath "$0")")"

Y='\033[1;33m'; N='\033[0m'
echo -e "${Y}⚠  aggregator.sh is deprecated since v0.7.0 — forwarding to queen.sh.${N}"
echo -e "${Y}   Update your scripts to call queen.sh directly. This wrapper goes away in v0.8.${N}"
echo ""

exec bash queen.sh "$@"
