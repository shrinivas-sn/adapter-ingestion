import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';
import { readHistory } from '../src/report.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { method: 'GET', headers: { 'User-Agent': '<UA>' },
           pagination: { style: 'page-param', param: 'page', per_page_param: 'per_page', per_page: 10, max_pages: 1 } },
  records_path: '$',
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9 },
};
const items = [
  { id: 1, link: 'https://example.test/1', title: 'One' },
  { id: 2, link: 'https://example.test/2', title: 'Two' },
];
const impl = (body) => async () => ({ ok: true, status: 200, json: async () => body });

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

test('a run that throws still writes a report naming the failure, then rethrows', async () => {
  const { dir, paths } = await tmpPaths();
  const boom = async () => { throw new Error('DNS lookup failed'); };
  await assert.rejects(
    () => runIngest({ adapter, paths, fetchImpl: boom, now: new Date() }),
    /DNS lookup failed/,
  );
  const history = await readHistory(paths.runsDir, 5);
  assert.equal(history.length, 1, 'a report artifact must exist even though the run threw');
  assert.match(history[0].fatal_error, /DNS lookup failed/);
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
