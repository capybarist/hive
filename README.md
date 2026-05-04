# HIVE — Heuristic Intelligent Vector Extraction

Base de conocimiento descentralizada, verificada y semánticamente estructurada para LLMs.  
Red P2P de BEEs que extraen, firman y sincronizan conocimiento de forma autónoma.

> *Lo que Wikipedia es para humanos, pero para máquinas.*

---

## Inicio rápido (producción)

```bash
# 1. Clona el repositorio
git clone https://github.com/capybarist/hive.git && cd hive

# 2. Instala dependencias
npm install
pip install -r packages/embeddings/requirements.txt

# 3. Configura tu API key
echo "GEMINI_API_KEY=tu_clave_aqui" > .env

# 4. Lanza tu BEE
bash hive.sh
```

La BEE arranca, escanea la red, **elige un tema libre del árbol de conocimiento** y empieza a indexar. Sin configuración manual de temas.

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
