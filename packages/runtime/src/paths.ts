// Where HIVE stores its things on the user's machine.
//
// Defaults follow XDG on Linux (and macOS where possible) and the closest
// equivalent on Windows. Anyone who has an opinion can override via env vars.

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const PLATFORM = platform();

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v : fallback;
}

/** Persistent data: identity, hypercores, lancedb. Survives reinstalls. */
export function dataDir(): string {
  if (PLATFORM === 'win32') {
    return join(envOr('APPDATA', join(HOME, 'AppData', 'Roaming')), 'hive');
  }
  return join(envOr('XDG_DATA_HOME', join(HOME, '.local', 'share')), 'hive');
}

/** Cached downloads: ONNX model weights, prebuilds, etc. Disposable. */
export function cacheDir(): string {
  if (PLATFORM === 'win32') {
    return join(envOr('LOCALAPPDATA', join(HOME, 'AppData', 'Local')), 'hive', 'cache');
  }
  return join(envOr('XDG_CACHE_HOME', join(HOME, '.cache')), 'hive');
}

/** Saved config + .env. Edited rarely after first run. */
export function configDir(): string {
  if (PLATFORM === 'win32') {
    return join(envOr('APPDATA', join(HOME, 'AppData', 'Roaming')), 'hive', 'config');
  }
  return join(envOr('XDG_CONFIG_HOME', join(HOME, '.config')), 'hive');
}

export function envFilePath(): string {
  return join(configDir(), '.env');
}
