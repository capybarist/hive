# H.I.V.E — Technical Reference v0.4

**Heuristic Intelligent Vector Extraction**

Technical Reference Document — v0.4 · May 2026

---

## 1. Project Vision

H.I.V.E is a decentralized, verified, and semantically structured knowledge base designed to be consumed by Large Language Models (LLMs). Its goal is to become what Wikipedia is for humans, but for machines: an up-to-date source of truth, owned by no one, with full source traceability and cryptographic verifiability for every fragment.

**Nomenclature.** Each node in the H.I.V.E network is called a BEE (the bee in the hive). A BEE is an instance of the software running on a user's hardware: it extracts, stores, verifies, and serves knowledge fragments. The network is the set of BEEs communicating with each other. Throughout this document, 'node' and 'BEE' are interchangeable.

### 1.1 The problem it solves

Current LLMs (Claude, GPT, Gemini) have knowledge baked into their weights during training. This implies three structural limitations:

- **Knowledge cutoff:** knowledge is static and can be months or years out of date.
- **Hallucinations:** the model generates plausible but unverified responses with no traceable sources.
- **Corporate dependency:** available knowledge depends on editorial decisions by Anthropic, OpenAI, or Google.

H.I.V.E solves this by providing verified external knowledge in real time, which any LLM can consume via context (RAG) without retraining.

### 1.2 How it works at a high level

> ℹ H.I.V.E does not replace LLMs. It augments them with verified real-time knowledge, just like a brilliant lawyer works better with up-to-date case law on the desk than from memory alone.

The complete flow is:

1. Each BEE runs an **autonomous extractor agent** guided by an LLM that obtains knowledge from verified sources: Wikipedia, arXiv, CrossRef, RSS/news, code repositories. The agent decides what to search, evaluates relevance, and follows citation graphs autonomously.
2. Knowledge is validated against original sources to eliminate hallucinations before storage.
3. Each fragment is converted into a numerical vector using a local embeddings model (all-MiniLM-L6-v2, ~80MB, runs on CPU).
4. Fragments + vectors are stored in cryptographically verifiable append-only logs (Hypercore) and synchronized automatically between BEEs via native replication.
5. An **aggregator** indexes all fragments from the network in Qdrant for fast search at scale.
6. When an LLM makes a query, H.I.V.E finds the most semantically relevant fragments and delivers them as verified context.

### 1.3 Differential value proposition

| Aspect | Internet / LLM alone | H.I.V.E |
|--------|----------------------|---------|
| Updates | Static (training cutoff) | Continuous (always-active agents) |
| Verification | No source traceability | Every fragment has source, hash, and signature |
| Control | Corporate (Anthropic, Google) | No owner, P2P network |
| Privacy | Queries go to server | Local mode: no one knows what you ask |
| Optimization | For humans (plain text) | For LLMs (semantic vectors) |
| Infra cost | Millions in servers | Zero — runs on user hardware |

---

## 2. System Architecture

### 2.1 Core principle: distributed production, scalable consumption

> ⚠ **Change from v0.3.** The original architecture proposed a purely P2P system with no central servers, following the BitTorrent model. Development experience from v0.1 through v0.4 demonstrated that this pure model introduces disproportionate complexity in the query layer with no real benefit for the end user. The v0.4 architecture explicitly separates **knowledge production** (distributed, P2P, no central server) from **knowledge consumption** (centralized via aggregator for convenience and performance). This model is analogous to IPFS with gateways or BitTorrent with trackers: production is distributed, access is centralized for convenience, data remains verifiable at the source.

Each user who installs H.I.V.E becomes a BEE in the network. BEEs are the **producers** of knowledge: they extract, sign, store, and replicate fragments among themselves. The **aggregator** is a dedicated node that indexes the entire network's knowledge and serves it to external consumers (LLMs, APIs).

### 2.2 Local storage per BEE

Each BEE stores its portion of knowledge on local disk:

