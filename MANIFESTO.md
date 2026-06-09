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
- Is stored **across independent nodes** — no single point of failure or censorship

## How it works

The HIVE network has two complementary roles. Today a single binary
does both; from v0.7 onward they are selectable at runtime.

### BEEs — the producers

Each contributor runs a **BEE**: a node that forages knowledge for the
hive. BEEs are autonomous agents that:

1. **Declare the sources they cover** — Wikipedia, arXiv, CrossRef, news feeds, Common Crawl snapshots — publicly, in a self-signed manifest. No central registry approves anything.
2. **Extract content verbatim** from those sources via a uniform forager interface.
3. **Sign** each fragment with their ed25519 identity.
4. **Propagate** via native Hypercore P2P replication.

BEEs discover each other via Hyperswarm (the same DHT layer behind Keet
and Pear). Each BEE's Hypercore is a single-writer, append-only,
cryptographically verifiable log — peers replicate it read-only.
Nothing in the log is ever rewritten or deleted; updates happen by
*superseding* old fragments, leaving the full history auditable.

HIVE does not decide what topics exist or which sources matter. It
provides a mechanism for any publicly-identifiable, objectively-
reproducible source to be extracted by any BEE that chooses to cover
it, with cryptographic traceability of the process.

### Queens — the consumers

A **queen** (called *aggregator* up to v0.6.x) is a node whose job is
to index the network and serve queries. A queen:

1. **Joins the same Hyperswarm topic** as every other HIVE node
2. **Subscribes** to whichever BEE Hypercores it wants to follow
3. **Streams** their signed fragments into a vector database (Qdrant)
4. **Serves** semantic queries with LLM-grounded synthesis

The queen "centralises access without centralising data" — like an
IPFS gateway or a BitTorrent tracker. Anyone can run a queen indexing
whichever subset of bees they care about (science only, news only, a
private corporate vertical, a public general-purpose one). No
"HIVE Inc." middle layer.

### Why the split is faithful to P2P, not a betrayal of it

Hypercore is **single-writer by design**: each node is sovereign over
its own log; others read. Holepunch's own apps already follow this
pattern — Keet has one Hypercore per user, with other users acting as
read-only consumers. HIVE's bee/queen split is the same shape, just
named differently.

The natural challenge — *"if queens index everything and serve queries,
aren't they the new Mastodon servers?"* — has a clean answer. The
table below compares HIVE to the closest things in the social-protocol
landscape:

|  | Mastodon (ActivityPub) | Bluesky (AT Protocol) | **HIVE** |
|---|---|---|---|
| Transport between nodes | HTTPS | HTTPS | **Hyperswarm DHT + Hypercore** |
| Discovery | DNS + WebFinger | Personal Data Server URL | **DHT, no DNS** |
| Identity | `@user@server` (dies with server) | DID, tied to a PDS | **Self-sovereign ed25519** |
| NAT traversal | No (public servers) | No (public servers) | **Yes (UDP holepunch)** |
| Indexer role | Your home server | Bluesky-hosted relay + appview in practice | **Any queen, anyone** |
| Data survives without the indexer? | No | Hard (PDS usually Bluesky-hosted) | **Yes — replicated signed Hypercores** |
| Censoring content | Admin can delete; defederation | Relay can drop | **Cannot** — signed copies persist on every peer that replicated |

Three points to keep in mind when the question comes up:

1. **"In Mastodon you die with your instance. In HIVE you die if you
   lose your key."** Your identity is not someone else's
   responsibility.
2. **"A queen is a convenience, not a gatekeeper."** Canonical truth
   lives in the bees' signed Hypercores. A queen is a derived
   index, reconstructible from scratch by anyone. If every queen
   on earth disappeared, one new operator restarting `HIVE_MODE=queen`
   would rebuild it.
3. **"Bees can live without queens. Mastodon cannot live without
   instances."** A network of 1000 bees and 0 queens is still a
   signed, replicated distributed archive. It just stops being
   semantically queryable until someone runs a queen.

HIVE is more P2P than Mastodon (no DNS, no server-bound identity, no
HTTPS between nodes) and more P2P than Bluesky (no centralised relay,
no PDS hosting bias) — while keeping the practical convenience of
"there is a public endpoint you can query".

