import { createHash } from 'node:crypto';

// Normalize text the SAME way on every bee so two faithful extractions of the
// same content hash identically → corroboration. NFC + trim + collapse internal
// whitespace. NO lowercasing (preserve verbatim).
export function normalizeForHash(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function contentHash(text: string): string {
  return createHash('sha256').update(normalizeForHash(text), 'utf8').digest('hex');
}
