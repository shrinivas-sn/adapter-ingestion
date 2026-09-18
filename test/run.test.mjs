import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../src/run.mjs';
import { readRecords, readLatestRecords } from '../src/store.mjs';
import { readHistory, writeReport } from '../src/report.mjs';
import { getPath } from '../src/extract.mjs';
import { loadAdapterFixture, newestStalenessInstant } from './helpers/fixtures.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { method: 'GET', headers: { 'User-Agent': '<UA>' },
           pagination: { style: 'page-param', param: 'page', per_page_param: 'per_page', per_page: 10, max_pages: 1,
             allow_truncation: true },
           // None of these tests are about retry behavior; a connection
           // failure is retryable by default (Task 6), which would
           // otherwise make the thrown-fetchImpl test below slow and retry
           // pointlessly against an implementation that always fails.
           retry: { max_attempts: 1 } },
  records_path: '$',
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9 },
};
const items = [
  { id: 1, link: 'https://example.test/1', title: 'One' },
  { id: 2, link: 'https://example.test/2', title: 'Two' },
];
const impl = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

async function tmpPaths() {
  const dir = await mkdtemp(join(tmpdir(), 'run-'));
  return { dir, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') } };
}

test('a first run stores every record and reports ok', async () => {
  const { dir, paths } = await tmpPaths();
  const { report, canary } = await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date() });
  assert.equal(report.stages.fetched, 2);
  assert.equal(report.stages.fresh, 2);
  assert.equal(canary.status, 'ok');
  assert.equal((await readRecords(paths.storeFile)).length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('a second identical run adds nothing new', async () => {
  const { dir, paths } = await tmpPaths();
  await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date() });
  const { report } = await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date() });
  assert.equal(report.stages.fresh, 0);
  assert.equal(report.stages.unchanged, 2);
  assert.equal((await readRecords(paths.storeFile)).length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('an invalid adapter is rejected before any fetch happens', async () => {
  const { dir, paths } = await tmpPaths();
  let called = false;
  const spy = async () => { called = true; return { ok: true, status: 200, json: async () => [] }; };
  await assert.rejects(() => runIngest({ adapter: { ...adapter, map: { source_id: { path: 'id' } } }, paths, fetchImpl: spy }));
  assert.equal(called, false);
  await rm(dir, { recursive: true, force: true });
});

test('a renamed source field surfaces as a stale canary, not a silent success', async () => {
  const { dir, paths } = await tmpPaths();
  const renamed = items.map(({ title, ...rest }) => ({ ...rest, heading: title }));
  const { report, canary } = await runIngest({ adapter, paths, fetchImpl: impl(renamed), now: new Date() });
  assert.equal(report.stages.parsed, 0);
  assert.equal(canary.status, 'stale');
  await rm(dir, { recursive: true, force: true });
});

test('error_count reflects the true rejected-record total through the full run, not just the capped sample', async () => {
  const { dir, paths } = await tmpPaths();
  // 25 records missing the required `title` field -- all rejected.
  const bad = Array.from({ length: 25 }, (_, i) => ({ id: i, link: `https://example.test/${i}` }));
  const { report } = await runIngest({ adapter, paths, fetchImpl: impl(bad), now: new Date() });
  assert.equal(report.error_count, 25, 'error_count must be the true total, not the capped sample length');
  assert.equal(report.errors.length, 20, 'the persisted sample stays capped at 20');
  await rm(dir, { recursive: true, force: true });
});

test('a run that throws still writes a report naming the failure, then rethrows', async () => {
  const { dir, paths } = await tmpPaths();
  const boom = async () => { throw new Error('DNS lookup failed'); };
  await assert.rejects(
    () => runIngest({ adapter, paths, fetchImpl: boom, now: new Date() }),
    /DNS lookup failed/,
  );
  const history = await readHistory(paths.runsDir, 5);
  assert.equal(history.length, 1, 'a report artifact must exist even though the run threw');
  // The persisted report is the *safe* projection (section 4.5) -- E_FETCH's
  // message is always replaced since it can embed arbitrary text from an
  // injected fetchImpl, so the raw "DNS lookup failed" must never land on
  // disk even though it's still visible on the in-memory thrown error above.
  assert.equal(history[0].outcome, 'error');
  assert.equal(history[0].failure.code, 'E_FETCH');
  assert.ok(!JSON.stringify(history[0]).includes('DNS lookup failed'));
  assert.equal(history[0].stages.fetched, 0);
  await rm(dir, { recursive: true, force: true });
});

test('a real collapse is not masked by the median-window off-by-one', async () => {
  const { dir, paths } = await tmpPaths();
  const many = Array.from({ length: 10 }, (_, i) => (
    { id: i, link: `https://example.test/${i}`, title: `Item ${i}` }
  ));
  const few = many.slice(0, 3);
  // 5 healthy runs of 10 records set the trailing median at 10
  // (threshold 10 * count_drop_ratio 0.4 = 4). A 6th run parsing 3 sits
  // below that threshold but above min_records — the only way to fail is
  // count_drop_ratio, which needs the full median_window of past runs to
  // fire. Before the off-by-one fix, readHistory's window silently lost one
  // past run every time, and the same numbers came back "ok".
  for (let i = 0; i < 5; i++) {
    await runIngest({ adapter, paths, fetchImpl: impl(many), now: new Date(2026, 0, i + 1) });
  }
  const { report, canary } = await runIngest({
    adapter, paths, fetchImpl: impl(few), now: new Date(2026, 0, 6),
  });
  assert.equal(report.stages.parsed, 3);
  assert.equal(canary.status, 'stale');
  assert.match(canary.breaches.join(' '), /count_drop_ratio/);
  await rm(dir, { recursive: true, force: true });
});

// --- O01: the persisted canary matches the returned one ---

test('O01: the persisted saved canary matches the returned stale result', async () => {
  const { dir, paths } = await tmpPaths();
  const { report, canary } = await runIngest({ adapter, paths, fetchImpl: impl([]), now: new Date('2026-09-18T00:00:00Z') });
  const [saved] = await readHistory(paths.runsDir, 1);
  assert.equal(canary.status, 'stale');
  assert.deepEqual(saved.canary, canary);
  assert.equal(saved.outcome, 'stale');
  assert.equal(saved.run_id, report.run_id);
  await rm(dir, { recursive: true, force: true });
});

// --- O03: primary failure survives a secondary report-write failure; committed storage stays visible ---

test('O03: a primary fetch failure survives an additional report-write failure', async () => {
  const { dir, paths } = await tmpPaths();
  // Pointing runsDir at a regular file makes every report write in this run
  // fail with a real, non-ACL filesystem error (mkdir -> ENOTDIR).
  const blockedRunsDir = join(dir, 'blocked-runs');
  await writeFile(blockedRunsDir, 'not a directory');
  const boom = async () => { throw new Error('connection reset'); };
  try {
    await runIngest({ adapter, paths: { ...paths, runsDir: blockedRunsDir }, fetchImpl: boom, now: new Date() });
    assert.fail('expected runIngest to reject');
  } catch (err) {
    assert.equal(err.code, 'E_FETCH', 'the original fetch failure must remain the primary error');
    assert.ok(err.details?.secondary_errors?.some((s) => s.code === 'E_REPORT_WRITE'),
      'the report-write failure must ride along as a secondary detail, not replace the primary error');
  }
  await rm(dir, { recursive: true, force: true });
});

test('O03: committed storage remains visible even when report handling afterward fails', async () => {
  const { dir, paths } = await tmpPaths();
  const blockedRunsDir = join(dir, 'blocked-runs');
  await writeFile(blockedRunsDir, 'not a directory');
  let caught;
  try {
    await runIngest({ adapter, paths: { ...paths, runsDir: blockedRunsDir }, fetchImpl: impl(items), now: new Date() });
    assert.fail('expected runIngest to reject once report handling fails');
  } catch (err) {
    caught = err;
  }
  // With a valid runsDir this would fail at the final writeReport call
  // (E_REPORT_WRITE); here the eligible-history scan that runs just before
  // it hits the same blocked path first (E_REPORT_READ) -- either way,
  // with no other primary failure, whichever report-handling failure
  // occurs first becomes primary.
  assert.equal(caught.code, 'E_REPORT_READ', 'with no other primary failure, the report-handling failure becomes primary');
  const stored = await readRecords(paths.storeFile);
  assert.equal(stored.length, 2, 'the append that already succeeded must not be rolled back by a later report-handling failure');
  await rm(dir, { recursive: true, force: true });
});

test('O03: an incremental run isolates the final writeReport failure specifically (E_REPORT_WRITE)', async () => {
  // Incremental mode skips the eligible-history scan entirely (that
  // baseline is snapshot-only), so the *only* report.mjs filesystem call in
  // this run is the final writeReport -- unlike the snapshot case above,
  // this isolates E_REPORT_WRITE specifically rather than E_REPORT_READ.
  const incAdapter = { ...adapter, fetch: { ...adapter.fetch, incremental: { param: 'since', type: 'iso-date' } } };
  const { dir, paths } = await tmpPaths();
  const blockedRunsDir = join(dir, 'blocked-runs');
  await writeFile(blockedRunsDir, 'not a directory');
  let caught;
  try {
    await runIngest({
      adapter: incAdapter, paths: { ...paths, runsDir: blockedRunsDir },
      fetchImpl: impl(items), since: '2026-01-01', now: new Date(),
    });
    assert.fail('expected runIngest to reject once the final report write fails');
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, 'E_REPORT_WRITE');
  const stored = await readRecords(paths.storeFile);
  assert.equal(stored.length, 2, 'the append that already succeeded must not be rolled back by a later report-write failure');
  await rm(dir, { recursive: true, force: true });
});

// --- 5.2: a lock-release failure after an otherwise-successful run ---

test('a lock-release failure after a successful run updates the persisted report to error, preserving committed storage', async () => {
  const { dir, paths } = await tmpPaths();
  const fetchImpl = async () => {
    // Simulates external interference with the lock file while this run
    // still holds it (never produced by normal cooperative use) -- release
    // will then fail to verify ownership and refuse to remove it.
    await writeFile(paths.storeFile + '.lock', JSON.stringify({ version: 1, run_id: 'someone-else' }));
    return new Response(JSON.stringify(items), { status: 200 });
  };
  let caught;
  try {
    await runIngest({ adapter, paths, fetchImpl, now: new Date() });
    assert.fail('expected runIngest to reject due to the lock-release failure');
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, 'E_LOCK_RELEASE');
  assert.ok(caught.report, 'the in-memory report must still be attached');
  assert.equal(caught.report.outcome, 'error');

  // The append already committed successfully before the lock-release
  // failure -- it must remain visible on disk, not rolled back.
  const stored = await readRecords(paths.storeFile);
  assert.equal(stored.length, 2);

  // The already-published report was updated in place (same run_id), not
  // duplicated into a second file.
  const history = await readHistory(paths.runsDir, 5);
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, 'error');
  assert.equal(history[0].run_id, caught.report.run_id);
  await rm(dir, { recursive: true, force: true });
});

