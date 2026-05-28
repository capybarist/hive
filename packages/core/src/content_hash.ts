import { createHash } from 'node:crypto';

// HIVE v0.8 — canonical content hash. Two faithful extractions of the same
// text (via the same deterministic chunker) must hash identically so the
// queen can corroborate across bees. NFC + trim + collapse internal
// whitespace; NO lowercasing (verbatim is preserved).
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}
