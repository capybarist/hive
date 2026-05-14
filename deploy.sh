#!/usr/bin/env bash
# HIVE — VPS deployment script
# Installs Docker + Docker Compose and launches the full stack.
#
# Usage on a fresh Ubuntu/Debian VPS:
#   curl -fsSL https://raw.githubusercontent.com/capybarist/hive/main/deploy.sh | bash
#
# Or after cloning:
#   LLM_API_KEY=gsk_xxx bash deploy.sh

set -e

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; C='\033[0;36m'; N='\033[0m'
ok()  { echo -e "${G}✓${N} $1"; }
run() { echo -e "${Y}→${N} $1"; }
err() { echo -e "${R}✗${N} $1"; exit 1; }
info(){ echo -e "${C}ℹ${N} $1"; }

echo ""
echo "  🐝  HIVE — VPS Deployment"
echo "────────────────────────────────────────"

# ── Check LLM key ─────────────────────────────────────────────────────────────
if [ -z "$LLM_API_KEY" ] && [ ! -f ".env" ]; then
  err "LLM_API_KEY not set. Run: LLM_API_KEY=your_key bash deploy.sh
  Or create a .env file first: cp .env.example .env && nano .env"
fi

# ── Install Docker if needed ──────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  run "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  ok "Docker installed"
else
  ok "Docker already installed ($(docker --version | cut -d' ' -f3 | tr -d ','))"
fi

# ── Install Docker Compose plugin if needed ───────────────────────────────────
if ! docker compose version &>/dev/null 2>&1; then
  run "Installing Docker Compose plugin..."
  apt-get install -y docker-compose-plugin 2>/dev/null || \
    curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" \
      -o /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose
  ok "Docker Compose installed"
else
  ok "Docker Compose already installed"
fi

# ── Fetch latest docker-compose.yml if not present ───────────────────────────
if [ ! -f "docker-compose.yml" ]; then
  run "Downloading docker-compose.yml..."
  curl -fsSL https://raw.githubusercontent.com/capybarist/hive/main/docker-compose.yml -o docker-compose.yml
  ok "docker-compose.yml downloaded"
fi

# ── Create .env from env vars or example ─────────────────────────────────────
if [ ! -f ".env" ]; then
  run "Creating .env..."
  if [ ! -f ".env.example" ]; then
    curl -fsSL https://raw.githubusercontent.com/capybarist/hive/main/.env.example -o .env.example
  fi
  cp .env.example .env
  # Inject the key if passed as env var
  [ -n "$LLM_API_KEY"   ] && sed -i "s|LLM_API_KEY=.*|LLM_API_KEY=${LLM_API_KEY}|" .env
  [ -n "$LLM_PROVIDER"  ] && sed -i "s|LLM_PROVIDER=.*|LLM_PROVIDER=${LLM_PROVIDER}|" .env
  [ -n "$LLM_MODEL"     ] && sed -i "s|# LLM_MODEL=.*|LLM_MODEL=${LLM_MODEL}|" .env
  [ -n "$DOMAIN"        ] && sed -i "s|# DOMAIN=.*|DOMAIN=${DOMAIN}|" .env
  ok ".env created"
fi

# ── Pull latest images ────────────────────────────────────────────────────────
run "Pulling latest HIVE image..."
docker pull ghcr.io/capybarist/hive:latest
docker pull qdrant/qdrant:v1.9.2
ok "Images ready"

# ── Launch ────────────────────────────────────────────────────────────────────
run "Starting HIVE stack (bee-1, bee-2, aggregator, qdrant)..."
docker compose up -d

# ── Wait for aggregator (via Caddy on :80) ───────────────────────────────────
echo -n "  Waiting for aggregator"
for i in $(seq 1 60); do
  curl -s --max-time 2 "http://localhost/api/status" 2>/dev/null | grep -q '"ok"' && break
  echo -n "."; sleep 3
done
echo ""

STATUS=$(curl -s http://localhost/api/status 2>/dev/null)
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo 'YOUR_IP')
DOMAIN_VAL=$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2)
if [ -n "$DOMAIN_VAL" ]; then
  PUBLIC_URL="https://${DOMAIN_VAL}"
else
  PUBLIC_URL="http://${PUBLIC_IP}"
fi

if echo "$STATUS" | grep -q '"ok"'; then
  INDEXED=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('indexed',0))" 2>/dev/null)
  PEERS=$(echo "$STATUS" | python3 -c "import json,sys; print(json.load(sys.stdin).get('peers',0))" 2>/dev/null)
  ok "Aggregator running — indexed=${INDEXED} peers=${PEERS}"
  echo ""
  info "Public API: ${PUBLIC_URL}"
  info "Qdrant:     http://localhost:6333/dashboard  (local only)"
  echo ""
  info "Add NEXT_PUBLIC_HIVE_AGGREGATOR_URL=${PUBLIC_URL}"
  info "to your capybarahome .env.local to enable the live widget."
else
  err "Aggregator not responding. Check: docker compose logs aggregator"
fi

echo ""
echo "  Commands:"
echo "  docker compose logs -f          # stream all logs"
echo "  docker compose logs aggregator  # aggregator only"
echo "  docker compose down             # stop everything"
echo "  docker compose pull && docker compose up -d  # update"
echo ""
