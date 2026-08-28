import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReport, writeReport, readHistory } from '../src/report.mjs';

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
