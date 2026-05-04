# H.I.V.E — Heuristic Intelligent Vector Extraction

Base de conocimiento descentralizada, verificada y semánticamente estructurada para LLMs.  
Red P2P de BEEs (nodos) que extraen, firman y sincronizan conocimiento científico en tiempo real.

---

## Arranque rápido

```bash
cd /workspaces/codespaces-blank/hive
bash start.sh
```

La primera vez tarda ~30s (carga el modelo de embeddings de 80MB).  
Las siguientes veces es instantáneo — el script detecta qué ya está corriendo.

---

## Acceso a la UI

Una vez arrancado, abre la pestaña **Ports** en VS Code y haz clic en el globo 🌐 junto a los puertos:

| Puerto | BEE | Tema de extracción |
|--------|-----|-------------------|
| `8080` | Node A | RAG, vector databases, semantic search |
| `8081` | Node B | LLM fine-tuning, RLHF, instruction following |

Si los puertos no aparecen, añádelos manualmente con **"Forward a Port"** y ponlos en **Public**.

**URLs directas** (este Codespace):
```
Node A → https://fantastic-orbit-4q7wx7jw4j45275r5-8080.app.github.dev
Node B → https://fantastic-orbit-4q7wx7jw4j45275r5-8081.app.github.dev
```

---

## Extracción autónoma

Cada BEE extrae conocimiento de forma autónoma usando Gemini 2.5 Flash:

- **Node A** busca papers sobre RAG, búsqueda vectorial y bases de datos semánticas
- **Node B** busca papers sobre fine-tuning de LLMs, RLHF y alineamiento

El ciclo corre cada 30 minutos. Para lanzarlo manualmente:

```bash
# Node A (RAG)
cd packages/agent
EMBEDDER_URL=http://127.0.0.1:7700 \
HIVE_OBJECTIVE="retrieval augmented generation knowledge graphs" \
HIVE_MAX_FRAGMENTS=10 \
npx tsx src/autonomous_extractor.ts

# Node B (fine-tuning) — en otra terminal
cd packages/agent
HIVE_DATA_DIR=../../data_b \
EMBEDDER_URL=http://127.0.0.1:7701 \
HIVE_OBJECTIVE="large language model fine tuning RLHF alignment" \
HIVE_MAX_FRAGMENTS=10 \
npx tsx src/autonomous_extractor.ts
```

---

## Arquitectura

```
BEE A (:8080)                    BEE B (:8081)
├── Embedder Python :7700         ├── Embedder Python :7701
├── KnowledgeStore (Hypercore)    ├── KnowledgeStore (Hypercore)
├── HNSW index (data/vectors/)    ├── HNSW index (data_b/vectors/)
├── P2P (Hyperswarm)              ├── P2P (Hyperswarm)
└── Autonomous extractor          └── Autonomous extractor
         │                                 │
         └──────── sync cada 8s ───────────┘
```

**Flujo de conocimiento:**
1. Gemini decide qué buscar → arXiv API → papers validados con CrossRef
2. Fragmentos firmados (ed25519) → Hypercore (append-only, verificable)
3. Vectores → HNSW local para búsqueda semántica
4. SyncManager propaga fragmentos entre BEEs cada 8s
5. Consulta humana → HNSW search → Gemini sintetiza respuesta citando fuentes

---

## Logs

```bash
tail -f /tmp/api_a.log      # Node A API + extractor autónomo
tail -f /tmp/api_b.log      # Node B API + extractor autónomo
tail -f /tmp/emb_a.log      # Embedder A
tail -f /tmp/emb_b.log      # Embedder B
```

---

## Estructura del proyecto

```
packages/
  core/       — KnowledgeStore (Hypercore+Hyperbee+Autobase), P2P, identidad
  agent/      — Extractor reactivo + autónomo (Gemini function calling)
  embeddings/ — Servidor Python: all-MiniLM-L6-v2 + HNSW
  api/        — Fastify API + UI server
  ui/         — Interfaz web (HTML/JS vanilla)
data/         — BEE A: corestore/, vectors/, identity/
data_b/       — BEE B: corestore/, vectors/, identity/
start.sh      — Script de arranque único
```

---

## Variables de entorno clave

| Variable | Dónde | Descripción |
|---|---|---|
| `GEMINI_API_KEY` | `.env` | API key de Google Gemini |
| `HIVE_OBJECTIVE` | `.env` / `.env.node-b` | Objetivo de extracción autónoma |
| `HIVE_PORT` | `.env.node-b` | Puerto del API server (default: 8080) |
| `HIVE_DATA_DIR` | `.env.node-b` | Directorio de datos de la BEE |
| `HIVE_PEER` | `.env.node-b` | URL del peer de bootstrap |
| `EMBEDDER_URL` | `.env.node-b` | URL del servidor de embeddings |
| `HIVE_EXTRACT_MAX_FRAGMENTS` | `.env` | Fragmentos por ciclo (default: 8) |
| `HIVE_EXTRACT_INTERVAL_MS` | `.env` | Intervalo entre ciclos (default: 1800000 = 30min) |
