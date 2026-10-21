// Editing a list here is an intentional public contract change: add a changeset and say so in the PR.
//
// These literals pin what consumers can see: every exported name per package subpath, every
// E_* error code, and the report/record keys. Refactors must leave all of them unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport } from '../src/report.mjs';
import { buildRecord } from '../src/contract.mjs';
import { validateAdapter } from '../src/adapter.mjs';

const ROOT = new URL('../', import.meta.url);

const EXPORTS = {
  '.': ['runIngest'],
  './adapter': ['validateAdapter', 'verifyAgainstFixtures'],
  './adapter.schema.json': 'json',
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
  'E_HEADER_ENV', 'E_HTTP_STATUS', 'E_KIND_DEPENDENCY', 'E_LOCK_RELEASE', 'E_OPTIONS', 'E_PAGE_LIMIT',
  'E_PAGINATION_REPEAT', 'E_PARSE', 'E_PARSE_NO_MATCH', 'E_RECORD_INVALID', 'E_RECORD_LIMIT',
  'E_REDIRECT', 'E_REPORT_READ', 'E_REPORT_WRITE', 'E_RESPONSE_JSON', 'E_RESPONSE_LIMIT',
  'E_RESPONSE_SHAPE', 'E_RETRY_DEFERRED', 'E_STORE_LINE_LIMIT', 'E_STORE_LOCKED',
  'E_STORE_READ', 'E_STORE_WRITE', 'E_TIMEOUT', 'E_TOTAL_BYTES_LIMIT',
];

const REPORT_KEYS = [
  'adapter_fingerprint', 'canary', 'duration_ms', 'error_count', 'errors', 'failure',
  'fatal_error', 'fetch', 'finished_at', 'host', 'mode', 'newest_staleness_value', 'notices', 'outcome',
  'report_version', 'run_id', 'secondary_errors', 'stages', 'started_at', 'storage',
  'warning_count', 'warnings',
];

// A_* advice and D_* deprecation notice codes (src/notices.mjs).
const NOTICE_CODES = ['A_CANARY_NO_HISTORY', 'A_TOP_LEVEL_KEY_TYPO'];

// W_* warning codes in report warnings[] (since 0.10 pinned and in the catalog).
const WARNING_CODES = ['W_HISTORY_CORRUPT_LINE', 'W_PAGE_LIMIT', 'W_STORE_CORRUPT_LINE', 'W_STORE_INVALID_RECORD'];

const RECORD_KEYS = ['content_hash', 'fetched_at', 'fields', 'id', 'raw', 'source_host', 'source_url'];

// Report string values consumers branch on (since 0.10 pinned). Scanned from src/, as the code lists are.
// `doctor` is only used inside doctor's message, never printed.
const FAILURE_STAGES = ['canary', 'doctor', 'extract', 'fetch', 'lock', 'lock_release', 'options', 'report', 'store', 'validate'];
const STORAGE_STATUSES = ['committed', 'not_started', 'uncertain', 'unchanged'];
const STOP_REASONS = ['empty_page', 'max_pages', 'short_page', 'single_page'];
const SKIP_REASONS = ['empty_batch', 'incremental_batch', 'no_history', 'not_configured'];

test('exports surface: every package subpath exposes exactly the frozen names', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));
  assert.deepEqual(Object.keys(pkg.exports).sort(), Object.keys(EXPORTS).sort());
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    // A JSON subpath is data, not a module: check it parses as the schema.
    if (EXPORTS[subpath] === 'json') {
      const json = JSON.parse(await readFile(new URL(target, ROOT), 'utf8'));
      assert.equal(json.$schema, 'https://json-schema.org/draft/2020-12/schema', `exports of "${subpath}"`);
      continue;
    }
    // A conditional target ({ types, default }) runs its `default` file.
    const mod = await import(new URL(typeof target === 'string' ? target : target.default, ROOT));
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

test('notice codes: the set of A_*/D_* codes in src/ is frozen', async () => {
  const srcDir = new URL('src/', ROOT);
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  const codes = new Set();
  for (const f of files) {
    const text = await readFile(new URL(f.replaceAll('\\', '/'), srcDir), 'utf8');
    for (const m of text.matchAll(/'([AD]_[A-Z_]+)'/g)) codes.add(m[1]);
  }
  assert.deepEqual([...codes].sort(), NOTICE_CODES);
});

