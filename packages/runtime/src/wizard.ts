// Bootstrap (formerly "wizard"). Replaced interactive CLI prompts with
// sensible defaults — configuration is done via the Settings panel in
// the web UI (http://localhost:8080).
//
// Keeps the WizardResult interface so runner.ts needs no changes.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { configDir, dataDir, cacheDir, envFilePath } from './paths.js';

export interface WizardResult {
  role: 'queen' | 'bee' | 'hive';
  llmProvider: string;
  llmApiKey: string;
  topicMode: 'public' | 'private';
  publicTopic?: string;
  privateTopicHex?: string;
  hiveApiKey: string;
  dataDir: string;
  cacheDir: string;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function alreadyConfigured(): boolean {
  return existsSync(envFilePath());
}

export async function runWizard(): Promise<WizardResult> {
  const dir   = dataDir();
  const cache = cacheDir();
  const cfg   = configDir();
  mkdirSync(dir,   { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(cfg,   { recursive: true });

  if (alreadyConfigured()) return loadExisting();

  // First run — write a minimal .env with generated auth key.
  // Everything else (sources, LLM, topic) is configured via the web UI.
  const hiveApiKey = hex(16);
  const lines = [
    `# HIVE config — generated on first run ${new Date().toISOString()}`,
    `# Configure sources, LLM provider, and topic via the Settings panel`,
    `# in the web UI (http://localhost:8080).`,
    ``,
    `HIVE_MODE=hive`,
    `HIVE_DATA_DIR=${dir}`,
    `HIVE_API_KEY=${hiveApiKey}`,
    `HIVE_PUBLIC_DEMO_TOKEN=${hiveApiKey}`,
  ];
  writeFileSync(envFilePath(), lines.join('\n') + '\n', { mode: 0o600 });

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🐝  HIVE — first run                                   ║
╠══════════════════════════════════════════════════════════╣
║  Config written to: ${envFilePath().padEnd(36)} ║
║                                                          ║
║  Auth token: ${hiveApiKey.padEnd(43)}║
║                                                          ║
║  Open http://localhost:8080 to configure:                ║
║    · Knowledge sources (Wikipedia, arXiv, RSS…)          ║
║    · Network topic (public or private)                   ║
║    · LLM provider (for queen/hive query mode)            ║
╚══════════════════════════════════════════════════════════╝
`);

  return {
    role: 'hive',
    llmProvider: '',
    llmApiKey: '',
    topicMode: 'public',
    publicTopic: 'hive-network-v0.1',
    hiveApiKey,
    dataDir: dir,
    cacheDir: cache,
  };
}

function loadExisting(): WizardResult {
  const envText = readFileSync(envFilePath(), 'utf8');
  const env: Record<string, string> = {};
  for (const line of envText.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return {
    role: (env.HIVE_MODE as WizardResult['role']) ?? 'hive',
    llmProvider: env.LLM_PROVIDER ?? '',
    llmApiKey: env.LLM_API_KEY ?? '',
    topicMode: env.HIVE_TOPIC_HEX ? 'private' : 'public',
    publicTopic: env.HIVE_TOPIC,
    privateTopicHex: env.HIVE_TOPIC_HEX,
    hiveApiKey: env.HIVE_API_KEY ?? '',
    dataDir: env.HIVE_DATA_DIR ?? dataDir(),
    cacheDir: cacheDir(),
  };
}