```
~/.hive/
  corestore/   → Corestore: local hypercores (append-only logs, source of truth)
  vectors/     → HNSW index: vector embeddings for local search
  cache/       → Recent queries and popular cached fragments
  identity/    → BEE's cryptographic keys (network identity)
```

### 2.3 Synchronization between BEEs

Synchronization operates on two complementary layers:

**Primary layer — Native Hypercore replication.** Each BEE has a single-writer Hypercore. Peers open that core in read-only mode and receive updates in real time. Cryptographic verification is automatic: every transferred block is verified against the source hypercore's Merkle tree. It is mathematically impossible to inject falsified data without the authoring BEE's private key.

**Fallback layer — HTTP sync.** SyncManager pulls from `/api/fragments` every 8 seconds from each known peer. Covers environments where UDP is blocked (Codespaces, restrictive corporate networks). Fully decentralized: HTTP URLs are discovered via Protomux when nodes connect through Hyperswarm.

> ℹ **v0.4 decision:** Autobase (multi-writer) was removed in v0.2.1 due to instability. The current model — one core per BEE, read-only for the rest — is a better fit for HIVE's architecture: each BEE is the sole authority over its own knowledge. Autobase will not be reinstated.

### 2.4 Peer discovery

When two BEEs connect via Hyperswarm:

1. Hyperswarm discovers them by common topic (32-byte HIVE key).
2. A Protomux channel (`hive/meta/v1`) is opened where they exchange HTTP API URLs (msg[0]).
3. Each BEE obtains the peer's Hypercore public key via `GET /api/status`.
4. `store.get({key})` + `core.download({start:0, end:-1})` activates native replication via `streamTracker.attachAll()`.
5. `watchRemoteCore()` detects new fragments on the peer and indexes them locally.

No hardcoded addresses. All discovery is dynamic.

### 2.5 The Aggregator

> ⚠ **New component in v0.4, not present in the original spec.**

The aggregator is a dedicated node that:
- Connects to all BEEs in the network via Hyperswarm.
- Indexes all fragments in **Qdrant** (vector database optimized for search at scale).
- Serves queries to external LLMs and the public API.
- **Does not produce knowledge** — it is read-only from the network's perspective.

The aggregator solves a practical problem: when an LLM wants to query HIVE, it needs a response in milliseconds with the best fragments from the *entire* network. Performing that federated search across BEEs introduces latency and complexity. The aggregator centralizes search without centralizing data.

**What if the aggregator goes down?** BEEs continue operating among themselves: extracting, syncing, answering local queries with HNSW. The P2P network is independent of the aggregator. Multiple aggregators can coexist (IPFS gateway model).

**Storage layers — summary:**

| Layer | Technology | Purpose | Dispensable? |
|-------|-----------|---------|--------------|
| Source of truth | Hypercore + Hyperbee (per BEE) | Immutable, signed, P2P-replicable store | NO — canonical data |
| Local search | HNSW (per BEE) | Vector search for standalone mode | YES in production with aggregator |
| Global search | Qdrant (aggregator) | Vector search at scale across the full network | YES — reconstructable from Hypercores |

> ℹ HNSW and Qdrant are **derived indexes**, always reconstructable from Hypercore history. Hypercore is the sole source of truth.

### 2.6 Update model: append-only + TTL + supersede

The storage layer is append-only: data is never overwritten, only appended to the log. Updates are modeled as events, not overwrites.

```json
// An old paper refuted by a new one
{ "id": "frag_old", "text": "Neutrinos have no mass",
  "source": "paper_1998", "status": "superseded", "superseded_by": "frag_new" }
{ "id": "frag_new", "text": "Neutrinos have small but nonzero mass",
  "source": "paper_2015_nobel", "status": "current", "supersedes": ["frag_old"] }
```

**TTL by source (new in v0.4):** the autonomous extractor checks before indexing whether a fragment already exists and whether it has expired:

| Source | TTL |
|--------|-----|
| Wikipedia | 7 days |
| RSS / news | 24 hours |
| arXiv | 30 days |
| General web | 3 days |

If the fragment exists and is fresh: skip (saves LLM tokens). If expired: `supersede()` — marks the old one, indexes the new one.

