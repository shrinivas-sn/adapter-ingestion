import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { applyNormalizer } from '../src/normalize.mjs';
import { validateAdapter } from '../src/adapter.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';

// iso-datetime (since 0.7): keeps the time of day and returns UTC in one
// fixed shape. Formats below are taken from real sources (GitHub REST
// published_at, HN Algolia created_at, WordPress REST date_gmt), with
// invented values.
const CASES = [
  ['2026-10-16T21:15:03Z', '2026-10-16T21:15:03.000Z'],
  ['2026-10-19T15:23:15Z', '2026-10-19T15:23:15.000Z'],
  ['2026-10-19T20:53:15+05:30', '2026-10-19T15:23:15.000Z'],
  ['2026-10-19T01:00-05:00', '2026-10-19T06:00:00.000Z'],
  ['2026-10-19T23:30:00-01:00', '2026-10-20T00:30:00.000Z'],
  ['2026-12-31T23:30:00-01:00', '2027-01-01T00:30:00.000Z'],
  ['2026-10-19T15:23:15.123456789Z', '2026-10-19T15:23:15.123Z'],
  ['2026-10-19T15:23:15.9999Z', '2026-10-19T15:23:15.999Z'],
  ['2026-10-19T15:23:15.5Z', '2026-10-19T15:23:15.500Z'],
  ['  2026-10-19T15:23:15Z  ', '2026-10-19T15:23:15.000Z'],
  ['0050-06-01T12:00:00Z', '0050-06-01T12:00:00.000Z'],
  ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ['2026-10-06T17:00:00', null],
  ['2026-10-19', null],
  ['2025-02-29T00:00:00Z', null],
  ['2026-10-19T24:00:00Z', null],
  ['2026-10-19T23:59:60Z', null],
  ['2026-10-19T12:00:00+24:00', null],
  ['2026-10-19 15:23:15Z', null],
  ['2026-10-19T15:23:15+0530', null],
  ['0001-01-01T00:30:00+01:00', null],
  ['9999-12-31T23:30:00-01:00', null],
  [1792423395, null],
  ['', null],
  [null, null],
  [undefined, null],
];

test('iso-datetime: every spec case gives the spec output', () => {
  for (const [input, want] of CASES) {
    assert.equal(applyNormalizer('iso-datetime', input), want, `input ${JSON.stringify(input)}`);
  }
});

test('iso-datetime: assume_zone "Z" reads a zone-less time as UTC; an own zone wins', () => {
  const opts = { assume_zone: 'Z' };
  assert.equal(applyNormalizer('iso-datetime', '2026-10-06T17:00:00', opts), '2026-10-06T17:00:00.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-18T06:50', opts), '2026-10-18T06:50:00.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-19T20:53:15+05:30', opts), '2026-10-19T15:23:15.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-19', opts), null);
  assert.equal(applyNormalizer('iso-datetime', '2026-02-30T10:00:00', opts), null);
});

test('applyNormalizer: an assume_zone other than "Z" throws', () => {
  assert.throws(() => applyNormalizer('iso-datetime', 'x', { assume_zone: 'UTC' }), /assume_zone must be "Z"/);
  assert.throws(() => applyNormalizer('iso-datetime', 'x', { assume_zone: '+05:30' }), /assume_zone must be "Z"/);
});

test('applyNormalizer: other normalizers ignore options; iso-date is unchanged', () => {
  assert.equal(applyNormalizer('text', ' a ', { assume_zone: 'Z' }), 'a');
  assert.equal(applyNormalizer('iso-date', '2026-10-19T20:53:15+05:30'), '2026-10-19');
  assert.equal(applyNormalizer('iso-date', '2026-10-19T20:53:15+05:30', { assume_zone: 'Z' }), '2026-10-19');
});

