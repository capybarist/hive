# HIVE — Use Cases

> Living catalogue of HIVE deployment patterns and integrations.
> Every case has a stable numeric ID — **never renumber**; add new cases at the end of the
> relevant section. The README links here as the canonical reference, and presentations,
> sales decks, and design docs should cite case IDs (e.g. *"this is case 09"*) instead of
> rewording.

---

## Index

**I. Network topology** — how nodes find each other and exchange data
- [01 · Public swarm](#01--public-swarm)
- [02 · Private swarm](#02--private-swarm)
- [03 · B2B partnership](#03--b2b-partnership)
- [04 · Hybrid multi-swarm queen](#04--hybrid-multi-swarm-queen)

**II. Stack composition** — how data and inference plug into HIVE
- [05 · Custom connectors (ForagerSource)](#05--custom-connectors-foragersource)
- [06 · Local AI · fully-offline stack](#06--local-ai--fully-offline-stack)
- [07 · Training corpus with provenance](#07--training-corpus-with-provenance)

**III. Knowledge domains** — what a HIVE actually *knows*
- [08 · Personal context memory](#08--personal-context-memory) 🆕
- [09 · Domain-specific knowledge bases](#09--domain-specific-knowledge-bases) 🆕
- [10 · Team / organisational knowledge](#10--team--organisational-knowledge) 🆕
- [11 · Per-project codebase context](#11--per-project-codebase-context) 🆕
- [12 · Cached web-search layer](#12--cached-web-search-layer) 🆕
- [13 · Auditable sourcing · journalism, OSINT, compliance](#13--auditable-sourcing--journalism-osint-compliance) 🆕

**IV. LLM client integrations** — how an agent or assistant consumes a HIVE
- [14 · MCP server](#14--mcp-server) 🆕
- [15 · Claude Skill bundle](#15--claude-skill-bundle) 🆕
- [16 · OpenClaw / agent ecosystems](#16--openclaw--agent-ecosystems) 🆕
- [17 · Multi-LLM knowledge backbone](#17--multi-llm-knowledge-backbone) 🆕

[**Recurring properties**](#recurring-properties) · [**Status legend**](#status-legend)

---

## I. Network topology

### 01 · Public swarm

**Scenario.** Anyone with HIVE installed wants to publish or consume open knowledge
without coordinating with a central authority.

**How it works.** A queen joins the public HIVE by hashing a known string —
`sha256("hive-network-v0.1")` — and calling `swarm.join(topic)`. Hyperswarm's DHT
introduces it to every BEE on that topic; native Hypercore replication brings their
signed fragments down with no central registry. Specialised public meshes are just
a different string (`hive-medical-v0.1`, `hive-legal-v0.1`) — same protocol, narrower swarm.

**Why HIVE.** No registry to seize, censor, or charge. Anyone can host a queen,
anyone can run a BEE, the swarm tolerates churn.

**Status.** 🟢 Production today.

`hyperswarm topic` · `DHT discovery` · `ed25519 fragments` · `no registry`

---

### 02 · Private swarm

**Scenario.** An organisation wants to run HIVE entirely inside its perimeter — no
traffic leaves the network, no public discovery, no third-party trust.

**How it works.** Three knobs flip the network private: a random 32-byte swarm
topic (2²⁵⁶ search space), Hypercore encryption keys so cores are ciphertext at
rest and on the wire, and a peer allowlist by pubkey that drops any unauthorised
connection on sight. Internal BEEs index company wikis, tickets, repos, contracts;
a queen serves `/api/query` to internal apps.

**Why HIVE.** Same protocol as the public network — no different "enterprise"
SKU, no licence change. Air-gap is a config flag, not an architecture.

**Status.** 🟢 Production today.

`random topic` · `encrypted cores` · `pubkey allowlist` · `air-gapped`

---

### 03 · B2B partnership

**Scenario.** Two organisations want to share specific knowledge with each other
without merging databases, exposing their full index, or going through a SaaS broker.

**How it works.** The two parties exchange three values out-of-band — swarm topic,
Hypercore encryption key, and each side's queen pubkey for the allowlist. Both
queens join the same private swarm and replicate only the BEEs the other party
chose to expose. Each company keeps its own queen, its own index, its own audit
trail. Revocation is a key roll or an allowlist edit — no contract amendments.

**Why HIVE.** Selective exposure with cryptographic boundaries. No data
custodian sits between the two parties.

**Status.** 🟢 Production today.

`shared swarm` · `encryption key` · `selective exposure` · `revocable`

---

### 04 · Hybrid multi-swarm queen

**Scenario.** A team wants a single query surface that answers from the public
mesh, their own private swarm, and several partner swarms simultaneously.

**How it works.** Cases 01–03 compose at the queen layer. A single queen can
join as many topics as it has credentials for and replicate BEEs from all of
them into one LanceDB index. One query, one LLM synthesis, sources drawn from
every swarm the queen belongs to. Every fragment keeps its origin pubkey and
signature, so provenance survives the merge — and nothing crosses *between*
swarms; the queen is the only place they meet.

**Why HIVE.** One operator-facing index without breaking the trust boundaries
of the underlying swarms.

**Status.** 🟢 Production today.

`multi-swarm queen` · `single index` · `provenance preserved` · `no cross-leak`

---

## II. Stack composition

### 05 · Custom connectors (ForagerSource)

**Scenario.** A customer needs HIVE to index something HIVE doesn't natively
know — a legacy ERP, an in-house REST API, a proprietary archive, a vertical
data feed.

**How it works.** Implement the `ForagerSource` interface (`seed` / `fetch` /
`normalize` / `owns`), publish as an npm package, and add the id to the BEE's
manifest. On next start the forager picks it up, drains its queue mechanically
and signs every emitted fragment. No fork of HIVE core, no central registry to
update — the connector lives in the customer's repo and ships as a normal
dependency.

**Why HIVE.** The same plugin contract that powers the built-in adapters
(Wikipedia, arXiv, RSS, CommonCrawl, Web) is the customer-facing extension
point. No tier of "approved partners" to negotiate with.

**Status.** 🟢 Production today. *Also enables [08](#08--personal-context-memory),
[10](#10--team--organisational-knowledge), [11](#11--per-project-codebase-context).*

`ForagerSource` · `npm package` · `BeeManifest.sources` · `no fork`

---

### 06 · Local AI · fully-offline stack

**Scenario.** A user (privacy-conscious individual, regulated industry,
disconnected environment) wants RAG without anything leaving the machine.

**How it works.** The queen's LLM client is pluggable; point it at Ollama (or
any local runtime) and the entire stack runs on-prem — BEEs extracting,
LanceDB indexing, embedder local (e5-base ONNX in-process), synthesis local.
A small model has narrow parametric memory; HIVE's retrieval gives it grounded,
signed context at query time, so on domain-bounded tasks the small-model + HIVE
combination behaves like a much larger model. Zero cloud traffic, zero API key.

**Why HIVE.** The natural knowledge layer for local-agent ecosystems
(QVAC-style, on-device assistants). Composes with cases 01-04 — a fully-local
queen can still join a public swarm to pull down the corpus, then disconnect.

**Status.** 🟢 Production today.

`ollama / local LLM` · `on-prem` · `zero cloud` · `grounded small model`

---

### 07 · Training corpus with provenance

**Scenario.** An ML team needs a training, SFT, or distillation corpus with
verifiable provenance — clean source URL, timestamp, signing identity per
fragment — for licence propagation, dataset audit, or training-data
transparency requirements.

**How it works.** BEEs store extractions *verbatim* — no LLM in the loop, no
paraphrase. Every fragment carries source URL, scope, timestamp, and an
ed25519 signature. Stream fragments straight off the queen's replicated
Hypercores into the pipeline. Filter by source, scope, language, or signing
BEE to build a broad generalist corpus or a narrow specialist one.

**Why HIVE.** Per-fragment, cryptographically verifiable provenance is rare
in open-data pipelines. Auditors can re-verify any fragment offline against
the publisher's pubkey years later.

**Status.** 🟢 Production today.

`verbatim` · `signed` · `filter by scope` · `pre-train / SFT / distillation`

---

## III. Knowledge domains

### 08 · Personal context memory 🆕

**Scenario.** Cross-session "memory" for an AI assistant. The user works with
Claude Code / Cursor / ChatGPT across many sessions; today the assistant
forgets everything that didn't fit in the last context window. A local HIVE
queen indexes the user's own activity — Claude conversations, command
history, notes, agent memory files — and serves it back as a retrievable
context store.

**How it works.** A `personal-activity` ForagerSource ([05](#05--custom-connectors-foragersource))
running in a local-only BEE indexes the operator's own artefacts: Claude
project memories, transcripts, recent shell history, notes. Fragments are
signed by the user's own ed25519 key and stay on a private swarm
([02](#02--private-swarm)). The MCP server ([14](#14--mcp-server)) exposes
this HIVE to whatever assistant is active.

**Why HIVE.** Local, signed, traceable — privacy by design (no cloud sync
of personal data, no third-party retention). Same protocol the user already
runs for other HIVEs; no new mental model.

**Scope decisions (2026-05-29).**
- Built **inside HIVE as a first-class adapter**, not as a separate
  microproject — leverages the existing forager / signing / replication / API
  surface unchanged.
- Initial sources: Claude memory files, conversation transcripts, agent
  scratch notes.
- **Out of scope for v1:** OS-level screen recording, OCR snapshots, clipboard
  watching. Revisit if the basic version proves valuable.

**Status.** 🔴 Designed, not built. Depends on cases [05](#05--custom-connectors-foragersource)
(ForagerSource) and [14](#14--mcp-server) (MCP server).

`personal RAG` · `cross-session memory` · `local-only` · `user-signed`

---

### 09 · Domain-specific knowledge bases 🆕

**Scenario.** A practitioner (lawyer, doctor, developer, researcher) wants an
LLM with deep, current knowledge of a specific domain — language docs,
StackOverflow, regulatory texts, medical literature, internal handbooks.

**How it works.** Specialised public swarms (`hive-rust-docs`, `hive-eu-law`,
`hive-k8s-ops`, …) hosted by the community of practice. BEEs in each swarm
maintain the corpus; queens are run by anyone — solo practitioners, firms,
SaaS providers — and consumed via MCP ([14](#14--mcp-server)) from whichever
assistant the user prefers.

**Why HIVE.** The maintainer of a domain queen retains leverage (governance,
monetisation, branding) without inventing a new platform — the protocol is
already there. For the consumer: same query interface across every domain,
swap queen URL to swap domain.

**Status.** 🟡 Mechanically possible today. Discovery of "which queen covers
what" is missing — see [Public Topics Registry](#unfinished-business) on the
roadmap.

`domain RAG` · `community-maintained` · `swappable per topic`

---

### 10 · Team / organisational knowledge 🆕

**Scenario.** A team or company wants an LLM-accessible knowledge base over
its own internal sources: Slack, Confluence, Linear, Jira, GitHub, contracts,
runbooks. Self-hosted, no data sent to a third-party AI vendor.

**How it works.** A private swarm ([02](#02--private-swarm)) inside the
corporate perimeter. Custom ForagerSources ([05](#05--custom-connectors-foragersource))
adapt the company's systems — most are thin wrappers over the existing
read-only API of each tool. Every employee's assistant (Claude, Cursor,
LibreChat, OpenClaw) consumes the queen via MCP.

**Why HIVE.** Self-hosted, signed, auditable — important for regulated
industries. Differentiator vs. Glean/Notion AI: open protocol, no vendor
lock-in, no per-seat fee scaling.

**Status.** 🟡 Topology is production-ready. Adapter set is what gates the
adoption curve — each connector (Slack, Confluence, …) is its own work item.

`enterprise RAG` · `self-hosted` · `auditable` · `no vendor lock-in`

---

### 11 · Per-project codebase context 🆕

**Scenario.** A developer wants an LLM assistant that always has fresh
context on the current repository — code, commits, issues, PRs, docs — without
re-priming the assistant every session.

**How it works.** One queen per repository (or per project). BEEs index the
working tree, git history, GitHub issues/PRs, and docs site. Subset of
[10](#10--team--organisational-knowledge) but per-repo rather than per-org —
much smaller scope, much faster to deploy. Claude Code / Cursor consume via
MCP ([14](#14--mcp-server)) so the assistant has *grounded* repo context, not
hallucinated.

**Why HIVE.** Distributed alternative to centralised offerings (Sourcegraph
Cody, Greptile). Code stays where it is; the queen is local to the developer
or to the team server. Composes with [08](#08--personal-context-memory) so
"my activity on this repo" is also queryable.

**Status.** 🟡 Mechanically possible with the existing web/file adapters.
Worth a dedicated `code-source` adapter that understands symbols, not just text.

`repo RAG` · `grounded code context` · `local or team-server`

---

### 12 · Cached web-search layer 🆕

**Scenario.** An LLM application makes a lot of web searches on a predictable
set of topics. Web-search APIs (Brave, Tavily, etc.) charge per call and
return unsigned text the model must trust blindly.

**How it works.** BEEs crawl the topics of interest at a steady cadence,
sign every fragment, and the queen serves them. The LLM application queries
the queen instead of the web-search API. Public swarm ([01](#01--public-swarm))
or private depending on use case.

**Why HIVE.** Cheaper at steady-state (no per-query fees), faster (local index
vs. remote search), and every cited fragment carries a verifiable signature
of which BEE produced it — useful when downstream output is consumed by
something that needs to cite or audit.

**Status.** 🟢 Production today (mechanically). Realising the value depends on
having BEEs crawling the right topics — community-driven.

`web-search alternative` · `signed snippets` · `cost-amortised`

---

### 13 · Auditable sourcing · journalism, OSINT, compliance 🆕

**Scenario.** A journalist, investigator, or compliance officer needs to
work with information whose provenance survives publication and litigation.
"The AI said so" is not a citation; "ed25519 signature of BEE X over fragment
Y from URL Z at timestamp T" is.

**How it works.** BEEs index regulated/official sources (government gazettes,
court records, regulator publications, official RSS) at known cadence. Every
fragment is signed by the BEE's identity and timestamped at extraction. The
journalist's assistant cites by fragment id; the cite is independently
verifiable years later, even if the original URL changes.

**Why HIVE.** Per-fragment cryptographic provenance is the differentiator —
no other RAG architecture provides it natively. Composes with [07](#07--training-corpus-with-provenance)
for the audit-trail story to data scientists, [09](#09--domain-specific-knowledge-bases)
for the per-domain story to practitioners.

**Status.** 🔴 The mechanics exist; what's missing is a citation-friendly
output format from the MCP server ([14](#14--mcp-server)) and example queens
(`hive-eu-official-journal`, `hive-uk-companies-house`, etc.).

`signed provenance` · `verifiable citation` · `cold-archive trustworthy`

---

## IV. LLM client integrations

### 14 · MCP server 🆕

**Scenario.** An assistant (Claude Desktop, Claude Code, Cursor, Continue,
Goose, OpenClaw, …) wants to use a HIVE queen as a native tool — without the
app developer having to know anything about Hypercore, ed25519, or LanceDB.

**How it works.** A standalone npm package `@capybaralabs/hive-mcp` exposes the
queen's API as MCP tools (`hive_query` for retrieval, `hive_list_sources` for
discovery) — resources (`hive://fragment/{id}`, `hive://manifest`,
`hive://stats`) are tracked for a follow-up. Stdio transport first
(universal), SSE later. The package is **slim** — it's a thin HTTP client to a
queen URL, not the whole HIVE stack — so a consumer who only wants to *use* a
HIVE doesn't need to install the full Hypercore toolchain.

**No LLM synthesis in the MCP path.** `hive_query` returns raw fragments;
the host LLM (Claude / Cursor / etc.) synthesises. The queen's `/api/query`
still supports `use_llm: true` for the queen's own UI, non-MCP integrations,
and [case 06](#06--local-ai--fully-offline-stack) — but routing fragments
through a weaker queen-side LLM only to be re-read by a stronger host LLM is
redundant and loses fidelity. Decision recorded 2026-05-29.

**Why HIVE.** Eliminates the integration cost for every host that already
speaks MCP. One MCP server, every MCP-aware client gets HIVE for free
(including [16 OpenClaw](#16--openclaw--agent-ecosystems)).

**Single-queen by design — no client-side federation.** Each MCP server
instance points at exactly one queen. Multi-source composition is handled
*queen-side* by [case 04 · Hybrid multi-swarm queen](#04--hybrid-multi-swarm-queen):
the operator's queen joins as many topics as it has credentials for
(public mesh, private corporate swarm, personal-data swarm, …), Hypercore
replication brings everything into one local LanceDB, and the queen serves
a single `/api/query`. The MCP layer must not duplicate this — it would
break privacy boundaries (the client would see what the queen is
authorised to see, but cross-queen LLM synthesis would leak fragments
between queens that are intentionally isolated by topic / encryption key).
A user who wants to consult *someone else's* queen without replicating
just points the MCP server at that queen's URL.

**Status.** 🔴 First package in the v0.9 productisation push. See
[ROADMAP.md §4](./ROADMAP.md#4-mcp--agents-integration-the-productization).

`@capybaralabs/hive-mcp` · `stdio + SSE` · `slim client` · `universal LLM host`

---

### 15 · Claude Skill bundle 🆕

**Scenario.** A Claude user wants HIVE behaviour available even where MCP
isn't reachable (claude.ai web, embedded contexts) — without configuring
infrastructure.

**How it works.** A `skills/hive-research/` package ships with the HIVE
repository: `SKILL.md` teaches the model *when* to consult HIVE (vs.
WebSearch), *how* to interpret scores and the corroboration signal, *what*
to say when `has_hive_data: false`. The tool script is a thin HTTP client to
the queen URL — independent of the MCP server, so the Skill works in
Skill-capable contexts that don't support MCP.

**Why HIVE.** The real value of the Skill is *behavioural guidance*, not
code — telling the model to prefer signed, dated HIVE fragments over open-web
guesses when applicable, and to admit absence rather than fabricate.

**Status.** 🔴 Drafting after [14](#14--mcp-server) ships. Mirror-published
to a separate repo for easy `~/.claude/skills/` install.

`SKILL.md` · `behavioural guidance` · `HTTP-direct` · `MCP-independent`

---

### 16 · OpenClaw / agent ecosystems 🆕

**Scenario.** A user running OpenClaw (or any other MCP-aware local agent
gateway) wants HIVE to appear in their tool palette alongside the other
500+ community MCP servers.

**How it works.** No HIVE-specific code. OpenClaw's `mcporter` discovers the
`@capybaralabs/hive-mcp` package ([14](#14--mcp-server)) from npm, the user
configures the queen URL, the tool is live. We additionally publish a
recommended OpenClaw skill bundle (configuration + prompt hints) for
out-of-the-box behaviour.

**Why HIVE.** A single, well-designed MCP server ([14](#14--mcp-server))
delivers integration with the entire MCP ecosystem — OpenClaw, Claude
Desktop, Cursor, Goose, Continue — without per-host effort.

**Status.** 🔴 Falls out of [14](#14--mcp-server) automatically. Publishing
the OpenClaw skill is a small follow-up.

`OpenClaw` · `mcporter` · `zero-extra-code reach` · `tool palette`

---

### 17 · Multi-LLM knowledge backbone 🆕

**Scenario.** An organisation uses several LLM providers (Claude, ChatGPT,
Gemini, in-house) for different tasks but wants *one* source of truth for
its knowledge base.

**How it works.** One queen serves every LLM. Claude consumes via MCP
([14](#14--mcp-server)); ChatGPT via a Custom GPT Action calling
`/api/query`; Gemini via a function-calling tool; the in-house model via
direct HTTP. The queen does not care which model is asking.

**Why HIVE.** Decouples *knowledge* from *LLM provider* — vendor switches
don't re-cost the knowledge base. Composes with [10](#10--team--organisational-knowledge)
for the enterprise multi-vendor case.

**Status.** 🟡 Mechanically possible today via `/api/query`. The MCP server
([14](#14--mcp-server)) is what makes the Claude/Cursor/Goose path one-step.

`vendor-agnostic` · `single source of truth` · `mixed-LLM org`

---

## Recurring properties

What makes HIVE the right tool for the cases above:

- **Per-fragment cryptographic signatures (ed25519).** Provenance survives
  merging, sharing, and re-export. Foundational for cases
  [03](#03--b2b-partnership), [04](#04--hybrid-multi-swarm-queen),
  [07](#07--training-corpus-with-provenance),
  [13](#13--auditable-sourcing--journalism-osint-compliance).
- **P2P with no central registry.** Hyperswarm DHT for discovery, Hypercore
  for transport. No party controls the network; resilient to censorship and
  vendor failure.
- **Topic-token access model.** "You have access to what you have the token
  for." Holds for both public and private swarms — same protocol, different
  tokens.
- **Pluggable LLM (cloud or local).** Enables [06](#06--local-ai--fully-offline-stack);
  decouples HIVE from any single AI vendor.
- **Pluggable vector store** (LanceDB today). The queen could route to a
  remote Qdrant for high-scale operators without changing the BEE side.

### Planned (v0.9)

- **Per-queen HTTP authentication.** The topic-token model protects
  *replication*; HTTP API on a public queen also needs auth to prevent abuse
  of the queen's compute (LLM tokens, rate), enable per-user audit, and
  unlock monetisation. Decision (2026-05-29): full authentication, not just
  opt-in — required when the queen is exposed publicly. See
  [ROADMAP.md §4](./ROADMAP.md#4-mcp--agents-integration-the-productization).

### Unfinished business

- **Public Topics Registry** — discovery of "which queens cover what topic"
  blocks the [09](#09--domain-specific-knowledge-bases) flywheel. Tracked on
  [ROADMAP.md §3](./ROADMAP.md#3--settings-ui--public-topics-registry-user-requested-v09).

---

## Status legend

| Icon | Meaning |
|---|---|
| 🟢 | Production today — works end-to-end with the current release |
| 🟡 | Mechanically possible — needs adapter, glue, or curation to land |
| 🔴 | Designed, not yet built — on the roadmap |
| 🆕 | Added 2026-05-29 |
