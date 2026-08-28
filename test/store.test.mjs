import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecords, readRecords, readIndex } from '../src/store.mjs';

const rec = (id, hash) => ({ id, content_hash: hash, fields: {} });

test('append then read round-trips, and a missing file reads as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  assert.deepEqual(await readRecords(file), []);
  await appendRecords(file, [rec('h:1', 'x'), rec('h:2', 'y')]);
  assert.equal((await readRecords(file)).length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('readIndex maps id to the most recent content hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [rec('h:1', 'old')]);
  await appendRecords(file, [rec('h:1', 'new')]);
  const idx = await readIndex(file);
  assert.equal(idx.get('h:1'), 'new');
  assert.equal(idx.size, 1);
  await rm(dir, { recursive: true, force: true });
});

test('a corrupt line is skipped rather than killing the read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [rec('h:1', 'x')]);
  const { appendFile } = await import('node:fs/promises');
  await appendFile(file, 'not json\n');
  assert.equal((await readRecords(file)).length, 1);
  await rm(dir, { recursive: true, force: true });
});