> ⚠ If the storage layer allowed UPDATE in-place, historical traceability, cryptographic verifiability, and resistance to retroactive censorship would be lost. Immutability is not a cost; it is exactly the property that differentiates H.I.V.E from Wikipedia and traditional search engines.

### 2.7 Topic tree and coverage coordination

Each BEE self-assigns topics from a taxonomy of 95 topics organized into 9 knowledge domains. The **claim registry** coordinates via HTTP which BEE covers which topics, avoiding duplication of effort.

The autonomous extractor prioritizes sources by topic type: Wikipedia first for factual topics, RSS for news, arXiv only for academic papers.

---

## 3. Technology Stack

### 3.1 Technologies in use (v0.4)

| Component | Technology | Status | Function |
|-----------|-----------|--------|----------|
| Append-only log | Hypercore | ✅ Production | Verifiable log + native P2P replication |
| Database | Hyperbee | ✅ Production | Key-value + queries on Hypercore |
| P2P network | Hyperswarm + HyperDHT | ✅ Production | BEE discovery via DHT + hole-punching |
| Core management | Corestore | ✅ Production | Manages hypercore collections |
| Vector search (BEE) | HNSW (hnswlib) | ✅ Production | Local semantic search |
| Vector search (aggregator) | Qdrant | ✅ Production | Semantic search at scale |
| Local embeddings | all-MiniLM-L6-v2 | ✅ Production | Vectors (~80MB, CPU) |
| Autonomous extractor | Custom module (TS) + LLM | ✅ Production | Agent with function calling |
| External LLM | Groq / Gemini / Claude / OpenAI | ✅ Production | Synthesis + agent decisions |
| API | Fastify (TypeScript) | ✅ Production | Vector query API + REST endpoints |
| UI | Vanilla HTML/JS | ✅ Production | Human query interface |

### 3.2 Planned technologies — Tether ecosystem

> ℹ **Context:** HIVE is built on Holepunch's P2P stack, which is owned by Tether. The integration with the rest of Tether's technology ecosystem is a natural extension, not a forced fit. Tether launched a developer grants program in May 2026 to fund developers building on their open stack (QVAC, WDK, Pears). HIVE fits directly into the categories of "applications on the tech stack" and "research in decentralization, edge AI, and P2P."

| Component | Technology | Target version | Role in HIVE |
|-----------|-----------|----------------|--------------|
| Local inference | QVAC (Tether) | v0.6 | On-device LLM for the extractor — no data leaves the BEE, no API cost |
| Self-custodial payments | WDK (Tether) | v0.7 | Embedded wallet per BEE — consumers pay in USD₮, extractors earn USD₮ |
| P2P runtime | Pears (Holepunch) | v0.8 | Distribute and run BEEs as native P2P apps |

### 3.3 Technologies we will build

| Component | Inspiration | Current implementation | Future implementation |
|-----------|------------|----------------------|----------------------|
| Semantic routing | VecDHT (theoretical spec) | All BEEs respond to all queries | Per-BEE centroids + selective routing (v0.6) |
| Fragment verification | Merkle + ed25519 | Signatures on save, not verified on receive | Full verification on receive (v0.5) |
| Quality consensus | Yuma Consensus (Bittensor) | No consensus | Multi-agent voting (v0.6) |
| Economic incentives | Token economics | No incentives | WDK + credit model (v0.7) |

> ⚠ All custom technologies are behind abstract interfaces (`IVectorRouter`, `IVerifier`, `IConsensus`, `IKnowledgeGraph`, `IVectorIndex`, `IExtractor`). Implementations can be swapped without changing the rest of the system. If Iroh, libp2p, or another project proves superior for H.I.V.E in the future, only the corresponding implementation is rewritten.

### 3.4 Languages

- **TypeScript / Node.js:** P2P core, Hypercore stack, extractor agent, query API.
- **Python:** embeddings model, HNSW, Qdrant client.
- **Communication:** the two languages communicate via local HTTP API.

---

## 4. Usage Modes

