import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, assertNoUndefined, buildRecord } from '../src/contract.mjs';

test('canonicalize sorts keys so hashing is order-independent', () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test('contentHash is stable and differs on changed values', () => {
  assert.equal(contentHash({ a: 1 }), contentHash({ a: 1 }));
  assert.notEqual(contentHash({ a: 1 }), contentHash({ a: 2 }));
});

test('assertNoUndefined throws with the offending path', () => {
  assert.throws(() => assertNoUndefined({ a: { b: undefined } }), /\$\.a\.b/);
  assert.doesNotThrow(() => assertNoUndefined({ a: { b: null } }));
});

test('buildRecord produces a deterministic id and full provenance', () => {
  const r = buildRecord({
    host: 'example.test', sourceId: 42, sourceUrl: 'https://example.test/x',
    fields: { title: 'T' }, raw: { id: 42 }, fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(r.id, 'example.test:42');
  assert.equal(r.source_host, 'example.test');
  assert.equal(r.source_url, 'https://example.test/x');
  assert.equal(r.fetched_at, '2026-01-01T00:00:00.000Z');
  assert.equal(r.content_hash, contentHash({ title: 'T' }));
});

test('buildRecord rejects an undefined inside fields', () => {
  assert.throws(() => buildRecord({
    host: 'example.test', sourceId: 1, sourceUrl: 'https://example.test/1',
    fields: { title: undefined }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /undefined/i);
});
