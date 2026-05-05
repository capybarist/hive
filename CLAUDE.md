# HIVE — Contexto para Claude Code

## Qué es este proyecto

HIVE (Heuristic Intelligent Vector Extraction) es una base de conocimiento P2P descentralizada para LLMs. Cada nodo se llama **BEE**. Las BEEs extraen conocimiento de internet, lo firman criptográficamente, lo almacenan en Hypercore (P2P, append-only, verificable) y lo sincronizan con otras BEEs. Los LLMs consultan HIVE via RAG para obtener conocimiento actualizado y verificado.

**Analogía:** Lo que Wikipedia es para humanos, pero optimizado para ser consumido por LLMs.

## Estado actual: v0.1 completo

Todos los módulos están implementados:
- **Módulo 1**: Embeddings locales (all-MiniLM-L6-v2, ~80MB CPU) + índice HNSW
- **Módulo 2**: Extractor reactivo (arXiv API + CrossRef + RSS)
- **Módulo 3**: KnowledgeStore sobre Hypercore + Hyperbee + Autobase
- **Módulo 4**: Red P2P (Hyperswarm discovery + HTTP sync entre BEEs)
- **Módulo 5**: API vectorial (Fastify)
- **Módulo 6**: UI web con síntesis Gemini
- **Módulo 7**: Extractor autónomo (Gemini function calling) + topic tree + claim registry

## Arquitectura de ficheros

```
hive/
├── hive.sh              ← arranque producción (zero-config, UN solo BEE)
├── start.sh             ← arranque dev (múltiples BEEs desde bees/*.env)
├── bees/                ← configs dev: bee-1.env, bee-2.env, bee-3.env
├── data/
│   ├── topic_tree.json  ← árbol de 95 temas (el único fichero en git aquí)
│   └── bee-*/           ← runtime: corestore/, vectors/, identity/ (no en git)
├── packages/
│   ├── core/src/
│   │   ├── knowledge_store.ts   ← KnowledgeStore (Autobase + Hyperbee)
│   │   ├── claim_registry.ts    ← registro P2P de qué temas cubre cada BEE
│   │   ├── topic_assignment.ts  ← asignación de temas del árbol
│   │   ├── p2p_node.ts          ← Hyperswarm P2P
│   │   ├── sync_manager.ts      ← sincronización HTTP entre BEEs
│   │   └── node_identity.ts     ← identidad ed25519 por BEE
│   ├── agent/src/
│   │   ├── autonomous_extractor.ts ← agente Gemini con tools
│   │   ├── reactive_extractor.ts   ← extractor manual por topics
│   │   ├── objective_discovery.ts  ← auto-asignación de temas desde la red
│   │   ├── tools_registry.ts       ← tools: arxiv_search, rss_fetch, web_fetch...
│   │   └── budget_controller.ts    ← límites de tokens/fragmentos/tiempo
│   ├── embeddings/
│   │   └── api_server.py        ← FastAPI Python :7700, HNSW + sentence-transformers
│   ├── api/src/
│   │   └── api_server.ts        ← Fastify :8080, endpoints + extractor loop
│   └── ui/
│       └── index.html           ← UI vanilla JS, dark theme
└── scripts/
    └── verify_store.ts          ← diagnóstico del KnowledgeStore
```

## Cómo arranca una BEE

```bash
# Producción (un BEE, zero-config):
bash hive.sh

# Dev (3 BEEs en la misma máquina):
bash start.sh                    # arranca bee-1, bee-2, bee-3
bash start.sh bee-1 bee-2        # solo algunos
```

**Variables de entorno clave:**
- `GEMINI_API_KEY` — requerida (en `.env`)
- `HIVE_PORT` — default 8080
- `HIVE_EMBEDDER_PORT` — default 7700
- `HIVE_DATA_DIR` — default `~/.hive` (prod) o `data/bee-N` (dev)
- `HIVE_BOOTSTRAP` / `BEE_PEER` — URL de un peer conocido
- `BEE_TOPIC_DOMAIN` — hint de dominio (ej: `current_events`, `health`)
- `HIVE_OBJECTIVE` — objetivo explícito (opcional, anula auto-descubrimiento)
- `HIVE_EXTRACT_MAX_FRAGMENTS` — default 20
- `HIVE_EXTRACT_INTERVAL_MS` — default 300000 (5min)

## Flujo de auto-descubrimiento de temas

1. BEE arranca sin `HIVE_OBJECTIVE`
2. Lee `data/topic_tree.json` (95 hojas, 9 dominios)
3. Llama a `/api/claims` de sus peers para saber qué está cubierto
4. Puntúa hojas: libre=100, cubierta por 1=50, ya mía=10; +200 si coincide `BEE_TOPIC_DOMAIN`
5. Reclama las top-N hojas con jitter aleatorio (evita races)
6. Ciclo de extracción cada 5min, con ~fragsMax/numTopics fragmentos por tema
7. Renueva claims (TTL 30min) para no perder el territorio

## Puertos en dev local

| BEE | API | Embedder |
|-----|-----|----------|
| bee-1 (seed) | 8080 | 7700 |
| bee-2 | 8081 | 7701 |
| bee-3 (domain=current_events) | 8082 | 7702 |

**URLs Codespace:**
```
https://fantastic-orbit-4q7wx7jw4j45275r5-8080.app.github.dev
https://fantastic-orbit-4q7wx7jw4j45275r5-8081.app.github.dev
https://fantastic-orbit-4q7wx7jw4j45275r5-8082.app.github.dev
```

## Decisiones de diseño importantes

- **GenosDB descartado** → Hypercore (código público, Holepunch ecosystem)
- **No framework de agentes** → extractor propio TypeScript + Gemini function calling
- **Topic-centric, no source-centric** → el LLM decide las fuentes por tema
- **append-only** → Hypercore, nunca se borra, supersedes para correcciones
- **Sync HTTP** → SyncManager llama `/api/fragments` de peers cada 8s (no puro Hypercore)
- **Gemini 2.5 Flash** como LLM para síntesis y extracción autónoma

## Bugs conocidos / pendientes

- `Autobase is closing`: al escribir muchos fragmentos rápido en Hypercore.
  Mitigado: cola de escrituras en `knowledge_store.ts` + Hypercore save no-fatal.
  El HNSW siempre funciona. Hypercore falla silenciosamente.
- Sync HTTP no es pure P2P (Hypercore nativo pendiente para v0.2)
- Factor de replicación ≥3 no implementado (v0.2)
- El `BEE_TOPIC_DOMAIN=current_events` de bee-3 a veces elige temas de science
  si todos los current_events están tomados. Es correcto pero confunde en demos.

## GitHub

```
Repo: https://github.com/capybarist/hive (private)
Branch principal: main
Dev branches: feature/* (mergeados a main al completar)
Push: requiere unset GITHUB_TOKEN (Codespace) + TOKEN trick
```

## Contexto del desarrollador

- Background Java/enterprise (Windows Financial Services)
- Aprendiendo sistemas distribuidos + IA
- El proyecto es portfolio + producto real
- Comunica en español
- No le gustan los permisos constantes → `Bash(*)` en settings.json
- Objetivo: demo grabable de 2+ BEEs sincronizando en tiempo real
