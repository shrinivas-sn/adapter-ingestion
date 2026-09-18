import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter, verifyAgainstFixtures } from '../src/adapter.mjs';
import { validateFetchConfig } from '../src/config.mjs';

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

// --- V01/V02: malformed input never throws an incidental TypeError, it just fails ---

test('malformed top-level adapter input returns validation errors without throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, [], () => {}]) {
    assert.doesNotThrow(() => validateAdapter(bad));
    assert.equal(validateAdapter(bad).ok, false);
  }
});

test('a string instead of a map object is rejected, not iterated', () => {
  assert.doesNotThrow(() => validateAdapter({ ...base, map: 'not-an-object' }));
  assert.equal(validateAdapter({ ...base, map: 'not-an-object' }).ok, false);
});

test('null map rules do not throw when read', () => {
  const bad = { ...base, map: { ...base.map, title: null } };
  assert.doesNotThrow(() => validateAdapter(bad));
  assert.equal(validateAdapter(bad).ok, false);
});

test('required as a string instead of an array is rejected', () => {
  assert.equal(validateAdapter({ ...base, required: 'title' }).ok, false);
});

test('required rejects duplicate field names', () => {
  const bad = { ...base, required: ['title', 'title'] };
  assert.match(validateAdapter(bad).errors.join(' '), /duplicate/);
});

test('unknown access.kind is rejected — feed/html/browser are excluded this release', () => {
  for (const kind of ['feed', 'html', 'browser', 'graphql']) {
    const bad = { ...base, access: { ...base.access, kind } };
    assert.equal(validateAdapter(bad).ok, false);
  }
});

test('fetch.method other than GET is rejected', () => {
  const bad = { ...base, fetch: { ...base.fetch, method: 'POST' } };
  assert.match(validateAdapter(bad).errors.join(' '), /GET/);
});

test('zero, negative, NaN, and Infinity limits are rejected', () => {
  for (const max_records of [0, -1, NaN, Infinity]) {
    const bad = { ...base, fetch: { ...base.fetch, max_records } };
    assert.equal(validateAdapter(bad).ok, false, `max_records ${max_records} should be rejected`);
  }
  for (const timeout_ms of [0, -1, NaN, Infinity, 1.5]) {
    const bad = { ...base, fetch: { ...base.fetch, timeout_ms } };
    assert.equal(validateAdapter(bad).ok, false, `timeout_ms ${timeout_ms} should be rejected`);
  }
});

test('invalid canary ratios outside 0-1 are rejected', () => {
  for (const count_drop_ratio of [-0.1, 1.1, NaN, Infinity]) {
    const bad = { ...base, canary: { count_drop_ratio } };
    assert.equal(validateAdapter(bad).ok, false, `count_drop_ratio ${count_drop_ratio} should be rejected`);
  }
});

test('an unknown pagination style is rejected', () => {
  const bad = { ...base, fetch: { ...base.fetch, pagination: { style: 'cursor', param: 'page' } } };
  assert.match(validateAdapter(bad).errors.join(' '), /style/);
});

test('a negative or non-integer max_pages is rejected', () => {
  for (const max_pages of [-1, 0, 1.5]) {
    const bad = { ...base, fetch: { ...base.fetch, pagination: { style: 'page-param', param: 'page', max_pages } } };
    assert.equal(validateAdapter(bad).ok, false, `max_pages ${max_pages} should be rejected`);
  }
});

test('a retry.max_delay_ms below backoff_ms is rejected', () => {
  const bad = { ...base, fetch: { ...base.fetch, retry: { backoff_ms: 5000, max_delay_ms: 1000 } } };
  assert.match(validateAdapter(bad).errors.join(' '), />=/);
});

test('unsafe Windows host basenames are rejected even with an extension-like dot', () => {
  for (const host of ['CON', 'con', 'NUL.example.com', 'COM1', 'lpt9']) {
    const bad = { ...base, host, access: { ...base.access, url: `https://${host}/api` } };
    assert.equal(validateAdapter(bad).ok, false, `host ${host} should be rejected`);
  }
});

test('an invalid header value type is rejected', () => {
  const bad = { ...base, fetch: { ...base.fetch, headers: { 'X-Test': 123 } } };
  assert.equal(validateAdapter(bad).ok, false);
});

test('a colliding incremental param and pagination param is rejected', () => {
  const bad = {
    ...base,
    fetch: {
      ...base.fetch,
      pagination: { style: 'page-param', param: 'page' },
      incremental: { param: 'page', type: 'iso-date' },
    },
  };
  assert.match(validateAdapter(bad).errors.join(' '), /collide/);
});

// --- V04: reserved names in map field names / path segments ---

test('a map field name of __proto__ is rejected without mutating Object.prototype', () => {
  // Built via one JSON.parse call so __proto__ becomes a genuine own data
  // property, not the prototype-changing object-literal special case.
  const mapWithProto = JSON.parse(
    '{"source_id":{"path":"id"},"url":{"path":"link"},"title":{"path":"title"},"__proto__":{"path":"evil"}}');
  assert.equal(Object.getPrototypeOf(mapWithProto), Object.prototype);
  const bad = { ...base, map: mapWithProto };
  const result = validateAdapter(bad);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /__proto__/);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('a map rule path containing __proto__ or constructor is rejected', () => {
  const bad1 = { ...base, map: { ...base.map, title: { path: '__proto__.polluted' } } };
  assert.match(validateAdapter(bad1).errors.join(' '), /__proto__/);
  const bad2 = { ...base, map: { ...base.map, title: { path: 'constructor.prototype' } } };
  assert.match(validateAdapter(bad2).errors.join(' '), /constructor/);
});

// --- validateFetchConfig: usable without a map or access.tier ---

test('validateFetchConfig accepts an adapter with no map and no access.tier', () => {
  const minimal = { access: { kind: 'json-api', url: 'https://example.test/api' } };
  assert.equal(validateFetchConfig(minimal).ok, true);
});

test('validateFetchConfig rejects an invalid since without requiring a map', () => {
  const minimal = { access: { kind: 'json-api', url: 'https://example.test/api' } };
  const r = validateFetchConfig(minimal, { since: '2026-02-31' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /since/);
});

test('validateFetchConfig requires fetch.incremental when since is supplied', () => {
  const minimal = { access: { kind: 'json-api', url: 'https://example.test/api' } };
  const r = validateFetchConfig(minimal, { since: '2026-01-01' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /incremental/);
});

test('validateFetchConfig accepts a valid since with matching fetch.incremental', () => {
  const withIncremental = {
    access: { kind: 'json-api', url: 'https://example.test/api' },
    fetch: { incremental: { param: 'modified_after', type: 'iso-date' } },
  };
  assert.equal(validateFetchConfig(withIncremental, { since: '2026-01-01' }).ok, true);
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
