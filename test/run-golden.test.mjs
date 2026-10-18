// Characterization tests: pin runIngest's exact report for each main exit
// path, so a refactor (C2b) can be proved to change nothing a consumer sees.
// Only run_id, finished_at, duration_ms and the temp directory are masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { runIngest } from '../src/run.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { retry: { max_attempts: 1 } },
  records_path: '$',
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9 },
};

const itemsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, link: `https://example.test/${i + 1}`, title: `T${i + 1}` }));
const jsonImpl = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const at = (s) => new Date(`2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`);

async function tmpPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'golden-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') } };
}

function mask(report, dir) {
  const text = JSON.stringify(report).split(JSON.stringify(dir).slice(1, -1)).join('<DIR>');
  return { ...JSON.parse(text), run_id: '<RUN_ID>', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>' };
}

async function failingRun(args) {
  try {
    await runIngest(args);
  } catch (err) {
    return err;
  }
  assert.fail('expected runIngest to throw');
}


test('golden: ok snapshot run', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  const { report, canary } = await runIngest({ adapter, paths, fetchImpl: jsonImpl(itemsOf(2)), now: at(0) });
  assert.deepEqual(canary, report.canary);
  assert.deepEqual(mask(report, dir), {
    report_version: 2, run_id: '<RUN_ID>', adapter_fingerprint: report.adapter_fingerprint,
    mode: 'snapshot', outcome: 'ok', host: 'example.test',
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>',
    stages: { fetched: 2, parsed: 2, fresh: 2, changed: 0, unchanged: 0, written: 2 },
    error_count: 0, errors: [], fatal_error: null, failure: null, secondary_errors: [],
    warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'ok', breaches: [], skipped: [{ check: 'count_drop_ratio', reason: 'no_history' }, { check: 'staleness', reason: 'not_configured' }] },
    fetch: { pages: 1, attempts: 1, retries: 0, statuses: [200], status_count: 1, bytes: report.fetch.bytes, complete: true, stop_reason: 'single_page' },
    storage: { status: 'committed', written: 2 },
  });
  assert.match(report.adapter_fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(report.fetch.bytes > 0);
});

test('golden: stale run via count_drop_ratio against eligible history', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  for (let s = 0; s < 3; s++) {
    await runIngest({ adapter, paths, fetchImpl: jsonImpl(itemsOf(10)), now: at(s) });
  }
  const { report } = await runIngest({ adapter, paths, fetchImpl: jsonImpl(itemsOf(2)), now: at(10) });
  assert.deepEqual(mask(report, dir), {
    report_version: 2, run_id: '<RUN_ID>', adapter_fingerprint: report.adapter_fingerprint,
    mode: 'snapshot', outcome: 'stale', host: 'example.test',
    started_at: '2026-01-01T00:00:10.000Z', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>',
    stages: { fetched: 2, parsed: 2, fresh: 0, changed: 0, unchanged: 2, written: 0 },
    error_count: 0, errors: [], fatal_error: null, failure: null, secondary_errors: [],
    warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'stale', breaches: ['count_drop_ratio: parsed 2 vs trailing median 10'], skipped: [{ check: 'staleness', reason: 'not_configured' }] },
    fetch: { pages: 1, attempts: 1, retries: 0, statuses: [200], status_count: 1, bytes: report.fetch.bytes, complete: true, stop_reason: 'single_page' },
    storage: { status: 'unchanged', written: 0 },
  });
});

test('golden: invalid adapter', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  const err = await failingRun({ adapter: { ...adapter, version: 2 }, paths, fetchImpl: jsonImpl([]), now: at(0) });
  assert.equal(err.code, 'E_ADAPTER_INVALID');
  assert.deepEqual(mask(err.report, dir), {
    report_version: 2, run_id: '<RUN_ID>', adapter_fingerprint: null,
    mode: 'snapshot', outcome: 'error', host: 'example.test',
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>',
    stages: { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0, written: 0 },
    error_count: 0, errors: [], fatal_error: 'invalid adapter: version must be 1',
    failure: { code: 'E_ADAPTER_INVALID', message: 'invalid adapter: version must be 1', stage: 'validate' },
    secondary_errors: [], warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'not_evaluated', breaches: [], skipped: [] },
    fetch: { pages: 0, attempts: 0, retries: 0, statuses: [], status_count: 0, bytes: 0, complete: false, stop_reason: null },
    storage: { status: 'not_started', written: 0 },
  });
});

test('golden: HTTP 500 fails the fetch stage', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  const err = await failingRun({ adapter, paths, fetchImpl: jsonImpl({ error: 'x' }, 500), now: at(0) });
  assert.equal(err.code, 'E_HTTP_STATUS');
  assert.deepEqual(mask(err.report, dir), {
    report_version: 2, run_id: '<RUN_ID>', adapter_fingerprint: err.report.adapter_fingerprint,
    mode: 'snapshot', outcome: 'error', host: 'example.test',
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>',
    stages: { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0, written: 0 },
    error_count: 0, errors: [], fatal_error: 'unexpected HTTP status 500',
    failure: {
      code: 'E_HTTP_STATUS', message: 'unexpected HTTP status 500', stage: 'fetch',
      details: { fetch: { origin: 'https://example.test', page: 1, pages: 0, statuses: [500], status: 500 } },
    },
    secondary_errors: [], warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'not_evaluated', breaches: [], skipped: [] },
    fetch: { pages: 0, attempts: 0, retries: 0, statuses: [], status_count: 0, bytes: 0, complete: false, stop_reason: null },
    storage: { status: 'not_started', written: 0 },
  });
});

test('golden: store already locked', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  await writeFile(paths.storeFile + '.lock', JSON.stringify({ version: 1, run_id: 'someone-else' }));
  const err = await failingRun({ adapter, paths, fetchImpl: jsonImpl(itemsOf(2)), now: at(0) });
  assert.equal(err.code, 'E_STORE_LOCKED');
  assert.deepEqual(mask(err.report, dir), {
    report_version: 2, run_id: '<RUN_ID>', adapter_fingerprint: err.report.adapter_fingerprint,
    mode: 'snapshot', outcome: 'error', host: 'example.test',
    started_at: '2026-01-01T00:00:00.000Z', finished_at: '<FINISHED_AT>', duration_ms: '<DURATION>',
    stages: { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0, written: 0 },
    error_count: 0, errors: [], fatal_error: `store is already locked: <DIR>${sep}store.jsonl.lock`,
    failure: { code: 'E_STORE_LOCKED', message: `store is already locked: <DIR>${sep}store.jsonl.lock`, stage: 'lock' },
    secondary_errors: [], warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'not_evaluated', breaches: [], skipped: [] },
    fetch: { pages: 0, attempts: 0, retries: 0, statuses: [], status_count: 0, bytes: 0, complete: false, stop_reason: null },
    storage: { status: 'not_started', written: 0 },
  });
});
