// Hand-off layer: takes the wizard's result, exports the right env vars, and
// spawns the existing api_server entry point. The bundle step (esbuild)
// replaces the spawn target at build time with the bundled server.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WizardResult } from './wizard.js';

// In bundled mode the esbuild banner provides __dirname. In dev mode (tsx),
// derive it from import.meta.url under a unique name to avoid clashing with
// the bundler-provided global.
const HERE = dirname(fileURLToPath(import.meta.url));

export function runNode(cfg: WizardResult): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HIVE_MODE: cfg.role,
    HIVE_DATA_DIR: cfg.dataDir,
    HIVE_API_KEY: cfg.hiveApiKey,
    HIVE_PUBLIC_DEMO_TOKEN: cfg.hiveApiKey,
  };
  if (cfg.llmProvider) env.LLM_PROVIDER = cfg.llmProvider;
  if (cfg.llmApiKey) env.LLM_API_KEY = cfg.llmApiKey;
  if (cfg.publicTopic) env.HIVE_TOPIC = cfg.publicTopic;
  if (cfg.privateTopicHex) env.HIVE_TOPIC_HEX = cfg.privateTopicHex;

  // Dev-mode: spawn the workspace's api_server via tsx. The bundle step (when
  // shipped) replaces this with the bundled server.js. Until then, this works
  // only from a checkout of the HIVE monorepo.
  const serverEntry = resolveServerEntry();
  if (!serverEntry) {
    console.error(
      '\n✗ HIVE server entry not found.\n' +
      '  The published bundle is not built yet; running from a HIVE monorepo checkout is required for now.\n' +
      '  Expected one of:\n' +
      '    - dist/server.js (production bundle)\n' +
      '    - ../api/src/api_server.ts (monorepo dev mode)\n',
    );
    process.exit(1);
  }

  const isBundled = serverEntry.endsWith('.js') && serverEntry.includes('dist');
  const args = isBundled ? [serverEntry] : ['--import', 'tsx/esm', serverEntry];

  const child = spawn(process.execPath, args, {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

function resolveServerEntry(): string | null {
  const candidates = [
    resolve(HERE, 'server.js'),                            // bundled
    resolve(HERE, '../../api/src/api_server.ts'),          // monorepo dev
    resolve(HERE, '../../../packages/api/src/api_server.ts'),
  ];
  for (const c of candidates) {
    try {
      readFileSync(c, 'utf8');
      return c;
    } catch {}
  }
  return null;
}
