// Build the publishable @capybaralabs/hive bundles.
//
// Two outputs:
//   dist/cli.js     — the user-facing CLI (wizard, dispatcher, runner)
//   dist/server.js  — bundled api_server, the spawn target the runner hands
//                     control to once dist/server.js exists on disk
//
// Everything in package.json `dependencies` is marked external — native
// modules (corestore, lancedb, onnx via @huggingface/transformers) cannot
// be bundled because their prebuilds expect to live under node_modules/.
// Workspace `@hive/*` packages stay internal: esbuild follows them and
// inlines the code, so the published bundle has no runtime dependency on
// the monorepo source.

import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, chmodSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR = join(__dirname, '..');
const REPO_ROOT = join(RUNTIME_DIR, '../..');

const pkg = JSON.parse(readFileSync(join(RUNTIME_DIR, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

const DIST = join(RUNTIME_DIR, 'dist');
mkdirSync(DIST, { recursive: true });

const common: esbuild.BuildOptions = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external,
  logLevel: 'info',
  // esbuild auto-generates the __dirname/__filename polyfill per-file when it
  // sees those identifiers in source — we only need to provide require() for
  // ESM-bundled code that does `require()` of an external dep at runtime
  // (notably some Holepunch/native modules' lazy bindings).
  banner: {
    js: [
      `import { createRequire as __createRequire } from 'node:module';`,
      `const require = __createRequire(import.meta.url);`,
    ].join('\n'),
  },
};

// CLI bundle
await esbuild.build({
  ...common,
  entryPoints: [join(RUNTIME_DIR, 'src/cli.ts')],
  outfile: join(DIST, 'cli.js'),
  banner: {
    js: `#!/usr/bin/env node\n${common.banner!.js}`,
  },
});
chmodSync(join(DIST, 'cli.js'), 0o755);

// Server bundle — bundles api_server.ts plus its transitive @hive/* imports
await esbuild.build({
  ...common,
  entryPoints: [join(REPO_ROOT, 'packages/api/src/api_server.ts')],
  outfile: join(DIST, 'server.js'),
});

const cliSize = statSync(join(DIST, 'cli.js')).size;
const serverSize = statSync(join(DIST, 'server.js')).size;
console.log(`\n✓ Bundles built:`);
console.log(`  dist/cli.js     ${(cliSize / 1024).toFixed(1)} KB`);
console.log(`  dist/server.js  ${(serverSize / 1024).toFixed(1)} KB`);
console.log(`  external deps:  ${external.length} (${external.slice(0, 5).join(', ')}...)`);