// --- C01: bad/legacy/incremental/different-adapter history cannot lower the snapshot baseline ---

test('C01: ineligible history entries cannot drag the count_drop_ratio baseline down', async () => {
  const c01Adapter = { ...adapter, canary: { ...adapter.canary, median_window: 5 } };
  const { dir, paths } = await tmpPaths();
  const many = Array.from({ length: 10 }, (_, i) => ({ id: i, link: `https://example.test/${i}`, title: `Item ${i}` }));
  const few = many.slice(0, 3);

  // Two real, eligible baseline runs (parsed: 10 each).
  await runIngest({ adapter: c01Adapter, paths, fetchImpl: impl(many), now: new Date(2026, 5, 1) });
  const { report: secondReport } = await runIngest({ adapter: c01Adapter, paths, fetchImpl: impl(many), now: new Date(2026, 5, 2) });
  const { host, adapter_fingerprint: fingerprint } = secondReport;

  // Four ineligible reports, dated *after* the two real runs (so a
  // newest-first scan meets them first) with a low parsed count that would
  // drag the median baseline down to ~1 if any were wrongly counted.
  const seedBase = {
    mode: 'snapshot', outcome: 'ok', host, adapter_fingerprint: fingerprint,
    finished_at: new Date(2026, 5, 3).toISOString(), duration_ms: 0,
    stages: { fetched: 1, parsed: 1, fresh: 1, changed: 0, unchanged: 0, written: 1 },
    error_count: 0, errors: [], fatal_error: null, failure: null, secondary_errors: [],
    warnings: [], warning_count: 0, newest_staleness_value: null,
    canary: { status: 'ok', breaches: [], skipped: [] },
    fetch: { pages: 1, attempts: 1, retries: 0, statuses: [200], status_count: 1, bytes: 0, complete: true, stop_reason: 'single_page' },
    storage: { status: 'committed', written: 1 },
  };
  const seed = (day, overrides) => writeReport(paths.runsDir, {
    report_version: 2, run_id: `seed-${day}`, started_at: new Date(2026, 5, day).toISOString(),
    ...seedBase, ...overrides,
  });
  await seed(3, { report_version: undefined }); // legacy: no report_version at all
  await seed(4, { mode: 'incremental' }); // wrong mode
  await seed(5, { adapter_fingerprint: 'a-completely-different-adapter' }); // different adapter
  await seed(6, { outcome: 'error', failure: { code: 'E_FETCH', message: 'x', stage: 'fetch' } }); // failed run

  // A real collapse, evaluated after all the ineligible noise above.
  const { report, canary } = await runIngest({ adapter: c01Adapter, paths, fetchImpl: impl(few), now: new Date(2026, 5, 10) });
  assert.equal(report.stages.parsed, 3);
  assert.equal(canary.status, 'stale');
  assert.match(canary.breaches.join(' '), /count_drop_ratio/);
  await rm(dir, { recursive: true, force: true });
});

