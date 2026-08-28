import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';

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
