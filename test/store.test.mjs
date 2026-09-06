import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecords, readRecords, readIndex, readLatestRecords } from '../src/store.mjs';

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
  await appendFile(file, 'not json\n');
  assert.equal((await readRecords(file)).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('a JSON-valid but non-object line is skipped, not passed to readIndex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [rec('h:1', 'x')]);
  // Valid JSON (a bare number, a string, an array, null) that isn't a
  // record object — readIndex reads `.id` off every entry this returns,
  // which throws on anything that isn't an object.
  await appendFile(file, '42\n"just a string"\n[1,2,3]\nnull\n');
  const records = await readRecords(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'h:1');
  await assert.doesNotReject(() => readIndex(file));
  await rm(dir, { recursive: true, force: true });
});

test('appending after a truncated last line repairs it instead of fusing onto it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  // Simulate a prior run killed mid-write: a complete line, then a
  // truncated one with no trailing newline.
  await writeFile(file, '{"id":"h:1","content_hash":"a"}\n{"id":"h:2","content_hash":"tr', 'utf8');
  await appendRecords(file, [rec('h:3', 'c')]);
  const records = await readRecords(file);
  const ids = records.map((r) => r.id);
  assert.ok(ids.includes('h:1'), 'the earlier healthy record must survive');
  assert.ok(ids.includes('h:3'), 'the new record must not fuse onto the truncated one and vanish');
  await rm(dir, { recursive: true, force: true });
});

test('readLatestRecords collapses an edited listing to its newest version only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [{ id: 'job:1', content_hash: 'a', fields: { title: 'Clerk — 10 posts' } }]);
  await appendRecords(file, [{ id: 'job:1', content_hash: 'b', fields: { title: 'Clerk — 12 posts' } }]);
  await appendRecords(file, [{ id: 'job:2', content_hash: 'c', fields: { title: 'Typist' } }]);
  assert.equal((await readRecords(file)).length, 3, 'the raw log keeps every version');
  const latest = await readLatestRecords(file);
  assert.equal(latest.length, 2, 'the latest view collapses to one row per id');
  const job1 = latest.find((r) => r.id === 'job:1');
  assert.equal(job1.fields.title, 'Clerk — 12 posts');
  await rm(dir, { recursive: true, force: true });
});