### 4.1 Machine mode (HIVE's core)

An external LLM queries H.I.V.E as a verified knowledge source. Purely vector-based exchange, no natural language. This is the primary mode and the most valuable long-term.

```
POST /query
{ "vector": [0.23, 0.87, -0.12, ...], "top_k": 10 }

Response:
{ "chunks": [...], "sources": [...], "confidence": 0.94 }
```

### 4.2 Human mode (optional interface)

A user types a question in natural language. H.I.V.E finds verified fragments, and an LLM chosen by the user synthesizes them into a response with sources.

The LLM always receives:

```
SYSTEM: Respond ONLY based on the provided fragments.
If the answer is not in the fragments, state this explicitly.

VERIFIED KNOWLEDGE FROM H.I.V.E:
[Fragment 1 - Source: arXiv:2103.12345, confidence: 0.97, hash: a7b...]
...fragment text...

QUESTION: How does CRISPR-Cas9 work?
```

### 4.3 Strategy when HIVE has no information

Transparent hybrid mode: if H.I.V.E has relevant fragments, it uses them. If not, it clearly informs the user and allows the LLM to respond with its internal knowledge, marked as "not verified by H.I.V.E". This guarantees usefulness from day one.

### 4.4 Central web server (optional)

A web server at hive.io acts as a public aggregator with an open API, allowing access without installation. Convenient but not necessary — the P2P network works without it.

---

## 5. System Modules

### Module 1 — Embeddings and semantic search ✅

all-MiniLM-L6-v2 model (~80MB, CPU). FastAPI exposes `/embed` and `/search` on configurable port. Dual backend: HNSW for individual BEEs, Qdrant for the aggregator.

### Module 2 — Reactive extractor ✅

Crawler with configurable topic list. arXiv API + CrossRef DOI validation + chunking. Maintained as a deterministic fallback and benchmark baseline.

### Module 3 — KnowledgeStore (Hypercore + Hyperbee) ✅

Each fragment is stored as a Hyperbee entry, signed with ed25519. Operations: `save()`, `get()`, `query()`, `supersede()`, `watchFragments()`, `watchRemoteCore()`. Single-writer per BEE.

> ⚠ **Critical bug fixed in v0.4:** `batch.put()` in Hyperbee v2 is async but was never awaited in `save()`, `saveReplicated()`, and `supersede()`. Every BEE had fragments in HNSW but Hypercore was permanently empty (only the header block). This bug was present since v0.1 and was the root cause of all P2P replication failures. Fixed with `await b.put()` throughout KnowledgeStore.

### Module 4 — P2P network ✅

Hyperswarm for discovery. Protomux for HTTP URL exchange. Native Hypercore replication operational after the `await b.put()` fix. HTTP sync as fallback. `test_replication.ts` — all phases pass.

### Module 5 — Vector query API ✅

Fastify with endpoints: `POST /api/query` (text + vector, history, filters), `GET /api/status`, `GET /api/fragments` (paginated list), `GET /api/state`, `GET /api/activity`, `POST /api/register-peer`, `POST /api/config`. Federated search: if local HNSW has no relevant results, queries peers.

### Module 6 — Human interface ✅

Vanilla HTML/JS with dark theme. LLM selector (Groq, Gemini, Claude, OpenAI). Conversational history. Verified source chips. LLM configuration modal with health check.

### Module 7 — Autonomous extractor ✅

LLM agent with function calling. Tools: `arxiv_search`, `rss_fetch`, `web_fetch`, `index_fragment`. Budget controller with per-cycle limits (tokens, fragments, time). Topic tree of 95 topics in 9 domains. Claim registry for P2P coordination. TTL + cross-cycle dedup + automatic supersede.

### Module 8 — Aggregator + Qdrant ✅ (new in v0.4)

Dedicated read-only node. Connects to all BEEs, indexes everything in Qdrant (Docker). Qdrant auto-start. Decentralized peer discovery.

---

## 6. Project Structure

