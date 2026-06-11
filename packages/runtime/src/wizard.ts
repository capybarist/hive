// Bootstrap (formerly "wizard"). The only interactive question is the node
// ROLE (bee/queen/hive) — that's the one thing the web Settings panel can't
// change later, because it determines the whole process shape (a bee has no
// query UI, a queen has no extractor). Everything else — sources, topic, LLM,
// auth key — is configured in the browser after the node starts.
//
// Non-interactive contexts (docker, CI, piped stdin) never see the prompt:
// they pass HIVE_MODE via env or `hive run <role>`, and we default to `hive`.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { configDir, dataDir, cacheDir, envFilePath } from './paths.js';

export type Role = 'queen' | 'bee' | 'hive';

export interface WizardResult {
  role: Role;
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

function normalizeRole(s: string | undefined): Role | null {
  const v = (s ?? '').trim().toLowerCase();
  if (v === '1' || v === 'bee') return 'bee';
  if (v === '2' || v === 'queen') return 'queen';
  if (v === '3' || v === 'hive') return 'hive';
  return null;
}

async function promptRole(): Promise<Role> {
  console.log(`
🐝  HIVE — choose a role for this node:

  1) bee    — producer: extracts & signs knowledge into Hypercore. No LLM key.
  2) queen  — consumer: answers queries with an LLM, replicates & indexes bees.
  3) hive   — both in one process (single-machine quickstart).

Everything else (sources, topic, LLM provider, auth key) is configured in the
web UI once the node is up — open http://localhost:8080 and follow Settings.
`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question('Role [1/2/3 or bee/queen/hive] (default: hive): ');
    return normalizeRole(ans) ?? 'hive';
  } catch {
    // Ctrl+D / closed stdin / aborted → take the default rather than crash.
    console.log('\n(no selection — defaulting to hive)');
    return 'hive';
  } finally {
    rl.close();
  }
}

export async function runWizard(roleArg?: string): Promise<WizardResult> {
  const dir   = dataDir();
  const cache = cacheDir();
  const cfg   = configDir();
  mkdirSync(dir,   { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(cfg,   { recursive: true });

  if (alreadyConfigured()) {
    const existing = loadExisting();
    // v1.2.1 — an explicit role (arg or env) overrides the SAVED role: the
    // operator typing `hive queen` (or setting HIVE_MODE in compose) means it,
    // even when a previous run on this volume saved something else.
    const override = normalizeRole(roleArg) ?? normalizeRole(process.env.HIVE_MODE);
    return override ? { ...existing, role: override } : existing;
  }

  // First run — pick the role. Priority: explicit arg → HIVE_MODE env →
  // interactive prompt (TTY only) → default `hive`.
  let role: Role =
    normalizeRole(roleArg) ??
    normalizeRole(process.env.HIVE_MODE) ??
    (process.stdin.isTTY ? await promptRole() : 'hive');

  // Minimal .env: auth key + chosen role. Sources/topic/LLM are set in the
  // web UI. An operator-provided HIVE_API_KEY (env) is recorded as-is —
  // including the EXPLICIT empty string, which means "API open by choice"
  // (internal deployments behind their own gate); only generate a key when
  // the operator expressed nothing.
  const hiveApiKey = process.env.HIVE_API_KEY ?? hex(16);
  const lines = [
    `# HIVE config — generated on first run ${new Date().toISOString()}`,
    `# Configure sources, topic, and LLM provider via the Settings panel in the`,
    `# web UI (http://localhost:8080).`,
    ``,
    `HIVE_MODE=${role}`,
    `HIVE_DATA_DIR=${dir}`,
    `HIVE_API_KEY=${hiveApiKey}`,
    `HIVE_PUBLIC_DEMO_TOKEN=${hiveApiKey}`,
  ];
  writeFileSync(envFilePath(), lines.join('\n') + '\n', { mode: 0o600 });

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🐝  HIVE — ${role.toUpperCase().padEnd(45)}║
╠══════════════════════════════════════════════════════════╣
║  Config: ${envFilePath().padEnd(48)}║
║  Auth:   ${hiveApiKey.padEnd(48)}║
║                                                          ║
║  → Open http://localhost:8080 and finish setup in        ║
║    Settings: sources, topic${role === 'bee' ? '.' : ', and LLM provider.'}${' '.repeat(role === 'bee' ? 21 : 8)}║
╚══════════════════════════════════════════════════════════╝
`);

  return {
    role,
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
    role: normalizeRole(env.HIVE_MODE) ?? 'hive',
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
