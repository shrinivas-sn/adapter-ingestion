import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, extractAll } from '../src/extract.mjs';

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
