# HIVE — Heuristic Intelligent Vector Extraction

**A decentralized, verifiable knowledge base built for LLMs.**  
A P2P network of autonomous BEEs that extract, sign, and sync knowledge.

> *What Wikipedia is for humans — but for machines.*

→ **[Read the Manifesto](./MANIFESTO.md)** — why this exists and where it's going.

---

## Quick start

### Option 1 — Docker (recommended, no dependencies)

```bash
docker run -d \
  -e GEMINI_API_KEY=your_key_here \
  -p 8080:8080 \
  -v hive-data:/hive/data \
  ghcr.io/capybarist/hive:latest
```

Open http://localhost:8080 — your BEE will self-configure and start indexing.

### Option 2 — npx (Node.js 20+ and Python 3.10+ required)

```bash
# Set your API key
export GEMINI_API_KEY=your_key_here

# Run (installs everything automatically on first run)
npx hive-network
```

### Option 3 — From source

```bash
git clone https://github.com/capybarist/hive.git && cd hive
npm install
pip install -r packages/embeddings/requirements.txt
echo "GEMINI_API_KEY=your_key_here" > .env
bash hive.sh
```

The BEE starts, scans the network, **chooses an uncovered topic from the knowledge tree**, and begins indexing. No manual topic configuration needed.

> Data persists between restarts. Run `bash start.sh --clean` only when explicitly upgrading to a new incompatible version.

---

## Opciones de configuración (todas opcionales)

```bash
# Conectar a una red existente
HIVE_BOOTSTRAP=http://peer.example.com bash hive.sh

# Puerto personalizado
HIVE_PORT=8081 HIVE_EMBEDDER_PORT=7701 bash hive.sh

# Directorio de datos (default: ~/.hive)
HIVE_DATA_DIR=/data/my-bee bash hive.sh

# Sugerir un dominio preferido (no obligatorio)
# La BEE seguirá siendo autónoma — solo prioriza este dominio si hay hojas libres
BEE_TOPIC_DOMAIN=health bash hive.sh
```

---

## Cómo funciona

```
BEE arranca
  → Lee data/topic_tree.json (95 temas disponibles)
  → Escanea peers: qué temas ya están cubiertos
  → Reclama 3 temas no cubiertos (o con menos cobertura)
  → Ciclo cada 5 min: extrae fragmentos para cada tema reclamado
  → Sincroniza automáticamente con otros BEEs cada 8s
  → Renueva claims (TTL 30min) para mantener su territorio
```

Cada BEE decide sola qué indexar. Nadie le dice qué hacer.

---

## Arquitectura

```
packages/
  core/        — KnowledgeStore (Hypercore+Hyperbee), P2P, identidad, topic registry
  agent/       — Extractor autónomo (Gemini function calling), extractor reactivo
  embeddings/  — Servidor Python: all-MiniLM-L6-v2 + HNSW
  api/         — Fastify API + servidor UI
  ui/          — Interfaz web (HTML/JS vanilla)

data/
  topic_tree.json   — árbol de conocimiento (95 temas, 9 dominios)
  bee-*/            — datos runtime por BEE (generados automáticamente, no en git)

bees/               — configs para testing multi-BEE local (no producción)
```

---

## Testing multi-BEE local

Para probar varios BEEs en la misma máquina:

```bash
# Lanza todos los BEEs de bees/*.env
bash start.sh

# O BEEs específicos
bash start.sh bee-1 bee-2 bee-3

# Añadir un BEE nuevo
cat > bees/bee-4.env << 'EOF'
BEE_NAME=bee-4
BEE_PORT=8083
BEE_EMBEDDER_PORT=7703
BEE_DATA_DIR=../../data/bee-4
BEE_PEER=http://127.0.0.1:8080
HIVE_EXTRACT_MAX_FRAGMENTS=20
HIVE_EXTRACT_INTERVAL_MS=300000
EOF
bash start.sh bee-4
```

---

## Estado v0.1

| Módulo | Descripción | Estado |
|--------|-------------|--------|
| 1 | Embeddings + HNSW local | ✅ |
| 2 | Extractor reactivo (arXiv + RSS) | ✅ |
| 3 | Hypercore + Hyperbee + Autobase | ✅ |
| 4 | Red P2P (Hyperswarm + sync) | ✅ |
| 5 | API vectorial | ✅ |
| 6 | UI con Gemini | ✅ |
| 7 | Extractor autónomo + topic tree + claim registry | ✅ |

**Fuera de v0.1 (v0.2):**
- Factor de replicación ≥ 3 (enforcement automático)
- Enrutamiento semántico por centroide (VecDHT)
- Sistema de tokens
- Resistencia a ataques Sybil

---

## Logs

```bash
tail -f /tmp/hive_api.log        # actividad de la BEE
tail -f /tmp/hive_embedder.log   # servidor de embeddings
```
