import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runIngest } from '../src/run.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  fetch: { retry: { max_attempts: 1 } },
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
  canary: { median_window: 5, count_drop_ratio: 0.4 },
};
const itemsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, link: `https://example.test/${i + 1}`, title: `T${i + 1}` }));
const impl = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
const at = (day) => new Date(`2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`);

async function tmpPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'history-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return {
    dir,
    paths: { storeFile: join(dir, 'store', 'example.test.jsonl'), runsDir: join(dir, 'runs'), historyFile: join(dir, 'store', 'example.test.history.jsonl') },
  };
}

test('history in runs: count_drop_ratio fires after a simulated fresh checkout (runs/ deleted, history file kept)', async (t) => {
  const { paths } = await tmpPaths(t);
  for (let day = 1; day <= 3; day++) {
    await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(10)), now: at(day) });
  }
  await rm(paths.runsDir, { recursive: true, force: true });
  const { report, canary } = await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(3)), now: at(4) });
  assert.equal(canary.status, 'stale');
  assert.deepEqual(canary.breaches, ['count_drop_ratio: parsed 3 vs trailing median 10']);
  assert.deepEqual(report.notices, []);
  const lines = (await readFile(paths.historyFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(Object.keys(lines[3]).sort(),
    ['adapter_fingerprint', 'host', 'mode', 'outcome', 'report_version', 'run_id', 'stages', 'started_at']);
  assert.equal(lines[3].outcome, 'stale');
});

test('history in runs: a first run with a history file gets no A_CANARY_NO_HISTORY advice', async (t) => {
  const { paths } = await tmpPaths(t);
  const { report } = await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(2)), now: at(1) });
  assert.deepEqual(report.notices, []);
});

test('history in runs: historyFile must be a nonempty string', async (t) => {
  const { paths } = await tmpPaths(t);
  await assert.rejects(runIngest({ adapter, paths: { ...paths, historyFile: '' }, fetchImpl: impl([]) }),
    { code: 'E_OPTIONS', message: 'paths.historyFile must be a nonempty string' });
});

test('history in runs: historyFile must differ from storeFile', async (t) => {
  const { paths } = await tmpPaths(t);
  await assert.rejects(runIngest({ adapter, paths: { ...paths, historyFile: paths.storeFile }, fetchImpl: impl([]) }),
    { code: 'E_OPTIONS', message: 'paths.historyFile must differ from paths.storeFile' });
});

test('history in runs: a history write failure is E_REPORT_WRITE with the report attached', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  const blocker = join(dir, 'not-a-dir');
  await writeFile(blocker, 'x');
  const historyFile = join(blocker, 'h.jsonl');
  // Incremental: the canary reads no history, so only the append can fail.
  // (A snapshot run would fail earlier on POSIX, reading a path under a
  // file -- ENOTDIR, E_REPORT_READ -- which the next test covers.)
  const incremental = { ...adapter, fetch: { ...adapter.fetch, incremental: { param: 'since', type: 'iso-date' } } };
  await assert.rejects(runIngest({ adapter: incremental, paths: { ...paths, historyFile }, since: '2026-01-01', fetchImpl: impl(itemsOf(2)), now: at(1) }), (err) => {
    assert.equal(err.code, 'E_REPORT_WRITE');
    assert.ok(err.report, 'report attached');
    return true;
  });
});

test('history in runs: an unreadable history file fails the snapshot run, never silently empty', async (t) => {
  const { dir, paths } = await tmpPaths(t);
  // A directory where the file should be: unreadable on every platform (EISDIR).
  const historyFile = join(dir, 'history-dir');
  await mkdir(historyFile);
  await assert.rejects(runIngest({ adapter, paths: { ...paths, historyFile }, fetchImpl: impl(itemsOf(2)), now: at(1) }), (err) => {
    assert.equal(err.code, 'E_REPORT_READ');
    assert.equal(err.report.failure.stage, 'canary');
    return true;
  });
});

test('history in runs: validation failures and lock failures write no history line', async (t) => {
  const { paths } = await tmpPaths(t);
  await assert.rejects(runIngest({ adapter: { ...adapter, version: 2 }, paths, fetchImpl: impl([]) }));
  await mkdir(join(paths.storeFile, '..'), { recursive: true });
  await writeFile(paths.storeFile + '.lock', JSON.stringify({ version: 1, run_id: 'someone-else' }));
  await assert.rejects(runIngest({ adapter, paths, fetchImpl: impl(itemsOf(1)) }), { code: 'E_STORE_LOCKED' });
  await assert.rejects(readFile(paths.historyFile, 'utf8'), { code: 'ENOENT' });
});

test('history in runs: a 0.3.0-shaped line (no notices) is still eligible', async (t) => {
  const { paths } = await tmpPaths(t);
  await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(10)), now: at(1) });
  const [first] = (await readFile(paths.historyFile, 'utf8')).trim().split('\n');
  const fingerprint = JSON.parse(first).adapter_fingerprint;
  const legacy = { report_version: 2, run_id: 'legacy', host: 'example.test', adapter_fingerprint: fingerprint,
    mode: 'snapshot', outcome: 'ok', started_at: '2026-01-02T00:00:00.000Z', stages: { fetched: 10, parsed: 10 } };
  await writeFile(paths.historyFile, `${first}\n${JSON.stringify(legacy)}\n`);
  const { canary } = await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(2)), now: at(3) });
  assert.deepEqual(canary.breaches, ['count_drop_ratio: parsed 2 vs trailing median 10']);
});

test('history in runs: the file is bounded to max(50, 2 x median_window) lines', async (t) => {
  const { paths } = await tmpPaths(t);
  for (let i = 0; i < 55; i++) {
    await runIngest({ adapter, paths, fetchImpl: impl(itemsOf(1)), now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  }
  const lines = (await readFile(paths.historyFile, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 50);
});
