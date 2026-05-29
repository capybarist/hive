# @capybaralabs/hive

One-command install of a HIVE node — queen, bee, or both. Wraps the
[`capybarist/hive`](https://github.com/capybarist/hive) monorepo as a
publishable npm CLI.

> Status: **scaffold** (v0.1.0). Wizard + runner work; production bundle and
> npm publish are tracked as the next steps. Until then this only works from
> a checkout of the parent monorepo.

## Install (future, once published)

```bash
npm install -g @capybaralabs/hive
hive
```

Or one-shot:

```bash
npx @capybaralabs/hive
```

First run launches an interactive wizard:
- Pick role (queen / bee / hive)
- Pick LLM provider + key (if running a queen)
- Pick topic mode (public / private)
- Generates an ed25519 identity, an `HIVE_API_KEY`, and a manifest
- Saves config to `$XDG_CONFIG_HOME/hive/.env`
- Starts the node

Subsequent runs read the saved config and start directly.

## Commands

```
hive                      Start (runs wizard on first invocation)
hive run [queen|bee|hive] Start with explicit role override
hive init                 Run the wizard, do not start
hive settings             (coming with the Settings UI — roadmap 3b)
```

## Where things live

| Purpose | Path (Linux/macOS) |
|---|---|
| Persistent data (identity, hypercores, lancedb) | `$XDG_DATA_HOME/hive` → `~/.local/share/hive` |
| Cached downloads (ONNX model, prebuilds) | `$XDG_CACHE_HOME/hive` → `~/.cache/hive` |
| Saved config / `.env` | `$XDG_CONFIG_HOME/hive/.env` → `~/.config/hive/.env` |

On Windows the equivalents are `%APPDATA%\hive`, `%LOCALAPPDATA%\hive\cache`,
`%APPDATA%\hive\config`.

## Develop

```bash
cd packages/runtime
npm install
npx tsx src/cli.ts   # run wizard against the monorepo (dev mode)
```

In dev mode the runner spawns `../../api/src/api_server.ts` via tsx — works
only inside a HIVE monorepo checkout. The bundled `dist/server.js` (esbuild)
that the publishable package will ship is not implemented yet.

## License

BUSL-1.1 — same as HIVE.