```
hive/
├── hive.sh                ← production launcher (single BEE, zero-config)
├── start.sh               ← dev launcher (multiple BEEs from bees/*.env)
├── aggregator.sh           ← aggregator node launcher (starts Qdrant via Docker)
├── stop.sh                ← kills all processes by port
├── bees/                  ← dev configs: bee-1.env, bee-2.env, bee-3.env
├── data/
│   ├── topic_tree.json    ← 95-topic knowledge taxonomy (committed)
│   └── bee-*/             ← runtime data (gitignored)
├── packages/
│   ├── core/src/
│   │   ├── knowledge_store.ts    ← save/get/supersede/watchFragments/watchRemoteCore
│   │   ├── p2p_node.ts           ← Hyperswarm + Protomux + store.replicate()
│   │   ├── sync_manager.ts       ← HTTP sync fallback (8s interval)
│   │   ├── claim_registry.ts     ← topic claim coordination via HTTP
│   │   ├── topic_assignment.ts   ← assigns topic tree leaves to BEEs
│   │   ├── node_identity.ts      ← ed25519 identity per BEE
│   │   └── test_replication.ts   ← P2P replication tests (3 phases)
│   ├── agent/src/
│   │   ├── autonomous_extractor.ts ← LLM agent + dedup/TTL/supersede logic
│   │   ├── tools_registry.ts       ← arxiv_search, rss_fetch, web_fetch, index_fragment
│   │   └── budget_controller.ts    ← per-cycle limits
│   ├── embeddings/
│   │   ├── api_server.py        ← FastAPI, HNSW + Qdrant backends
│   │   └── qdrant_index.py      ← Qdrant client (aggregator)
│   ├── api/src/
│   │   ├── api_server.ts        ← Fastify, all endpoints + extraction loop
│   │   └── llm_client.ts        ← LLM synthesis for /api/query
│   └── ui/
│       └── index.html           ← vanilla JS, dark theme
├── CLAUDE.md
├── MANIFESTO.md
├── CHANGELOG.md
├── LICENSE (BUSL-1.1)
└── README.md
```

---

## 7. Abstract Interfaces — Designing for the Future

Every critical component is defined behind an interface. The current implementation is functional, built on the Hypercore stack. Future implementations can be swapped without changing the rest of the system.

| Interface | Current implementation | Future implementation |
|-----------|----------------------|----------------------|
| IVectorRouter | Hyperswarm topic-based (broadcast) | Centroids + selective semantic routing |
| IVectorIndex | HNSW local (BEE) + Qdrant (aggregator) | Distributed d-HNSW |
| IVerifier | ed25519 signatures on save | Full verification on receive |
| IConsensus | No consensus | Multi-agent voting |
| IKnowledgeGraph | Hyperbee + Corestore (single-writer) | Replaceable with equivalent stack |
| IExtractor | AutonomousExtractor (LLM function calling) | + QVAC for local inference |
| IPayment | Not implemented | WDK (Tether) — self-custodial wallet |

### 7.1 IKnowledgeGraph contract

```typescript
interface IKnowledgeGraph {
  save(fragment: Fragment): Promise<FragmentId>;
  get(id: FragmentId): Promise<Fragment | null>;
  query(filter: QueryFilter): AsyncIterable<Fragment>;
  supersede(oldId: FragmentId, newFragment: Fragment): Promise<FragmentId>;
  history(id: FragmentId): Promise<Fragment[]>;
  verify(fragment: Fragment): Promise<boolean>;
  replicate(peer: PeerHandle): Promise<ReplicationStream>;
}
```

---

## 8. Tether Ecosystem Integration

### 8.1 Why Tether

HIVE already uses Holepunch's P2P stack (Hypercore, Hyperswarm, Corestore), which is owned by Tether. The relationship is organic: HIVE is a real application built on technology that Tether funds and maintains. Integration with the rest of their ecosystem is not opportunistic — it is the natural evolution of the project.

Tether is building a complete stack for a decentralized internet: P2P (Pears/Hypercore), self-custodial payments (WDK), local AI (QVAC), and mining (MDK). HIVE fits exactly at the intersection of the first three.