// --- E01: real fixture replay for both recorded adapters, over native Response ---

for (const host of ['earthquake.usgs.gov', 'www.karnatakacareers.org']) {
  test(`E01 (${host}): a first run stores every fixture record fresh, with an ok canary`, async () => {
    const { adapter, fixtureRoot } = await loadAdapterFixture(host);
    const { dir, paths } = await tmpPaths();
    const now = new Date(newestStalenessInstant(adapter, fixtureRoot) + 12 * 3600 * 1000);
    const total = getPath(fixtureRoot, adapter.records_path ?? '$').length;
    const { report, canary } = await runIngest({
      adapter, paths, now,
      fetchImpl: async () => new Response(JSON.stringify(fixtureRoot), { status: 200 }),
    });
    assert.equal(report.stages.fetched, total);
    assert.equal(report.stages.fresh, total);
    assert.equal(canary.status, 'ok');
    await rm(dir, { recursive: true, force: true });
  });

  test(`E01 (${host}): an identical replay writes 0 new records`, async () => {
    const { adapter, fixtureRoot } = await loadAdapterFixture(host);
    const { dir, paths } = await tmpPaths();
    const now = new Date(newestStalenessInstant(adapter, fixtureRoot) + 12 * 3600 * 1000);
    const impl = async () => new Response(JSON.stringify(fixtureRoot), { status: 200 });
    await runIngest({ adapter, paths, now, fetchImpl: impl });
    const { report } = await runIngest({ adapter, paths, now, fetchImpl: impl });
    assert.equal(report.stages.written, 0);
    await rm(dir, { recursive: true, force: true });
  });

  test(`E01 (${host}): editing one mapped field changes exactly 1 record; the latest view has one row per ID`, async () => {
    const { adapter, fixtureRoot } = await loadAdapterFixture(host);
    const { dir, paths } = await tmpPaths();
    const now = new Date(newestStalenessInstant(adapter, fixtureRoot) + 12 * 3600 * 1000);
    await runIngest({
      adapter, paths, now,
      fetchImpl: async () => new Response(JSON.stringify(fixtureRoot), { status: 200 }),
    });

    const editedRoot = structuredClone(fixtureRoot);
    const items = getPath(editedRoot, adapter.records_path ?? '$');
    const total = items.length;
    // title is present in every recorded adapter's map and is never part of
    // record identity (source_id/url), so editing it changes content_hash
    // without touching which record it is.
    const segs = adapter.map.title.path.split('.');
    let cur = items[0];
    for (const seg of segs.slice(0, -1)) cur = cur[seg];
    cur[segs.at(-1)] = `${cur[segs.at(-1)]} (edited)`;

    const { report } = await runIngest({
      adapter, paths, now,
      fetchImpl: async () => new Response(JSON.stringify(editedRoot), { status: 200 }),
    });
    assert.equal(report.stages.changed, 1);
    assert.equal(report.stages.written, 1);

    const latest = await readLatestRecords(paths.storeFile);
    assert.equal(latest.length, total, 'the latest view must have exactly one row per ID, not one per revision');
    await rm(dir, { recursive: true, force: true });
  });

  test(`E01 (${host}): a broken required mapping reports a stale canary, not a silent success`, async () => {
    const { adapter, fixtureRoot } = await loadAdapterFixture(host);
    const { dir, paths } = await tmpPaths();
    const now = new Date(newestStalenessInstant(adapter, fixtureRoot) + 12 * 3600 * 1000);
    const broken = { ...adapter, map: { ...adapter.map, title: { ...adapter.map.title, path: 'nonexistent_field' } } };
    const { report, canary } = await runIngest({
      adapter: broken, paths, now,
      fetchImpl: async () => new Response(JSON.stringify(fixtureRoot), { status: 200 }),
    });
    assert.equal(report.stages.parsed, 0);
    assert.equal(canary.status, 'stale');
    await rm(dir, { recursive: true, force: true });
  });
}
