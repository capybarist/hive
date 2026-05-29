// First-run wizard. Asks the operator the bare minimum it needs (role, LLM,
// topic privacy), generates the rest (identity, auth key, sample manifest,
// data dir), writes everything to the standard XDG locations, and hands off
// to the runner. No edit of source files; the user can override anything via
// env vars later.

import * as p from '@clack/prompts';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { join } from 'node:path';
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
  identityPubkeyHex: string;
}

const PUBLIC_TOPICS = [
  { value: 'hive-network-v0.1',  label: 'hive-network-v0.1  · general / open' },
  { value: 'hive-medical-v0.1',  label: 'hive-medical-v0.1  · medical knowledge' },
  { value: 'hive-legal-v0.1',    label: 'hive-legal-v0.1    · legal texts' },
  { value: 'hive-rust-docs',     label: 'hive-rust-docs     · Rust language + ecosystem' },
];

const LLM_PROVIDERS = [
  { value: 'groq',   label: 'groq    · fast, free tier, no payment method required',  hint: 'aistudio.google.com → API key' },
  { value: 'gemini', label: 'gemini  · Google free tier, generous limits' },
  { value: 'claude', label: 'claude  · Anthropic, paid, highest quality' },
  { value: 'openai', label: 'openai  · GPT-4o, paid' },
  { value: 'ollama', label: 'ollama  · local LLM, no API key, slowest' },
];

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function alreadyConfigured(): boolean {
  return existsSync(envFilePath());
}

/** Generate a Hyperswarm-compatible 32-byte topic from any string. */
function topicFromString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export async function runWizard(): Promise<WizardResult> {
  p.intro('🐝  HIVE first-run setup');

  if (alreadyConfigured()) {
    const reuse = await p.confirm({
      message: `Found existing config at ${configDir()}. Reuse it?`,
      initialValue: true,
    });
    if (reuse === true) {
      return loadExisting();
    }
    if (p.isCancel(reuse)) {
      p.cancel('Aborted.');
      process.exit(0);
    }
  }

  const role = await p.select({
    message: 'What role should this node run?',
    options: [
      { value: 'hive',  label: 'hive   · both queen + bee in one process (single-machine quickstart)' },
      { value: 'queen', label: 'queen  · query/synthesis only (replicates bees, runs the LLM)' },
      { value: 'bee',   label: 'bee    · producer only (extracts + signs fragments, no LLM)' },
    ],
    initialValue: 'hive',
  });
  if (p.isCancel(role)) bail();

  let llmProvider = '';
  let llmApiKey = '';
  if (role === 'queen' || role === 'hive') {
    const provider = await p.select({
      message: 'LLM provider for the queen?',
      options: LLM_PROVIDERS,
      initialValue: 'groq',
    });
    if (p.isCancel(provider)) bail();
    llmProvider = provider as string;

    if (llmProvider !== 'ollama') {
      const key = await p.password({
        message: `${llmProvider.toUpperCase()} API key (paste, will not echo):`,
        validate: (v) => v && v.length > 8 ? undefined : 'Looks too short — paste the full key.',
      });
      if (p.isCancel(key)) bail();
      llmApiKey = key as string;
    }
  }

  const topicMode = await p.select({
    message: 'Topic mode?',
    options: [
      { value: 'public',  label: 'public   · join a well-known swarm (anyone can replicate)' },
      { value: 'private', label: 'private  · generate a fresh 32-byte topic (share out-of-band)' },
    ],
    initialValue: 'public',
  });
  if (p.isCancel(topicMode)) bail();

  let publicTopic: string | undefined;
  let privateTopicHex: string | undefined;
  if (topicMode === 'public') {
    const chosen = await p.select({
      message: 'Which public swarm?',
      options: PUBLIC_TOPICS,
      initialValue: 'hive-network-v0.1',
    });
    if (p.isCancel(chosen)) bail();
    publicTopic = chosen as string;
  } else {
    privateTopicHex = hex(32);
    p.note(privateTopicHex, 'Your private topic (write this down — it is the only copy)');
  }

  const s = p.spinner();
  s.start('Generating identity and provisioning directories');

  // ed25519 identity (the bee/queen pubkey)
  const { publicKey } = generateKeyPairSync('ed25519');
  const pubkeyDer = publicKey.export({ format: 'der', type: 'spki' });
  const identityPubkeyHex = pubkeyDer.toString('hex');

  // Generated auth token — what the API requires for /api/*
  const hiveApiKey = hex(16);

  // Make directories
  const dir = dataDir();
  const cache = cacheDir();
  const cfg = configDir();
  mkdirSync(dir, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(cfg, { recursive: true });

  s.stop('Generated identity and directories');

  // Write .env
  const lines: string[] = [
    `# HIVE config — written by the first-run wizard on ${new Date().toISOString()}`,
    `# Override any of these manually; see USE-CASES.md for what each does.`,
    ``,
    `HIVE_MODE=${role}`,
    `HIVE_DATA_DIR=${dir}`,
    `HIVE_API_KEY=${hiveApiKey}`,
    `HIVE_PUBLIC_DEMO_TOKEN=${hiveApiKey}`,
  ];
  if (llmProvider) {
    lines.push(`LLM_PROVIDER=${llmProvider}`);
    if (llmApiKey) lines.push(`LLM_API_KEY=${llmApiKey}`);
  }
  if (publicTopic) lines.push(`HIVE_TOPIC=${publicTopic}`);
  if (privateTopicHex) lines.push(`HIVE_TOPIC_HEX=${privateTopicHex}`);
  writeFileSync(envFilePath(), lines.join('\n') + '\n', { mode: 0o600 });

  p.note(
    `Auth token: ${hiveApiKey}\n` +
    `Saved to:   ${envFilePath()}\n\n` +
    `Anyone calling /api/* on this queen will need:\n` +
    `   Authorization: Bearer ${hiveApiKey}\n\n` +
    `Rotate later by editing ${envFilePath()} and restarting.`,
    'Generated HIVE_API_KEY',
  );

  p.outro('✓ Configured. Starting node...');

  return {
    role: role as WizardResult['role'],
    llmProvider,
    llmApiKey,
    topicMode: topicMode as 'public' | 'private',
    publicTopic,
    privateTopicHex,
    hiveApiKey,
    dataDir: dir,
    cacheDir: cache,
    identityPubkeyHex,
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
    identityPubkeyHex: '',
  };
}

function bail(): never {
  p.cancel('Aborted.');
  process.exit(0);
}
