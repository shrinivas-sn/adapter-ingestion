import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, extractAll } from '../src/extract.mjs';
import { baseAdapter } from './helpers/fixtures.mjs';

const adapter = {
  host: 'example.test',
  map: {
    source_id: { path: 'id' },
    url:       { path: 'link' },
    title:     { path: 'title.rendered', normalize: 'text' },
    price:     { path: 'meta.amount',    normalize: 'number' },
  },
  required: ['source_id', 'url', 'title'],
};
const items = [
  { id: 1, link: 'https://example.test/1', title: { rendered: ' <b>One</b> ' }, meta: { amount: '₹ 1,200' } },
  { id: 2, link: 'https://example.test/2', title: { rendered: '' }, meta: {} },
];

test('getPath walks objects, arrays and root', () => {
  assert.equal(getPath({ a: { b: [ { c: 7 } ] } }, 'a.b.0.c'), 7);
  assert.equal(getPath({ a: 1 }, '$').a, 1);
  assert.equal(getPath({ a: 1 }, 'a.missing.deep'), undefined);
});

test('extractAll maps, normalizes and never emits undefined', () => {
  const { records } = extractAll(items, adapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'example.test:1');
  assert.equal(records[0].fields.title, 'One');
  assert.equal(records[0].fields.price, 1200);
  assert.ok(!Object.values(records[0].fields).includes(undefined));
});

test('a record missing a required field is reported, not silently dropped', () => {
  const { errors } = extractAll(items, adapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].index, 1);
  assert.deepEqual(errors[0].missing, ['title']);
});

test('an optional field that is absent becomes null, not undefined', () => {
  const { records } = extractAll([items[0]], { ...adapter, map: { ...adapter.map, extra: { path: 'nope' } } },
    { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records[0].fields.extra, null);
});

// --- V03: unconditional identity/URL, independent of the adapter's own `required` list ---

test('missing identities cannot collapse unrelated records', () => {
  const { records, errors } = extractAll(
    [{ title: 'A' }, { title: 'B' }], baseAdapter,
    { fetchedAt: '2026-09-18T00:00:00.000Z' });
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => e.missing.includes('source_id')));
});

test('a zero source_id and a false ordinary field both survive as valid, not missing', () => {
  const localAdapter = {
    host: 'example.test',
    map: {
      source_id: { path: 'id' }, url: { path: 'link' },
      title: { path: 'title.rendered', normalize: 'text' }, active: { path: 'active' },
    },
    required: ['source_id', 'url', 'title'],
  };
  const { records, errors } = extractAll(
    [{ id: 0, link: 'https://example.test/0', title: { rendered: 'Zero' }, active: false }],
    localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(errors.length, 0);
  assert.equal(records[0].id, 'example.test:0');
  assert.equal(records[0].fields.active, false);
});

test('a whitespace-only required field is treated as missing', () => {
  const { errors } = extractAll(
    [{ id: 1, link: 'https://example.test/1', title: { rendered: '   ' } }],
    adapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0].missing, ['title']);
});

test('an invalid (not merely blank) source_url is reported as invalid, even when url is not in required', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['title'],
  };
  const { records, errors } = extractAll(
    [{ id: 1, link: 'ftp://example.test/1', title: 'A' }],
    localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records.length, 0);
  assert.deepEqual(errors[0].missing, []);
  assert.deepEqual(errors[0].invalid, ['url']);
});

// --- V04: own-property paths only, no inherited traversal or prototype mutation ---

test('a JSON.parse-created __proto__ key is read as an own property, and the real prototype is untouched', () => {
  const item = JSON.parse('{"__proto__":{"leaked":true},"id":7,"link":"https://example.test/7"}');
  assert.equal(Object.getPrototypeOf(item), Object.prototype);
  assert.equal(getPath(item, '__proto__.leaked'), true);
  assert.equal(({}).leaked, undefined);
});