### 8.2 QVAC — Local inference for the extractor

**What it is:** QVAC is Tether's local-first AI platform. It runs LLM models directly on the user's device without sending data to external servers.

**How it fits in HIVE:** The autonomous extractor (Module 7) currently depends on external APIs (Groq, Gemini, Claude, OpenAI) for agent decisions. This means token costs, network latency, and data leaving the device.

With QVAC, the agent's LLM runs on-device:
- **Full privacy:** no extraction query leaves the BEE.
- **Zero token cost** after the initial model download.
- **Offline availability:** the BEE can extract knowledge without API connectivity.
- **P2P narrative coherence:** a truly autonomous node should not depend on corporate APIs to function.

**Planned implementation (v0.6):** Add `LLM_PROVIDER=qvac` as a BEE option. The budget controller would detect zero token cost and adjust limits accordingly. Fallback to external APIs is maintained for more capable models when the task requires it.

### 8.3 WDK — Self-custodial payments for the HIVE economy

**What it is:** WDK (Wallet Development Kit) is Tether's open-source framework for embedding self-custodial wallets in applications. It generates and manages keys locally, signs transactions, and moves funds without custodians or external APIs.

**How it fits in HIVE:** The v0.3 spec already envisioned a token system (section 9.2) but without concrete infrastructure. WDK provides that infrastructure without building it from scratch:

- **Extractors (miners):** each BEE has an embedded WDK wallet. It receives micropayments in USD₮ for each verified fragment contributed to the network.
- **Consumers:** pay fractions of USD₮ per query to the aggregator API. Payment is direct, peer-to-peer, no intermediaries.
- **Validators (v0.6+):** earn USD₮ for participating in fragment quality consensus.

**Advantage over a custom token:** using USD₮ instead of creating a native token eliminates speculation and regulatory complexity. Value is immediate and comprehensible — no need to convince anyone your token is worth something.

**Planned implementation (v0.7):** Integrate WDK into each BEE. The aggregator would act as a payment facilitator (simple escrow) for queries. Extractor payouts would be based on verifiable metrics: number of fragments served, quality (consensus), freshness.

### 8.4 Pears — Native P2P runtime

**What it is:** Pear Runtime is Holepunch's platform for distributing and running P2P applications without servers. Apps are installed directly from the swarm.

**How it fits in HIVE (v0.8+):** Currently a BEE is installed with `git clone` + `bash hive.sh`. With Pears, installation would be a single command that downloads the BEE from the P2P network, with no dependency on GitHub, npm, or any distribution server. Over-the-air updates are signed with multisig.

---

## 9. License and Business Strategy

### 9.1 License: Business Source License (BUSL-1.1)

BUSL allows the code to be public and collaborative, but restricts commercial use until a date defined by the author (typically 4 years). Used by MariaDB, HashiCorp Terraform, Sentry.

- Anyone can view the code, contribute, and use it non-commercially.
- No one can monetize it without you during the protection period.
- After the defined date, it automatically converts to open source (MIT).

### 9.2 Long-term business model

**Phase 1 (current) — Portfolio and traction.** HIVE v0.4 on GitHub demonstrates mastery of RAG, embeddings, P2P systems, AI agents, Hypercore stack, and distributed architectures. Serves as a technical portfolio, demonstration for collaborators, and basis for grants (Tether developer grants).

**Phase 2 (v0.7) — Micropayments with WDK.** Consumers pay USD₮ per query. Extractors receive USD₮ for contributing. No speculative token — immediate value in stablecoins.

**Phase 3 — Commercial API.** hive.io as a verified RAG service for enterprises. Dual licensing: open source for self-hosting, commercial license for SaaS.

---

## 10. Roadmap

### v0.4 ✅ — Native P2P replication + stability

Everything listed in this document. Native replication working. Aggregator + Qdrant. Multi-provider LLM. TTL + supersede. Critical `await b.put()` bug resolved.

### v0.5 — Verifiable network

