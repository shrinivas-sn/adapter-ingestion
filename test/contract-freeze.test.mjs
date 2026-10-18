// Editing a list here is an intentional public contract change: add a changeset and say so in the PR.
//
// These literals pin what consumers can see: every exported name per package subpath, every
// E_* error code, and the report/record keys. Refactors must leave all of them unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport } from '../src/report.mjs';
import { buildRecord } from '../src/contract.mjs';
import { validateAdapter } from '../src/adapter.mjs';

const ROOT = new URL('../', import.meta.url);

const EXPORTS = {
  '.': ['runIngest'],
  './adapter': ['validateAdapter', 'verifyAgainstFixtures'],
  './canary': ['checkCanary'],
  './contract': ['assertNoUndefined', 'buildRecord', 'canonicalize', 'contentHash', 'isValidSourceId', 'isValidSourceUrl'],
  './dedupe': ['splitByIndex'],
  './extract': ['extractAll', 'getPath'],
  './fetch': ['buildUrl', 'fetchAll'],
  './filter': ['applyFilter', 'evaluateRule', 'validateFilter'],
  './normalize': ['applyNormalizer', 'isValidDateOnly'],
  './report': ['buildReport', 'readEligibleHistory', 'readHistory', 'writeReport'],
  './store': ['appendRecords', 'iterateRecords', 'readIndex', 'readLatestRecords', 'readRecords', 'withStoreLock'],
};

const ERROR_CODES = [
  'E_ABORTED', 'E_ADAPTER_INVALID', 'E_FETCH', 'E_FETCH_DEADLINE', 'E_FILTER_INVALID',
  'E_HTTP_STATUS', 'E_KIND_DEPENDENCY', 'E_LOCK_RELEASE', 'E_OPTIONS', 'E_PAGE_LIMIT', 'E_PAGINATION_REPEAT', 'E_PARSE',
  'E_RECORD_INVALID', 'E_RECORD_LIMIT', 'E_REDIRECT', 'E_REPORT_READ', 'E_REPORT_WRITE',
  'E_RESPONSE_JSON', 'E_RESPONSE_LIMIT', 'E_RESPONSE_SHAPE', 'E_RETRY_DEFERRED',
  'E_STORE_LINE_LIMIT', 'E_STORE_LOCKED', 'E_STORE_READ', 'E_STORE_WRITE', 'E_TIMEOUT',
  'E_TOTAL_BYTES_LIMIT',
];

const REPORT_KEYS = [
  'adapter_fingerprint', 'canary', 'duration_ms', 'error_count', 'errors', 'failure',
  'fatal_error', 'fetch', 'finished_at', 'host', 'mode', 'newest_staleness_value', 'outcome',
  'report_version', 'run_id', 'secondary_errors', 'stages', 'started_at', 'storage',
  'warning_count', 'warnings',
];

const RECORD_KEYS = ['content_hash', 'fetched_at', 'fields', 'id', 'raw', 'source_host', 'source_url'];

test('exports surface: every package subpath exposes exactly the frozen names', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));
  assert.deepEqual(Object.keys(pkg.exports).sort(), Object.keys(EXPORTS).sort());
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    const mod = await import(new URL(target, ROOT));
    assert.deepEqual(Object.keys(mod).sort(), EXPORTS[subpath], `exports of "${subpath}"`);
  }
});

test('error codes: the set of E_* codes in src/ is frozen', async () => {
  const srcDir = new URL('src/', ROOT);
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  const codes = new Set();
  for (const f of files) {
    const text = await readFile(new URL(f.replaceAll('\\', '/'), srcDir), 'utf8');
    for (const m of text.matchAll(/'(E_[A-Z_]+)'/g)) codes.add(m[1]);
  }
  assert.deepEqual([...codes].sort(), ERROR_CODES);
});

test('report v2 keys: buildReport top-level keys are frozen', () => {
  const report = buildReport({});
  assert.equal(report.report_version, 2);
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS);
});

test('record keys: buildRecord keys are frozen', () => {
  const record = buildRecord({
    host: 'example.test', sourceId: 'a', sourceUrl: 'https://example.test/a',
    fields: { title: 'x' }, raw: {}, fetchedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS);
});

test('repo adapters stay valid', async () => {
  const dir = new URL('adapters/', ROOT);
  // example.adapter.json is a template full of <PLACEHOLDER> values, never a runnable adapter.
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.adapter.json') && f !== 'example.adapter.json');
  assert.ok(files.length > 0);
  for (const f of files) {
    const adapter = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    const result = validateAdapter(adapter);
    assert.equal(result.ok, true, `${f}: ${JSON.stringify(result.errors)}`);
  }
});