test('getPath never falls through to an inherited property', () => {
  assert.equal(getPath({}, 'constructor'), undefined);
  assert.equal(getPath({}, 'toString'), undefined);
  assert.equal(getPath({}, 'hasOwnProperty'), undefined);
});

test('getPath returns undefined for a non-object intermediate instead of indexing into it', () => {
  assert.equal(getPath({ a: 'a string' }, 'a.0'), undefined);
  assert.equal(getPath({ a: 5 }, 'a.toFixed'), undefined);
});

test('numeric array indices in a dot path still work under own-property lookup', () => {
  assert.equal(getPath({ a: [10, 20, 30] }, 'a.1'), 20);
});

// --- X01: mixed valid/invalid records retain valid rows with bounded, safe diagnostics ---

test('25 rejected rows: errorCount and fieldFailures are exact, errors samples cap at 20', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['title'],
  };
  const items = [];
  for (let i = 0; i < 25; i++) items.push({ id: i, link: 'https://example.test/x', title: '' }); // blank title
  for (let i = 0; i < 5; i++) items.push({ id: `ok-${i}`, link: 'https://example.test/ok', title: 'Fine' });
  const { records, errors, errorCount, fieldFailures } = extractAll(items, localAdapter,
    { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records.length, 5);
  assert.equal(errorCount, 25);
  assert.equal(errors.length, 20);
  assert.equal(fieldFailures.title, 25);
});

test('a mix of missing, invalid, and valid records collects distinct field failures across all of them', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['title'],
  };
  const items = [
    { id: 1, link: 'https://example.test/1' }, // title missing (map returns null -> missing)
    { id: 2, link: 'not a url', title: 'A' }, // url invalid
    { link: 'https://example.test/3', title: 'A' }, // source_id missing
    { id: 4, link: 'https://example.test/4', title: 'A' }, // valid
  ];
  const { records, errorCount, fieldFailures } = extractAll(items, localAdapter,
    { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records.length, 1);
  assert.equal(errorCount, 3);
  assert.deepEqual(fieldFailures, { title: 1, url: 1, source_id: 1 });
});

test('one invalid record does not throw away or corrupt sibling valid records', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['title'],
  };
  const items = [
    { id: 1, link: 'https://example.test/1', title: 'A' },
    { id: 2, link: 'javascript:alert(1)', title: 'B' },
    { id: 3, link: 'https://example.test/3', title: 'C' },
  ];
  const { records, errorCount } = extractAll(items, localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.id), ['example.test:1', 'example.test:3']);
  assert.equal(errorCount, 1);
});

test('error diagnostics never leak raw content, and bound source_id/source_url length', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['title'],
  };
  const longId = 'x'.repeat(500);
  const urlWithSecrets = `https://user:pass@example.test/path?token=SECRET#frag-${'y'.repeat(600)}`;
  const items = [{ id: longId, link: urlWithSecrets }]; // title missing
  const { errors } = extractAll(items, localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(errors[0].source_id.length, 200);
  assert.ok(!errors[0].source_url.includes('user'));
  assert.ok(!errors[0].source_url.includes('pass'));
  assert.ok(!errors[0].source_url.includes('SECRET'));
  assert.ok(errors[0].source_url.length <= 500);
});

test('a false 0/whitespace control: zero is not a positive failure, whitespace-only is', () => {
  const localAdapter = {
    host: 'example.test',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' }, flag: { path: 'flag' } },
    required: ['title', 'flag'],
  };
  const zeroOk = extractAll(
    [{ id: 1, link: 'https://example.test/1', title: 'T', flag: false }],
    localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(zeroOk.errorCount, 0);
  const blankBad = extractAll(
    [{ id: 1, link: 'https://example.test/1', title: '   ', flag: false }],
    localAdapter, { fetchedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(blankBad.errorCount, 1);
  assert.deepEqual(blankBad.fieldFailures, { title: 1 });
});
