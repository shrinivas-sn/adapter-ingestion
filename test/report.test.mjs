import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, writeReport, readHistory, readEligibleHistory } from '../src/report.mjs';

test('a report captures every stage count and round-trips through history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  const r = buildReport({
    host: 'example.test', startedAt: '2026-01-10T00:00:00.000Z',
    finishedAt: '2026-01-10T00:00:05.000Z',
    stages: { fetched: 10, parsed: 9, fresh: 4, changed: 1, unchanged: 4 },
    errors: [{ index: 3, missing: ['title'] }],
  });
  assert.equal(r.stages.parsed, 9);
  assert.equal(r.duration_ms, 5000);
  await writeReport(dir, r);
  const hist = await readHistory(dir, 5);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].host, 'example.test');
  await rm(dir, { recursive: true, force: true });
});

test('buildReport gives report_version 2, a real run_id, and section-6.1 defaults for a minimal caller', () => {
  const r = buildReport({
    host: 'example.test', startedAt: '2026-01-10T00:00:00.000Z', finishedAt: '2026-01-10T00:00:01.000Z',
    stages: { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0 },
  });
  assert.equal(r.report_version, 2);
  assert.match(r.run_id, /^[0-9a-f-]{36}$/);
  assert.equal(r.mode, 'snapshot');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.adapter_fingerprint, null);
  assert.equal(r.fatal_error, null);
  assert.equal(r.failure, null);
  assert.deepEqual(r.secondary_errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.warning_count, 0);
  assert.deepEqual(r.canary, { status: 'not_evaluated', breaches: [], skipped: [] });
  assert.deepEqual(r.fetch, { pages: 0, attempts: 0, retries: 0, statuses: [], status_count: 0, bytes: 0, complete: false, stop_reason: null });
  assert.deepEqual(r.storage, { status: 'not_started', written: 0 });
});

test('fatal_error mirrors failure.message by default, but an explicit fatalError still overrides it', () => {
  const withFailure = buildReport({
    startedAt: '2026-01-10T00:00:00.000Z', finishedAt: '2026-01-10T00:00:01.000Z', stages: {},
    failure: { code: 'E_FETCH', message: 'an unexpected error occurred', stage: 'fetch' },
  });
  assert.equal(withFailure.fatal_error, 'an unexpected error occurred');

  const overridden = buildReport({
    startedAt: '2026-01-10T00:00:00.000Z', finishedAt: '2026-01-10T00:00:01.000Z', stages: {},
    failure: { code: 'E_FETCH', message: 'safe message', stage: 'fetch' },
    fatalError: 'a different legacy string',
  });
  assert.equal(overridden.fatal_error, 'a different legacy string');
});

// --- O02: unique filenames, atomic publish, malformed/temp history handling ---

test('two reports with the exact same started_at get distinct files, not one overwriting the other', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fields = { host: 'h', startedAt: '2026-01-10T00:00:00.000Z', finishedAt: '2026-01-10T00:00:01.000Z', stages: {} };
  await writeReport(dir, buildReport(fields));
  await writeReport(dir, buildReport(fields));
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json'));
  assert.equal(names.length, 2, 'distinct run_ids must produce two distinct files for the identical started_at');
  const hist = await readHistory(dir, 5);
  assert.equal(hist.length, 2);
});

test('a crash-left temporary sibling and a malformed JSON report are both ignored by history reads', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const good = buildReport({ host: 'h', startedAt: '2026-01-10T00:00:00.000Z', finishedAt: '2026-01-10T00:00:01.000Z', stages: {} });
  await writeReport(dir, good);
  // A leftover exclusive-temp sibling from a crash mid-publish (never renamed).
  await writeFile(join(dir, 'report-2026-01-11T00-00-00-000Z-deadbeef.json.abc123.tmp'), '{"started_at":"2026-01-11T00:00:00.000Z","stages":{}}');
  // A report-named file with genuinely malformed content.
  await writeFile(join(dir, 'report-2026-01-12T00-00-00-000Z-c0ffee.json'), '{not valid json');

  const hist = await readHistory(dir, 10);
  assert.equal(hist.length, 1, 'only the one well-formed report counts');
  assert.equal(hist[0].run_id, good.run_id);
});

test('a JSON file that does not look like a report (missing started_at/stages) is skipped, not treated as history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'report-2026-01-10T00-00-00-000Z-x.json'), JSON.stringify([1, 2, 3]));
  await writeFile(join(dir, 'report-2026-01-11T00-00-00-000Z-y.json'), JSON.stringify({ hello: 'world' }));
  const hist = await readHistory(dir, 10);
  assert.equal(hist.length, 0);
});

test('a genuine report-read failure (not ENOENT) surfaces as E_REPORT_READ, not an empty history', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A regular file standing where the reports directory should be makes
  // readdir() fail with a real, non-ENOENT error (ENOTDIR) -- portable,
  // no ACL changes needed.
  const blockerPath = join(dir, 'blocked-runs-dir');
  await writeFile(blockerPath, 'not a directory');
  await assert.rejects(() => readHistory(blockerPath, 5), (err) => err.code === 'E_REPORT_READ');
});

// --- eligible-history scanning: many ineligible reports must not starve out older eligible ones ---

test('readEligibleHistory finds enough eligible reports even behind many recent ineligible ones', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'runs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 5 older eligible ('ok') reports, then 20 newer ineligible ('stale') ones.
  for (let i = 0; i < 5; i++) {
    await writeReport(dir, buildReport({
      host: 'h', startedAt: `2026-01-0${i + 1}T00:00:00.000Z`, finishedAt: `2026-01-0${i + 1}T00:00:01.000Z`,
      stages: { parsed: 100 }, outcome: 'ok',
    }));
  }
  for (let i = 0; i < 20; i++) {
    await writeReport(dir, buildReport({
      host: 'h', startedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      finishedAt: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:01.000Z`,
      stages: { parsed: 1 }, outcome: 'stale',
    }));
  }

  const eligible = await readEligibleHistory(dir, 5, (r) => r.outcome === 'ok');
  assert.equal(eligible.length, 5, 'all 5 older eligible reports must be found, not starved out by the 20 newer ineligible ones');
  assert.ok(eligible.every((r) => r.outcome === 'ok'));
});