- Verify ed25519 signatures on fragment receipt (`watchRemoteCore` + `SyncManager`).
- Replication factor ≥ 3 with monitoring.
- Propagate supersedes to aggregator (update Qdrant when a fragment is superseded).
- Clean up fragments from unreachable BEEs in the aggregator.
- Cross-machine testing on real VMs.

### v0.6 — Intelligent network + QVAC

- `IConsensus`: multi-agent voting for fragment quality.
- Semantic routing by centroid (basic VecDHT).
- P2P topic coordination (without HTTP claims).
- QVAC integration: `LLM_PROVIDER=qvac` for local inference.
- Topic tree expansion to 500+ topics.

### v0.7 — Economics + WDK

- WDK integration: self-custodial wallet per BEE.
- USD₮ micropayments per query (consumers → aggregator → extractors).
- Per-BEE metrics dashboard (fragments served, quality, earnings).
- Documented API for consumption by external LLMs.

### v0.8+ — Product

- hive.io as public aggregator with commercial API.
- Distribution via Pear Runtime.
- Dual licensing: open source + commercial license.
- Sybil attack resistance at scale.

---

## 11. Competitive Landscape (May 2026 snapshot)

| Project | Storage | Verification | Difference from H.I.V.E |
|---------|---------|-------------|------------------------|
| D-RAG (Lu et al. 2025) | IPFS + blockchain | Smart contracts + scoring | Federated with roles; heavy blockchain |
| Vektaris (Hive Forensics) | Internet Computer Protocol | Stable memory in canisters | Centralized on ICP blockchain |
| Vectrs (ParalexLabs) | Custom DHT | Non-cryptographic | Beta, no traction |
| Omni-RAG (Gao et al.) | Vector DB + graph | None | Modular RAG framework, not decentralized |
| **H.I.V.E** | **Hypercore (pure P2P)** | **Merkle + ed25519** | **Only project combining P2P without blockchain + autonomous producer agents + Tether ecosystem integration (QVAC, WDK, Pears)** |

---

## 12. Quick Context for Conversation Recovery

> ℹ This section exists so that Claude can recover the full project context at any time by reading only this document.

### 12.1 Who is the developer

Developer with enterprise systems experience (Windows Financial Services, Java). Motivations: contribute to technology and improve economic situation. Current job is well-paid but of uncertain duration. Communicates in Spanish; all code and logs in English.

### 12.2 Design decisions (updated v0.4)

- **Stack:** TypeScript/Node.js for core + Python for embeddings.
- **P2P and persistence:** Hypercore + Hyperbee + Hyperswarm (Holepunch/Tether ecosystem).
- **Autobase: ABANDONED** in v0.2.1. Single-writer per BEE is the correct model.
- **Aggregator + Qdrant:** new in v0.4. Centralizes search without centralizing data.
- **HNSW for standalone, Qdrant for production.** Both are derived indexes from Hypercore.
- **Multi-provider LLM:** Groq (recommended, free tier), Gemini, Claude, OpenAI.
- **No external agent framework:** custom autonomous extractor with function calling.
- **TTL + automatic supersede:** wired in the extractor since v0.4.
- **Tether ecosystem:** QVAC for local inference (v0.6), WDK for payments (v0.7), Pears for distribution (v0.8).
- **No blockchain:** cryptographic verification with Merkle + ed25519, no global consensus overhead.
- **License:** BUSL-1.1.
- **Business model:** USD₮ micropayments via WDK, not a speculative token.

### 12.3 Critical v0.4 bug

`batch.put()` in Hyperbee v2 is async but was never awaited. Present since v0.1. Result: Hypercore was always empty, P2P replication was impossible. All the pain from v0.1 to v0.2.2 (SESSION_CLOSED, deadlocks, HTTP-only sync) stemmed from this bug. Fixed with `await b.put()` in KnowledgeStore. It was not an architectural problem — it was a one-line bug.

### 12.4 Current state

All modules (1–8) complete and working end-to-end. Native Hypercore replication operational. Replication tests passing. Aggregator with Qdrant indexing the full network.

---

*H.I.V.E — Living document. Update as development progresses.*
