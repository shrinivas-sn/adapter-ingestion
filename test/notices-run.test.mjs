import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../src/run.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { retry: { max_attempts: 1 } },
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
};
const items = [{ id: 1, link: 'https://example.test/1', title: 'One' }];
const impl = (body) => async () => new Response(JSON.stringify(body), { status: 200 });

async function tmpPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'notices-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
}

test('notices in runs: a first snapshot run with no history advises A_CANARY_NO_HISTORY, outcome still ok', async (t) => {
  const paths = await tmpPaths(t);
  const { report } = await runIngest({ adapter, paths, fetchImpl: impl(items) });
  assert.equal(report.outcome, 'ok');
  assert.deepEqual(report.notices.map((n) => n.code), ['A_CANARY_NO_HISTORY']);
  const [name] = await readdir(paths.runsDir);
  const written = JSON.parse(await readFile(join(paths.runsDir, name), 'utf8'));
  assert.deepEqual(written.notices, report.notices);
});

test('notices in runs: with one eligible past run there is no history advice', async (t) => {
  const paths = await tmpPaths(t);
  await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date('2026-01-01T00:00:00Z') });
  const { report } = await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date('2026-01-02T00:00:00Z') });
  assert.deepEqual(report.notices, []);
});

test('notices in runs: an incremental run gets no history advice', async (t) => {
  const paths = await tmpPaths(t);
  const incremental = { ...adapter, fetch: { ...adapter.fetch, incremental: { param: 'since', type: 'iso-date' } } };
  const { report } = await runIngest({ adapter: incremental, paths, fetchImpl: impl(items), since: '2026-01-01' });
  assert.equal(report.mode, 'incremental');
  assert.deepEqual(report.notices, []);
});

test('notices in runs: an invalid adapter gets an empty notices array', async (t) => {
  const paths = await tmpPaths(t);
  await assert.rejects(runIngest({ adapter: { ...adapter, version: 2 }, paths, fetchImpl: impl(items) }), (err) => {
    assert.deepEqual(err.report.notices, []);
    return true;
  });
});

test('notices in runs: a fatal run after validation carries adapter-only notices (none today)', async (t) => {
  const paths = await tmpPaths(t);
  const failing = async () => new Response('{}', { status: 500 });
  await assert.rejects(runIngest({ adapter, paths, fetchImpl: failing }), (err) => {
    assert.equal(err.code, 'E_HTTP_STATUS');
    assert.deepEqual(err.report.notices, []);
    return true;
  });
});

test('notices in runs: a valid run with a misspelled canary advises it, outcome still ok', async (t) => {
  const plain = await runIngest({ adapter, paths: await tmpPaths(t), fetchImpl: impl(items) });
  const typo = { ...adapter, canry: { min_records: 1 } };
  const { report } = await runIngest({ adapter: typo, paths: await tmpPaths(t), fetchImpl: impl(items) });
  assert.equal(report.outcome, 'ok');
  assert.equal(report.stages.written, plain.report.stages.written);
  assert.deepEqual(report.notices.map((n) => n.code), ['A_CANARY_NO_HISTORY', 'A_TOP_LEVEL_KEY_TYPO']);
});

test('notices in runs: a misspelled records_path fails with its hint attached', async (t) => {
  const paths = await tmpPaths(t);
  const typo = { ...adapter, record_path: 'results' };
  await assert.rejects(runIngest({ adapter: typo, paths, fetchImpl: impl({ results: items }) }), (err) => {
    assert.equal(err.report.failure.code, 'E_RESPONSE_SHAPE');
    assert.ok(err.report.notices.some((n) => n.code === 'A_TOP_LEVEL_KEY_TYPO' && n.path === 'record_path'));
    return true;
  });
});

test('notices in runs: an invalid adapter still gets no notices, even with a typo', async (t) => {
  const paths = await tmpPaths(t);
  const { map, ...noMap } = adapter;
  await assert.rejects(runIngest({ adapter: { ...noMap, record_path: 'x' }, paths, fetchImpl: impl(items) }), (err) => {
    assert.equal(err.report.failure.code, 'E_ADAPTER_INVALID');
    assert.deepEqual(err.report.notices, []);
    return true;
  });
});
