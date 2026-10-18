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
