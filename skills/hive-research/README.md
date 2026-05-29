# hive-research — Claude Skill

Behavioural guidance that teaches Claude **when** to consult a HIVE queen and
**how** to read the response. Works alongside the `@capybaralabs/hive-mcp`
MCP server (which provides the *how*) — this Skill provides the *when* and
the synthesis discipline.

> Reference: [USE-CASES.md → case 15](../../docs/USE-CASES.md#15--claude-skill-bundle).

## What it does

Without this Skill, Claude only reaches for HIVE when you explicitly ask it
to (*"use hive_query for X"*). With this Skill loaded, Claude proactively
prefers HIVE for factual/citable questions and falls back to its own
knowledge or WebSearch when HIVE isn't the right tool — without you needing
to mention HIVE at all.

It also enforces the things that make HIVE valuable:

- Only synthesises from fragments that passed the queen's retrieval gate
- Cites every claim by fragment id + URL
- Refuses to fabricate when the queen returns nothing or only marginal hits
- Surfaces corroboration (multi-bee signatures of the same content) as a
  trust signal

## Install

**Claude Code / Claude Desktop / any client that reads `~/.claude/skills/`:**

```bash
git clone https://github.com/capybarist/hive
mkdir -p ~/.claude/skills
cp -r hive/skills/hive-research ~/.claude/skills/
# Reload your Claude client.
```

Or copy just the SKILL.md if you don't want the full repo:

```bash
mkdir -p ~/.claude/skills/hive-research
curl -fsSL https://raw.githubusercontent.com/capybarist/hive/main/skills/hive-research/SKILL.md \
  -o ~/.claude/skills/hive-research/SKILL.md
```

## Prerequisites

The Skill is just behavioural guidance — it does not call HIVE itself. For
Claude to actually reach a queen, you also need **one of**:

1. **The MCP server** — `@capybaralabs/hive-mcp` registered in your client.
   See its [README](https://www.npmjs.com/package/@capybaralabs/hive-mcp).
   This is the path the Skill prefers (uses `mcp__hive__hive_query`).
2. **An `HIVE_QUEEN_URL` in your conversation context** (e.g. you tell
   Claude *"my queen is at https://my-queen.example.com"*). The Skill
   instructs Claude to fall back to direct HTTP against `/api/query` in
   this mode, useful in contexts without MCP support (Claude.ai web).

Without either, the Skill stays dormant — Claude answers from its own
knowledge or other tools.

## Trying it out

After installing + reloading, ask Claude a question that should fire the
Skill's heuristic:

> *What is aromaticity in chemistry?*

If you have MCP wired to the public Hetzner demo queen, Claude should:

1. Recognise the question as factual and citation-worthy
2. Call `mcp__hive__hive_query` with the query
3. Synthesise an answer **citing each claim** by fragment id + URL
4. If HIVE has no fragments, say so explicitly rather than make something up

Compare with the same question and no Skill loaded — Claude will answer
from parametric knowledge with no citations and no way for you to verify
the source.

## License

BUSL-1.1 — same as the parent HIVE repo.
