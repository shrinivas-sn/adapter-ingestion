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

// --- V03: identity/URL invariants are unconditional ---

test('buildRecord accepts source_id 0 and produces id "host:0"', () => {
  const r = buildRecord({
    host: 'example.test', sourceId: 0, sourceUrl: 'https://example.test/x',
    fields: { title: 'T' }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(r.id, 'example.test:0');
});

test('buildRecord accepts a valid cross-host source_url', () => {
  const r = buildRecord({
    host: 'example.test', sourceId: 1, sourceUrl: 'https://cdn.other-host.test/x',
    fields: { title: 'T' }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(r.source_url, 'https://cdn.other-host.test/x');
});

test('buildRecord rejects a blank/whitespace-only source_id', () => {
  assert.throws(() => buildRecord({
    host: 'h', sourceId: '   ', sourceUrl: 'https://example.test/x',
    fields: {}, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /source_id/);
});

test('buildRecord rejects a non-finite source_id', () => {
  for (const sourceId of [NaN, Infinity, -Infinity]) {
    assert.throws(() => buildRecord({
      host: 'h', sourceId, sourceUrl: 'https://example.test/x',
      fields: {}, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
    }), /source_id/);
  }
});

test('buildRecord rejects a null, boolean, or object source_id', () => {
  for (const sourceId of [null, true, {}, []]) {
    assert.throws(() => buildRecord({
      host: 'h', sourceId, sourceUrl: 'https://example.test/x',
      fields: {}, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
    }), /source_id/);
  }
});

test('buildRecord rejects a source_url with embedded credentials', () => {
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://user:pass@example.test/x',
    fields: {}, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /source_url/);
});

test('buildRecord rejects a non-http(s) source_url protocol', () => {
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'ftp://example.test/x',
    fields: {}, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /source_url/);
});

test('buildRecord rejects a cyclic direct-JS fields object', () => {
  const fields = { title: 'T' };
  fields.self = fields;
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
    fields, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /circular/);
});

test('buildRecord rejects a non-finite number nested inside fields', () => {
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
    fields: { nested: { bad: Infinity } }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /non-finite/);
});

test('buildRecord rejects a function, symbol, or bigint nested inside fields', () => {
  for (const bad of [() => {}, Symbol('x'), 10n]) {
    assert.throws(() => buildRecord({
      host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
      fields: { bad }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
    }));
  }
});

test('buildRecord rejects fields nested deeper than 100 levels', () => {
  let deep = { v: 1 };
  for (let i = 0; i < 105; i++) deep = { child: deep };
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
    fields: deep, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }), /nesting exceeds/);
});

test('buildRecord accepts fields nested exactly at the 100-level bound', () => {
  let deep = { v: 1 };
  for (let i = 0; i < 98; i++) deep = { child: deep };
  assert.doesNotThrow(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
    fields: deep, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  }));
});

test('buildRecord rejects an invalid fetched_at timestamp', () => {
  assert.throws(() => buildRecord({
    host: 'h', sourceId: 1, sourceUrl: 'https://example.test/x',
    fields: {}, raw: {}, fetchedAt: 'not-a-date',
  }), /fetched_at/);
});

test('a hash computed on an existing fixture record is preserved as a literal baseline', () => {
  // Guards against an accidental change to canonicalize/contentHash in a
  // later task: this literal was computed once, from the algorithm as it
  // exists today (node -e against this exact canonicalize/contentHash pair),
  // and must never silently change.
  assert.equal(contentHash({ title: 'T' }),
    '6d05dcd7395808f66309c9411db93fdc57fb861efc95938239e2459de048f547');
});