test('warning codes: the set of W_* codes in src/ is frozen', async () => {
  const srcDir = new URL('src/', ROOT);
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  const codes = new Set();
  for (const f of files) {
    const text = await readFile(new URL(f.replaceAll('\\', '/'), srcDir), 'utf8');
    for (const m of text.matchAll(/'(W_[A-Z_]+)'/g)) codes.add(m[1]);
  }
  assert.deepEqual([...codes].sort(), WARNING_CODES);
});

test('report value sets: stages, storage statuses, stop reasons and skip reasons are frozen', async () => {
  const srcDir = new URL('src/', ROOT);
  const files = (await readdir(srcDir, { recursive: true })).filter((f) => f.endsWith('.mjs'));
  const stages = new Set();
  const statuses = new Set();
  const stopReasons = new Set();
  const skipReasons = new Set();
  for (const f of files) {
    const name = f.replaceAll('\\', '/');
    const text = await readFile(new URL(name, srcDir), 'utf8');
    for (const m of text.matchAll(/ctx\.stage = '([a-z_]+)'|safeFailure\([^,]+, '([a-z_]+)'\)/g)) stages.add(m[1] ?? m[2]);
    for (const m of text.matchAll(/storage:? =? ?\{ status: '([a-z_]+)'/g)) statuses.add(m[1]);
    if (name === 'fetch.mjs') {
      for (const m of text.matchAll(/stopReason = (?:hasPagination \? null : )?'([a-z_]+)'/g)) stopReasons.add(m[1]);
    }
    if (name === 'canary.mjs') {
      for (const m of text.matchAll(/reason: '([a-z_]+)'/g)) skipReasons.add(m[1]);
    }
  }
  assert.deepEqual([...stages].sort(), FAILURE_STAGES);
  assert.deepEqual([...statuses].sort(), STORAGE_STATUSES);
  assert.deepEqual([...stopReasons].sort(), STOP_REASONS);
  assert.deepEqual([...skipReasons].sort(), SKIP_REASONS);
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

test('code catalog covers exactly the frozen codes', async () => {
  const { CODES } = await import(new URL('src/codes.mjs', ROOT));
  assert.deepEqual(Object.keys(CODES).sort(), [...ERROR_CODES, ...NOTICE_CODES, ...WARNING_CODES].sort());
  for (const [code, entry] of Object.entries(CODES)) {
    for (const field of ['kind', 'meaning', 'cause', 'fix']) {
      assert.ok(typeof entry[field] === 'string' && entry[field].length > 0, `${code}.${field}`);
    }
  }
});

// The CLI surface (src/cli.mjs, package.json "bin"): command names and the
// top-level keys of each command's --json object. Exit codes and the run/
// doctor key lists are asserted literally in test/cli-bin.test.mjs.
const CLI_COMMANDS = ['doctor', 'explain', 'run', 'validate'];
const CLI_JSON_KEYS = {
  validate: ['ok', 'errors'],
  explain: ['code', 'kind', 'meaning', 'cause', 'fix'],
  run: ['outcome', 'stages', 'canary', 'notices', 'failure'],
  doctor: ['ok', 'errors', 'notices', 'environment'],
  error: ['error'],
};

test('cli surface: bin name, command list and --json keys are frozen', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8'));
  assert.deepEqual(pkg.bin, { 'adapter-ingestion': './src/cli.mjs' });
  const { runBin, VALID_ADAPTER } = await import('./helpers/bin.mjs');
  const help = await runBin(['--help']);
  const listed = [...help.stdout.matchAll(/^ {2}([a-z]+) /gm)].map((m) => m[1]).sort();
  assert.deepEqual(listed, CLI_COMMANDS);

  const dir = await mkdtemp(join(tmpdir(), 'freeze-cli-'));
  try {
    await writeFile(join(dir, 'a.json'), JSON.stringify(VALID_ADAPTER));
    const keysOf = async (args) => Object.keys(JSON.parse((await runBin(args, { cwd: dir })).stdout));
    assert.deepEqual(await keysOf(['validate', 'a.json', '--json']), CLI_JSON_KEYS.validate);
    assert.deepEqual(await keysOf(['explain', 'E_FETCH', '--json']), CLI_JSON_KEYS.explain);
    assert.deepEqual(await keysOf(['doctor', 'a.json', '--json']), CLI_JSON_KEYS.doctor);
    assert.deepEqual(await keysOf(['run', 'a.json', '--store', 'x', '--history', 'x', '--json']), CLI_JSON_KEYS.error);
    // run's success keys need a live source: test/cli-bin.test.mjs checks them against CLI_JSON_KEYS.run's literal.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
