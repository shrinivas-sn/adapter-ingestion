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

test('access.url must be http or https', () => {
  const bad = { ...base, access: { ...base.access, url: 'file:///etc/passwd' } };
  assert.match(validateAdapter(bad).errors.join(' '), /http/);
});

test('access.url hostname must match adapter.host — provenance would otherwise lie', () => {
  const bad = { ...base, access: { ...base.access, url: 'https://attacker.test/api' } };
  assert.match(validateAdapter(bad).errors.join(' '), /hostname must equal/);
});

test('a subdomain of adapter.host is allowed', () => {
  const ok = { ...base, host: 'example.test', access: { ...base.access, url: 'https://api.example.test/v1' } };
  assert.equal(validateAdapter(ok).ok, true);
});

test('host must be a bare hostname, not a path-traversal string', () => {
  const bad = { ...base, host: '../../../../tmp/pwned' };
  assert.match(validateAdapter(bad).errors.join(' '), /bare hostname/);
});

test('canary.max_staleness_days requires staleness_field, and vice versa', () => {
  const onlyMax = { ...base, canary: { max_staleness_days: 7 } };
  assert.match(validateAdapter(onlyMax).errors.join(' '), /must both be set or both omitted/);

  const onlyField = { ...base, canary: { staleness_field: 'title' } };
  assert.match(validateAdapter(onlyField).errors.join(' '), /must both be set or both omitted/);

  const both = { ...base, canary: { max_staleness_days: 7, staleness_field: 'title' } };
  assert.equal(validateAdapter(both).ok, true);
});

test('canary.staleness_field must name a real mapped field', () => {
  const bad = { ...base, canary: { max_staleness_days: 7, staleness_field: 'ghost_field' } };
  assert.match(validateAdapter(bad).errors.join(' '), /must name a field in map/);
});

test('an unknown canary key is caught at validation, not silently ignored', () => {
  const bad = { ...base, canary: { min_recods: 5 } };
  assert.match(validateAdapter(bad).errors.join(' '), /unknown key/);
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
