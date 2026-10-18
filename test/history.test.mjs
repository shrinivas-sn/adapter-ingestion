import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historySummary, readHistoryFile, appendHistory } from '../src/history.mjs';

async function tmpDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const line = (over = {}) => ({
  report_version: 2, run_id: 'r', host: 'example.test', adapter_fingerprint: 'f', mode: 'snapshot',
  outcome: 'ok', started_at: '2026-01-01T00:00:00.000Z', stages: { fetched: 1, parsed: 1 }, ...over,
});
const all = () => true;

test('history: historySummary keeps only the eligibility and count fields', () => {
  const report = { ...line(), errors: ['x'], warnings: ['y'], failure: null, fetch: { statuses: [200] }, notices: [] };
  assert.deepEqual(historySummary(report), line());
});

test('history: a missing file is empty history', async (t) => {
  const dir = await tmpDir(t);
  assert.deepEqual(await readHistoryFile(join(dir, 'none.jsonl'), 5, all), []);
});

test('history: an empty file is empty history', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'h.jsonl');
  await writeFile(file, '');
  assert.deepEqual(await readHistoryFile(file, 5, all), []);
});

test('history: corrupt lines are skipped with a warning', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'h.jsonl');
  await writeFile(file, `${JSON.stringify(line({ run_id: 'a' }))}\n{not json\n${JSON.stringify({ started_at: 'x' })}\n\n`);
  const warnings = [];
  const got = await readHistoryFile(file, 5, all, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(got.map((h) => h.run_id), ['a']);
  assert.deepEqual(warnings, [{ code: 'W_HISTORY_CORRUPT_LINE', line: 2 }, { code: 'W_HISTORY_CORRUPT_LINE', line: 3 }]);
});

test('history: entries come back newest first, filtered and limited', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'h.jsonl');
  const lines = ['a', 'b', 'c', 'd'].map((id, i) => JSON.stringify(line({ run_id: id, host: i === 2 ? 'other.test' : 'example.test' })));
  await writeFile(file, lines.join('\n') + '\n');
  const got = await readHistoryFile(file, 2, (h) => h.host === 'example.test');
  assert.deepEqual(got.map((h) => h.run_id), ['d', 'b']);
});

test('history: appendHistory creates the parent directory and keeps the newest `keep` lines', async (t) => {
  const dir = await tmpDir(t);
  const file = join(dir, 'nested', 'deeper', 'h.jsonl');
  for (let i = 0; i < 7; i++) await appendHistory(file, line({ run_id: `r${i}` }), { keep: 5 });
  const text = await readFile(file, 'utf8');
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(text.trim().split('\n').map((l) => JSON.parse(l).run_id), ['r2', 'r3', 'r4', 'r5', 'r6']);
  assert.deepEqual(await readdir(join(dir, 'nested', 'deeper')), ['h.jsonl'], 'no temp file left behind');
});

test('history: a write failure is E_REPORT_WRITE', async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(appendHistory(dir, line(), { keep: 5 }), (err) => {
    assert.equal(err.code, 'E_REPORT_WRITE');
    assert.match(err.message, /^failed to write history file: /);
    return true;
  });
});

test('history: a read failure other than a missing file is E_REPORT_READ', async (t) => {
  const dir = await tmpDir(t);
  await assert.rejects(readHistoryFile(dir, 5, all), (err) => {
    assert.equal(err.code, 'E_REPORT_READ');
    assert.match(err.message, /^failed to read history file: /);
    return true;
  });
});
