import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter, verifyAgainstFixtures } from '../src/adapter.mjs';

const base = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { method: 'GET', headers: {} },
  records_path: '$',
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
  required: ['source_id', 'url', 'title'],
};

test('a well-formed adapter validates', () => {
  assert.equal(validateAdapter(base).ok, true);
});

test('a required field with no map entry is an error', () => {
  const bad = { ...base, required: ['source_id', 'url', 'title', 'ghost'] };
  assert.match(validateAdapter(bad).errors.join(' '), /ghost/);
});

test('source_id and url are mandatory map keys', () => {
  const { url, ...map } = base.map;
  assert.match(validateAdapter({ ...base, map }).errors.join(' '), /url/);
});

test('an unknown normalizer name is caught at validation, not at run time', () => {
  const bad = { ...base, map: { ...base.map, title: { path: 'title', normalize: 'nope' } } };
  assert.match(validateAdapter(bad).errors.join(' '), /normalizer/i);
});

test('verifyAgainstFixtures reports the parse ratio and the failing fields', () => {
  const items = [
    { id: 1, link: 'https://example.test/1', title: 'A' },
    { id: 2, link: 'https://example.test/2', title: '' },
  ];
  const r = verifyAgainstFixtures(base, items);
  assert.equal(r.total, 2);
  assert.equal(r.parsed, 1);
  assert.equal(r.ratio, 0.5);
  assert.deepEqual(r.fieldFailures, { title: 1 });
});
