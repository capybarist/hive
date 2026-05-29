// Build the publishable @capybaralabs/hive bundles.
//
// Strategy (v0.1.1): per-package bundles, NOT one mega-bundle. esbuild
// bundling the whole api_server into a single ESM file double-loaded the
// native Holepunch storage stack (corestore → device-file → fd-lock), which
// crashed at startup ("File descriptor could not be locked"). Bundling each
// @hive/* package into its own file and linking them with relative imports
// mirrors the monorepo's module structure: corestore is `external`, so Node
// loads it exactly once across all the package bundles (one device-file lock).
//
//   dist/core/index.js            ← @hive/core (npm deps external)
//   dist/embeddings-node/index.js ← @hive/embeddings-node (imports ../core)
//   dist/agent/index.js           ← @hive/agent (imports ../core, ../embeddings-node)
//   dist/server.js                ← api_server entry (imports ./core, ./agent, ...)
//   dist/cli.js                   ← the CLI (wizard/runner/paths; spawns server.js)
//
// Cross-package @hive/* imports are marked external and rewritten to the
// relative sibling path afterwards (depth-aware).

import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(__dirname, '..');
const REPO_ROOT = join(RUNTIME_DIR, '../..');
const DIST = join(RUNTIME_DIR, 'dist');

const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, 'package.json'), 'utf8'));
const npmExternal = Object.keys(pkg.dependencies ?? {});

// Inject the HIVE protocol version (monorepo root package.json) at build time
// so the published bundle reports the right version instead of 'unknown'.
const rootVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;
const define = { __HIVE_VERSION__: JSON.stringify(rootVersion) };

// Every @hive/* package is external to every bundle (linked via relative paths).
const HIVE_PKGS = ['@hive/core', '@hive/embeddings-node', '@hive/agent', '@hive/api'];
const allExternal = [...npmExternal, ...HIVE_PKGS];

mkdirSync(DIST, { recursive: true });

const base: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: allExternal,
  define,
  logLevel: 'warning',
};

// ── Per-package bundles ──────────────────────────────────────────────────────
// Order doesn't matter for the build (all cross-refs are external), only for
// runtime resolution (handled by the relative-path rewrite below).
const packageBuilds: Array<{ entry: string; out: string }> = [
  { entry: join(REPO_ROOT, 'packages/core/src/index.ts'),            out: join(DIST, 'core/index.js') },
  { entry: join(REPO_ROOT, 'packages/embeddings-node/src/index.ts'), out: join(DIST, 'embeddings-node/index.js') },
  { entry: join(REPO_ROOT, 'packages/agent/src/index.ts'),           out: join(DIST, 'agent/index.js') },
];

for (const { entry, out } of packageBuilds) {
  await esbuild.build({ ...base, entryPoints: [entry], outfile: out });
}

// ── Server entry (api_server) ────────────────────────────────────────────────
await esbuild.build({
  ...base,
  entryPoints: [join(REPO_ROOT, 'packages/api/src/api_server.ts')],
  outfile: join(DIST, 'server.js'),
});

// ── CLI entry ────────────────────────────────────────────────────────────────
await esbuild.build({
  ...base,
  entryPoints: [join(RUNTIME_DIR, 'src/cli.ts')],
  outfile: join(DIST, 'cli.js'),
  banner: { js: '#!/usr/bin/env node' },
});
chmodSync(join(DIST, 'cli.js'), 0o755);

// ── Rewrite @hive/* imports to relative sibling paths ────────────────────────
// Map each @hive/* to its built file, then for each emitted file rewrite the
// import specifier to the correct relative path based on that file's location.
const hiveTargets: Record<string, string> = {
  '@hive/core': join(DIST, 'core/index.js'),
  '@hive/embeddings-node': join(DIST, 'embeddings-node/index.js'),
  '@hive/agent': join(DIST, 'agent/index.js'),
  '@hive/api': join(DIST, 'api/index.js'),
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

for (const file of walk(DIST)) {
  let src = readFileSync(file, 'utf8');
  let changed = false;
  for (const [spec, target] of Object.entries(hiveTargets)) {
    if (!src.includes(spec)) continue;
    let rel = relative(dirname(file), target).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = './' + rel;
    // Replace both `from "@hive/x"` and `from '@hive/x'`.
    src = src.split(`"${spec}"`).join(`"${rel}"`).split(`'${spec}'`).join(`'${rel}'`);
    changed = true;
  }
  if (changed) writeFileSync(file, src);
}

const sz = (p: string) => `${(statSync(p).size / 1024).toFixed(1)} KB`;
console.log(`\n✓ Per-package bundles built (no mega-bundle):`);
console.log(`  dist/cli.js                    ${sz(join(DIST, 'cli.js'))}`);
console.log(`  dist/server.js                 ${sz(join(DIST, 'server.js'))}`);
console.log(`  dist/core/index.js             ${sz(join(DIST, 'core/index.js'))}`);
console.log(`  dist/embeddings-node/index.js  ${sz(join(DIST, 'embeddings-node/index.js'))}`);
console.log(`  dist/agent/index.js            ${sz(join(DIST, 'agent/index.js'))}`);
console.log(`  external npm deps: ${npmExternal.length}`);