test('iso-datetime: output does not depend on the machine time zone', () => {
  const moduleUrl = new URL('../src/normalize.mjs', import.meta.url).href;
  const inputs = JSON.stringify(CASES.map(([input]) => input ?? null));
  const script = `import(${JSON.stringify(moduleUrl)}).then(({ applyNormalizer }) => {
    const inputs = ${inputs};
    process.stdout.write(JSON.stringify(inputs.map((v) => applyNormalizer('iso-datetime', v))));
  });`;
  const want = CASES.map(([, out]) => out);
  for (const tz of ['America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), want, `TZ=${tz}`);
  }
});

// --- Adapters: validateAdapter and the schema ---

const schema = JSON.parse(await readFile(new URL('../schema/adapter.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

const withRule = (rule) => ({
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' }, published: rule },
});

const VALID_RULES = [
  { path: 'p', normalize: 'iso-datetime' },
  { path: 'p', normalize: 'iso-datetime', assume_zone: 'Z' },
];
const INVALID_RULES = [
  [{ path: 'p', normalize: 'iso-datetime', assume_zone: 'UTC' }, 'map.published.assume_zone must be "Z"'],
  [{ path: 'p', normalize: 'iso-date', assume_zone: 'Z' }, 'map.published.assume_zone needs "normalize": "iso-datetime"'],
  [{ path: 'p', assume_zone: 'Z' }, 'map.published.assume_zone needs "normalize": "iso-datetime"'],
  [{ path: 'p', normalize: 'iso-datetimes' }, 'map.published: unknown normalizer "iso-datetimes"'],
];

test('validateAdapter: iso-datetime and assume_zone "Z" are accepted', () => {
  for (const rule of VALID_RULES) {
    const result = validateAdapter(withRule(rule));
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  }
});

test('validateAdapter: a malformed assume_zone or normalizer is rejected with a clear message', () => {
  for (const [rule, message] of INVALID_RULES) {
    const result = validateAdapter(withRule(rule));
    assert.equal(result.ok, false, JSON.stringify(rule));
    assert.ok(result.errors.some((e) => e.includes(message)), `${JSON.stringify(rule)}: ${JSON.stringify(result.errors)}`);
  }
});

test('schema: agrees with validateAdapter on iso-datetime and assume_zone', () => {
  for (const rule of VALID_RULES) {
    assert.equal(validateSchema(withRule(rule)), true, JSON.stringify(validateSchema.errors));
  }
  for (const [rule] of INVALID_RULES) {
    assert.equal(validateSchema(withRule(rule)), false, JSON.stringify(rule));
  }
});

test('schema: the normalize enum lists exactly the normalizers validateAdapter accepts', () => {
  const names = [...schema.$defs.map_rule.properties.normalize.enum].sort();
  assert.deepEqual(names, ['bool', 'iso-date', 'iso-datetime', 'number', 'text']);
  for (const name of names) {
    assert.equal(validateAdapter(withRule({ path: 'p', normalize: name })).ok, true, name);
  }
});

// --- A real run: extraction passes the map rule, staleness accepts the output ---

const runAdapter = (atRule, canary = {}) => ({
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { method: 'GET', retry: { max_attempts: 1 } },
  records_path: '$',
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' }, at: atRule },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9, ...canary },
});
const item = (id, at) => ({ id, link: `https://example.test/${id}`, title: `Item ${id}`, at });
const respond = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

async function runOnce(t, adapter, items, now = new Date()) {
  const dir = await mkdtemp(join(tmpdir(), 'iso-datetime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
  const result = await runIngest({ adapter, paths, fetchImpl: respond(items), now });
  const stored = (await readRecords(paths.storeFile)).map((r) => r.fields.at);
  return { ...result, stored };
}

test('run: iso-datetime values are stored in UTC', async (t) => {
  const items = [item(1, '2026-10-19T15:23:15Z'), item(2, '2026-10-19T20:53:15+05:30')];
  const { stored } = await runOnce(t, runAdapter({ path: 'at', normalize: 'iso-datetime' }), items);
  assert.deepEqual(stored, ['2026-10-19T15:23:15.000Z', '2026-10-19T15:23:15.000Z']);
});

test('run: assume_zone reaches the normalizer; without it a zone-less time is null', async (t) => {
  const items = [item(1, '2026-10-06T17:00:00')];
  const withZone = await runOnce(t, runAdapter({ path: 'at', normalize: 'iso-datetime', assume_zone: 'Z' }), items);
  assert.deepEqual(withZone.stored, ['2026-10-06T17:00:00.000Z']);
  const without = await runOnce(t, runAdapter({ path: 'at', normalize: 'iso-datetime' }), items);
  assert.deepEqual(without.stored, [null]);
});

test('run: the staleness check accepts iso-datetime output', async (t) => {
  const now = new Date('2026-10-19T12:00:00Z');
  const adapter = runAdapter({ path: 'at', normalize: 'iso-datetime' }, { max_staleness_days: 1, staleness_field: 'at' });
  const fresh = await runOnce(t, adapter, [item(1, new Date(now.getTime() - 2 * 3600_000).toISOString())], now);
  assert.equal(fresh.canary.status, 'ok', JSON.stringify(fresh.canary));
  const old = await runOnce(t, adapter, [item(1, new Date(now.getTime() - 3 * 86400_000).toISOString())], now);
  assert.equal(old.canary.status, 'stale');
  assert.ok(old.canary.breaches.some((b) => b.startsWith('staleness:')), JSON.stringify(old.canary.breaches));
});

test('run: iso-date output is unchanged', async (t) => {
  const { stored } = await runOnce(t, runAdapter({ path: 'at', normalize: 'iso-date' }), [item(1, '2026-10-19T20:53:15+05:30')]);
  assert.deepEqual(stored, ['2026-10-19']);
});

// --- Review fixes: the public API keeps 0.6 behaviour for every other call ---

test('applyNormalizer: null options behave like no options', () => {
  assert.equal(applyNormalizer('iso-datetime', '2026-10-19T15:23:15Z', null), '2026-10-19T15:23:15.000Z');
  assert.equal(applyNormalizer('text', ' a ', null), 'a');
});

test('applyNormalizer: assume_zone is checked only for iso-datetime (other normalizers ignore it as in 0.6)', () => {
  assert.equal(applyNormalizer('text', ' a ', { assume_zone: 'UTC' }), 'a');
  assert.equal(applyNormalizer('iso-date', '2026-10-19', { assume_zone: 'UTC' }), '2026-10-19');
  assert.throws(() => applyNormalizer('iso-datetime', 'x', { assume_zone: 'UTC' }), /assume_zone must be "Z"/);
});
