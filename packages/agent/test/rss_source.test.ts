import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rssSource } from '../src/forager/rss_source.js';

const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/rss-entity-heavy.xml', import.meta.url)),
  'utf8',
);

test('a feed over the parser entity budget still yields its items', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(fixture, { status: 200 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await rssSource.fetch('https://example.com/feed.xml');

  assert.equal(result.fragments.length, 1);
  const [fragment] = result.fragments;
  assert.equal(fragment?.title, 'Hearing rescheduled');
  assert.match(fragment?.text ?? '', /Hearing rescheduled to 11\/25\/2025/);
  // The escaped angle brackets in the description are decoded, not dropped.
  assert.match(fragment?.text ?? '', />>>/);
});