**One subtle point on curation, since this is the question we get
most.** HIVE ships a finite set of *source adapters* (Wikipedia,
arXiv, RSS, Common Crawl). Each adapter is real code: it talks to a
specific public endpoint, knows that endpoint's quirks, and is shipped
in the binary. This is engineering, not editorial centralisation —
the same way a Mastodon client speaks ActivityPub, or a torrent client
speaks BitTorrent. *What each bee covers within those adapters* — its
scope — is declared by the operator, never approved by anyone. A
third party who wants a new adapter (Wikisource, PubMed, a national
archive) writes one and ships it; there is no `sources.json` in the
repo that gates which adapters exist at runtime. The curation line is
drawn at "this code knows how to talk to that endpoint", not at
"someone decided this knowledge matters".

An LLM querying HIVE sends its question as a vector, receives the most
semantically relevant verified fragments, and uses them as grounded
context. No hallucinations about things that are in HIVE. Full source
traceability for everything it cites.

## Why this matters

**For AI users:** Answers grounded in verifiable, up-to-date sources. Know exactly where every fact came from.

**For AI developers:** A decentralized RAG layer that doesn't require building and maintaining your own knowledge pipeline. Connect your LLM to HIVE and inherit the network's knowledge.

**For the open web:** A commons of machine-readable knowledge that no corporation can take down, edit silently, or monetize without giving back.

**For the future:** As AI agents become more capable, the quality of their knowledge base determines their quality. HIVE is that foundation — built in the open, owned by no one, maintained by everyone.

## The technology

HIVE is built on battle-tested P2P infrastructure, local-first systems, and the open technology stack maintained by Tether and Holepunch:

