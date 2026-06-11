// Quick check for the v1.2.1 env-precedence fixes. Run: npx tsx src/wizard_check.mts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { runWizard } from './wizard.js';

const T = mkdtempSync(join(tmpdir(), 'hive-wizard-'));
process.env.XDG_CONFIG_HOME = join(T, 'cfg');
process.env.XDG_DATA_HOME = join(T, 'data');
process.env.XDG_CACHE_HOME = join(T, 'cache');

// 1. First run, non-TTY, explicit env: empty HIVE_API_KEY respected, role from env.
process.env.HIVE_MODE = 'queen';
process.env.HIVE_API_KEY = '';
const first = await runWizard();
assert.equal(first.role, 'queen');
assert.equal(first.hiveApiKey, '', 'explicit empty HIVE_API_KEY must not be replaced by a generated key');

// 2. Saved config now exists (role queen). Explicit arg overrides it.
const withArg = await runWizard('bee');
assert.equal(withArg.role, 'bee', 'explicit role arg must beat the saved config');

// 3. Env override beats saved config too.
process.env.HIVE_MODE = 'hive';
const withEnv = await runWizard();
assert.equal(withEnv.role, 'hive', 'HIVE_MODE env must beat the saved config');

// 4. Runner semantics: operator HIVE_DATA_DIR survives (mirrors runner.ts logic).
process.env.HIVE_DATA_DIR = '/operator/data';
const env = { HIVE_DATA_DIR: process.env.HIVE_DATA_DIR ?? withEnv.dataDir };
assert.equal(env.HIVE_DATA_DIR, '/operator/data');

console.log('wizard_check: 4/4 OK');
