# The HIVE Manifesto

## The problem with AI knowledge

Today's AI models — GPT, Claude, Gemini — are trained once and frozen. Their knowledge has a cutoff date. They hallucinate when they don't know something. Their content is decided by a handful of corporations. And every query goes through servers you don't control.

This is the wrong architecture for a world that runs on AI.

## What HIVE is

HIVE is a **decentralized, verifiable knowledge base built for LLMs** — not for humans. It is to AI what Wikipedia is to humans: a living, open, source-traceable repository of knowledge that anyone can read, anyone can contribute to, and no one controls.

Every piece of knowledge in HIVE:
- Has a **verified source** — no fabricated citations
- Has a **cryptographic signature** — you know who added it and that it hasn't been modified
- Lives in an **append-only log** — history is permanent, corrections are explicit
- Is stored **across hundreds of independent nodes** — no single point of failure or censorship

## How it works

Each participant runs a **BEE** — a node in the HIVE network. BEEs are autonomous agents that:

1. **Choose a knowledge domain** by reading the network and finding uncovered areas
2. **Extract content** from verified sources: arXiv, CrossRef, news feeds, Wikipedia
3. **Verify and sign** each fragment with their cryptographic identity
4. **Serve queries** from any LLM or human that connects

BEEs are P2P. They discover each other via Hyperswarm (the same technology behind Keet and Pear). They replicate knowledge across the network. If a BEE goes offline, its fragments survive on other BEEs that have replicated them.

An LLM querying HIVE sends its question as a vector, receives the most semantically relevant verified fragments, and uses them as grounded context. No hallucinations about things that are in HIVE. Full source traceability for everything it cites.

## Why this matters

**For AI users:** Answers grounded in verifiable, up-to-date sources. Know exactly where every fact came from.

**For AI developers:** A decentralized RAG layer that doesn't require building and maintaining your own knowledge pipeline. Connect your LLM to HIVE and inherit the network's knowledge.

**For the open web:** A commons of machine-readable knowledge that no corporation can take down, edit silently, or monetize without giving back.

**For the future:** As AI agents become more capable, the quality of their knowledge base determines their quality. HIVE is that foundation — built in the open, owned by no one, maintained by everyone.

## The technology

HIVE is built on battle-tested P2P infrastructure:

- **[Hypercore](https://github.com/holepunchto/hypercore)** — append-only cryptographic log (same tech as Keet)
- **[Hyperswarm](https://github.com/holepunchto/hyperswarm)** — P2P DHT for node discovery
- **[sentence-transformers](https://github.com/UKPLab/sentence-transformers)** — local semantic embeddings (~80MB, runs on CPU)
- **LLM with function calling** — autonomous extraction agent (Gemini, Claude, OpenAI, or any compatible API)

No blockchain. No tokens yet. No central server. Just P2P infrastructure that has been running in production for years.

## Current state: v0.2

HIVE v0.2 is a working proof of concept — all core modules implemented and running. See the [README](./README.md#v02-status) for the full status breakdown and what's planned for v0.3.

## How to run a BEE

See [Quick start in the README](./README.md#quick-start) — Docker, npx, or from source. Zero configuration needed: your BEE will find an uncovered area and start extracting on its own.

## How to contribute code

The codebase is TypeScript (Node.js) + Python. The architecture is modular — most components are behind interfaces and can be replaced independently.

**High-impact areas:**
- **Semantic centroid routing** — BEEs advertise their knowledge centroid, queries route to relevant nodes
- **Replication factor** — enforce that each fragment exists on ≥ 3 BEEs
- **Topic tree expansion** — the current taxonomy has 95 topics; it should have 5000
- **Source diversity** — add PubMed, GitHub, Semantic Scholar, YouTube transcripts

See [CLAUDE.md](./CLAUDE.md) for a technical deep-dive and known issues.

## License

Business Source License (BUSL-1.1). Free for non-commercial use. Converts to MIT in 4 years.

---

*HIVE is a living project. The manifesto will evolve as the network grows.*

*If you believe AI knowledge should be a commons, not a corporate asset — run a BEE.*