- **[Hypercore](https://github.com/holepunchto/hypercore)** — append-only cryptographic log with native P2P replication (same tech as Keet)
- **[Hyperswarm](https://github.com/holepunchto/hyperswarm)** — P2P DHT for node discovery and NAT hole-punching
- **[LanceDB](https://lancedb.com/)** — embedded vector store on the queen for scalable search across the full network (no separate database service)
- **[e5-base ONNX](https://huggingface.co/intfloat/multilingual-e5-base)** — local multilingual semantic embeddings, int8 768-d, runs in-process on CPU via `@huggingface/transformers` (all-Node since v0.8 — no Python)
- **LLM with function calling** — autonomous extraction agent (Groq, Gemini, Claude, OpenAI, or Ollama for fully local inference)

### Tether ecosystem integration (planned)

HIVE is built on Holepunch's P2P stack, which is part of Tether's open technology ecosystem. The following integrations extend HIVE naturally into that ecosystem:

- **[QVAC](https://qvac.tether.io/)** — local-first AI inference. Run the extraction agent's LLM directly on-device: no data leaves the BEE, no API costs, full privacy. Aligns with Tether's vision of sovereign computing where AI runs locally, not in someone else's cloud.
- **[WDK](https://wdk.tether.io/)** (Wallet Development Kit) — self-custodial payments. Each BEE gets an embedded wallet. Consumers pay micro-amounts in USD₮ for queries. Extractors earn USD₮ for contributing verified knowledge. No intermediaries, no custodians, no speculative token — real value in stablecoins from day one.
- **[Pears](https://pears.com/)** — P2P application runtime. Distribute and run BEEs as native P2P apps. Install from the swarm, update over the air, no dependency on GitHub or npm for distribution.

## The economics of knowledge

Knowledge has value. The current model — corporations scrape the web for free, train models, and charge for access — extracts value without giving back. HIVE proposes a different model:

**Extractors earn.** Every BEE that contributes verified knowledge to the network receives micropayments from consumers who query it. The more useful and reliable your fragments, the more you earn. Powered by self-custodial wallets (WDK) — no intermediary takes a cut.

**Consumers pay fairly.** A query to HIVE costs a fraction of a cent in USD₮. No subscriptions, no vendor lock-in. Pay per query, directly to the nodes that served you.

**Quality is verified.** Multi-agent consensus ensures that fragments are relevant, accurate, and properly sourced. BEEs that publish low-quality or fabricated content lose reputation and earn less.

**No speculative token.** HIVE uses USD₮ (stablecoins) for payments, not a custom token. The value is immediate and comprehensible. No ponzinomics, no "invest early for gains" — just payment for knowledge.

## How we build trust

Decentralized systems are only as good as their trust model. HIVE's approach:

- **Cryptographic identity:** every BEE has an ed25519 keypair. Every fragment is signed. You always know who contributed what.
- **Append-only history:** nothing is ever deleted or silently modified. Corrections are explicit events linked to the original.
- **Merkle tree verification:** Hypercore's native verification makes it mathematically impossible to inject falsified data without the author's private key.
- **Multi-agent consensus (planned):** multiple BEEs vote on fragment quality before it propagates widely. Reduces spam and misinformation without centralized moderation.
- **Source traceability:** every fragment links to its original source (arXiv paper, DOI, news article). The chain of provenance is always visible.

## Current state: v0.9.5

HIVE is a working, deployed system. The v0.8 all-Node engine (bees embed with
e5-base ONNX, sign inline, queen indexes in LanceDB) runs in production; v0.9
layered productisation on top. See the [README](./README.md) and CHANGELOG for
the full breakdown.

**What works today:**
- Autonomous BEEs extracting verbatim, signed knowledge from Wikipedia, arXiv,
  RSS, PubMed (NCBI E-utilities), and Common Crawl — connectors registered in a
  single **ForagerRegistry**
- Producer-side vectorization: each bee embeds + signs its vectors inline; the
  queen replicates and indexes them in embedded LanceDB (no Python, no Qdrant)
- Native Hypercore P2P replication between BEEs; ed25519-signed fragments
  verified on receive; `content_hash` corroboration across bees
- Multi-provider LLM synthesis (Groq, Gemini, Claude, OpenAI, **Ollama local**)
- **Distributed as npm** (`npx @capybaralabs/hive`) and as an **MCP server**
  (`@capybaralabs/hive-mcp`) + a Claude Skill — query HIVE from Claude/Cursor
- **Settings UI** (graphical manifest builder), optional bearer-token auth,
  HTTPS via Caddy + sslip.io, public/private topics with a discovery registry
- Zero-config Docker deployment: `docker compose up -d`

**What's next (v0.9.x → v1):**
- **Pluggable external connectors**: load 3rd-party `ForagerSource`s installed
  as npm packages (ours stay bundled) — extends the ForagerRegistry
- **Personal-memory adapter**: index your own context (Claude conversations,
  notes) into a private queen, surfaced through the MCP
- **Storage abstraction**: put the Holepunch P2P stack behind an interface so
  HIVE can also run in a centralized mode for orgs that don't want P2P
- Score-by-corroboration ranking; WDK micropayments + QVAC on-device inference
  (Tether-ecosystem, longer horizon)

## How to run a BEE

See [Quick start in the README](./README.md#quick-start) — Docker or from source. Zero configuration needed: your BEE will find an uncovered area and start extracting on its own.

## How to contribute code

The codebase is TypeScript (Node.js) + Python. The architecture is modular — every component is behind an interface and can be replaced independently.

**High-impact areas:**
- **Signature verification on receive** — validate ed25519 signatures when indexing peer fragments
- **Replication factor enforcement** — ensure each fragment exists on ≥ 3 BEEs
- **Semantic centroid routing** — BEEs advertise their knowledge centroid, queries route to relevant nodes
- **Multi-agent consensus** — BEEs vote on fragment quality before wide propagation
- **Topic tree expansion** — the current taxonomy has 95 topics; it should have 5000
- **Source diversity** — add PubMed, GitHub, Semantic Scholar, YouTube transcripts
- **QVAC integration** — add `LLM_PROVIDER=qvac` for on-device inference

See [CLAUDE.md](./CLAUDE.md) for a technical deep-dive and known issues.

## License

Business Source License (BUSL-1.1). Free for non-commercial use. Converts to MIT in 4 years.

---

*HIVE is a living project. The manifesto will evolve as the network grows.*

*If you believe AI knowledge should be a commons, not a corporate asset — run a BEE.*
