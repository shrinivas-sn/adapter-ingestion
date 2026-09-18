import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, appendFile, writeFile, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRecords, readRecords, readIndex, readLatestRecords, iterateRecords } from '../src/store.mjs';

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

// --- S01: bounded iterator correctness ---

test('iterator recovers with visible corruption and latest hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file,
    '{"id":"h:1","content_hash":"a"}\nnot json\n' +
    '{"id":"h:1","content_hash":"b"}\n', 'utf8');
  const warnings = [];
  const idx = await readIndex(file, { onWarning: (w) => warnings.push(w) });
  assert.equal(idx.get('h:1'), 'b');
  assert.deepEqual(warnings.map((w) => [w.code, w.line]), [['W_STORE_CORRUPT_LINE', 2]]);
  await rm(dir, { recursive: true, force: true });
});

test('CRLF line endings are tolerated the same as LF', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file,
    '{"id":"h:1","content_hash":"a"}\r\n{"id":"h:2","content_hash":"b"}\r\n', 'utf8');
  const records = await readRecords(file);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.id), ['h:1', 'h:2']);
  await rm(dir, { recursive: true, force: true });
});

test('a multi-byte UTF-8 character split across a chunk-read boundary still decodes correctly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  const CHUNK_BYTES = 64 * 1024; // must match src/store.mjs's internal read-chunk size
  const euro = Buffer.from('€', 'utf8'); // 3 bytes: 0xE2 0x82 0xAC
  const prefix = Buffer.from('{"id":"h:1","content_hash":"a","fields":{"pad":"');
  const suffix = Buffer.from('"}}\n');
  // Padded so the euro sign's 3 bytes straddle exactly the chunk boundary --
  // 2 bytes land in the first read, 1 in the second.
  const padLen = CHUNK_BYTES - prefix.length - 2;
  const pad = Buffer.alloc(padLen, 0x78); // 'x'
  const content = Buffer.concat([prefix, pad, euro, suffix]);
  assert.ok(content.length > CHUNK_BYTES, 'fixture assumption: file must span more than one chunk read');
  await writeFile(file, content);

  const records = await readRecords(file);
  assert.equal(records.length, 1);
  assert.equal(records[0].fields.pad, 'x'.repeat(padLen) + '€');
  await rm(dir, { recursive: true, force: true });
});

test('a missing file reads as empty through every reducer, not just readRecords', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'does-not-exist.jsonl');
  assert.deepEqual(await readRecords(file), []);
  assert.equal((await readIndex(file)).size, 0);
  assert.equal((await readLatestRecords(file)).length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('an empty file reads as empty, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file, '');
  assert.deepEqual(await readRecords(file), []);
  await rm(dir, { recursive: true, force: true });
});

test('a final complete line with no trailing newline is still read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file, '{"id":"h:1","content_hash":"a"}\n{"id":"h:2","content_hash":"b"}', 'utf8');
  const records = await readRecords(file);
  assert.deepEqual(records.map((r) => r.id), ['h:1', 'h:2']);
  await rm(dir, { recursive: true, force: true });
});

test('a malformed final tail (no closing brace, no newline) warns and is skipped, not thrown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file, '{"id":"h:1","content_hash":"a"}\n{"id":"h:2","content_ha', 'utf8');
  const warnings = [];
  const records = await readRecords(file, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(records.map((r) => r.id), ['h:1']);
  assert.deepEqual(warnings, [{ code: 'W_STORE_CORRUPT_LINE', line: 2 }]);
  await rm(dir, { recursive: true, force: true });
});

test('a well-formed JSON object missing id or content_hash warns as W_STORE_INVALID_RECORD', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file,
    '{"id":"h:1","content_hash":"a"}\n' +
    '{"content_hash":"no-id"}\n' +
    '{"id":"","content_hash":"blank-id"}\n' +
    '{"id":"h:2"}\n' +
    '{"id":"h:3","content_hash":""}\n', 'utf8');
  const warnings = [];
  const records = await readRecords(file, { onWarning: (w) => warnings.push(w) });
  assert.deepEqual(records.map((r) => r.id), ['h:1']);
  assert.deepEqual(warnings.map((w) => w.code),
    ['W_STORE_INVALID_RECORD', 'W_STORE_INVALID_RECORD', 'W_STORE_INVALID_RECORD', 'W_STORE_INVALID_RECORD']);
  await rm(dir, { recursive: true, force: true });
});

test('a line at exactly maxLineBytes is accepted; one byte more rejects the whole read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  const build = (padLen) => JSON.stringify({ id: 'h:1', content_hash: 'a', fields: { pad: 'x'.repeat(padLen) } });
  // Binary-search-free: just grow the padding until the serialized line is
  // exactly at (and one over) the configured cap.
  let line = build(0);
  const capOverhead = Buffer.byteLength(line, 'utf8');
  const maxLineBytes = capOverhead + 50;
  line = build(50);
  assert.equal(Buffer.byteLength(line, 'utf8'), maxLineBytes, 'fixture assumption: line lands exactly on the cap');
  await writeFile(file, line + '\n');
  assert.equal((await readRecords(file, { maxLineBytes })).length, 1);

  const overLine = build(51);
  await writeFile(file, overLine + '\n');
  await assert.rejects(() => readRecords(file, { maxLineBytes }), (err) => err.code === 'E_STORE_LINE_LIMIT');
  await rm(dir, { recursive: true, force: true });
});

test('an oversized line with no terminating newline still hits E_STORE_LINE_LIMIT, not an OOM read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await writeFile(file, 'x'.repeat(200)); // no newline at all -- one giant "line"
  await assert.rejects(() => readRecords(file, { maxLineBytes: 100 }), (err) => err.code === 'E_STORE_LINE_LIMIT');
  await rm(dir, { recursive: true, force: true });
});

test('breaking out of iteration early still closes the file handle (Windows-safe rename after)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [{ id: 'h:1', content_hash: 'a' }, { id: 'h:2', content_hash: 'b' }]);

  for await (const record of iterateRecords(file)) {
    if (record.id === 'h:1') break;
  }
  // A leaked read handle blocks rename/delete on Windows; this throws if the
  // generator's finally didn't run when the for-await loop broke early.
  await rename(file, file + '.moved');
  await rm(dir, { recursive: true, force: true });
});

test('a genuine non-ENOENT read failure surfaces as E_STORE_READ, not a silent empty result', async () => {
  // Empirically verified (Node 22.15, both platforms): a path containing an
  // embedded null byte is rejected by Node's own fs path validation with
  // ERR_INVALID_ARG_VALUE -- a real, portable, non-ACL, non-ENOENT failure,
  // without needing platform-specific tricks (an ENOTDIR-style blocked path
  // component reads back as plain ENOENT on Windows, not a distinct code).
  const badPath = `some${String.fromCharCode(0)}path.jsonl`;
  await assert.rejects(() => readRecords(badPath), (err) => err.code === 'E_STORE_READ');
});

test('readLatestRecords/readIndex keep first-seen insertion order with the latest value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [
    { id: 'a', content_hash: '1' },
    { id: 'b', content_hash: '1' },
    { id: 'c', content_hash: '1' },
  ]);
  await appendRecords(file, [{ id: 'b', content_hash: '2' }]);
  await appendRecords(file, [{ id: 'a', content_hash: '2' }]);
  await appendRecords(file, [{ id: 'b', content_hash: '3' }]);

  const latest = await readLatestRecords(file);
  assert.deepEqual(latest.map((r) => r.id), ['a', 'b', 'c'], 'first-seen order, not last-write order');
  assert.deepEqual(latest.map((r) => r.content_hash), ['2', '3', '1']);

  const idx = await readIndex(file);
  assert.deepEqual([...idx.keys()], ['a', 'b', 'c']);
  assert.deepEqual([...idx.values()], ['2', '3', '1']);
  await rm(dir, { recursive: true, force: true });
});

// --- S03: preflight leaves an existing file untouched on a later bad record ---

test('a later unserializable record leaves an existing file byte-identical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [{ id: 'h:1', content_hash: 'a' }]);
  const before = await readFile(file, 'utf8');

  const cyclic = { id: 'h:2', content_hash: 'b' };
  cyclic.self = cyclic;
  await assert.rejects(() => appendRecords(file, [{ id: 'h:0', content_hash: 'ok' }, cyclic]),
    (err) => err.code === 'E_STORE_WRITE');

  assert.equal(await readFile(file, 'utf8'), before, 'the preflight failure must not have written anything, not even the earlier valid record');
  await rm(dir, { recursive: true, force: true });
});

test('a later oversized record leaves an existing file byte-identical', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [{ id: 'h:1', content_hash: 'a' }]);
  const before = await readFile(file, 'utf8');

  const huge = { id: 'h:2', content_hash: 'b', fields: { pad: 'x'.repeat(1000) } };
  await assert.rejects(
    () => appendRecords(file, [{ id: 'h:0', content_hash: 'ok' }, huge], { maxLineBytes: 100 }),
    (err) => err.code === 'E_STORE_LINE_LIMIT');

  assert.equal(await readFile(file, 'utf8'), before);
  await rm(dir, { recursive: true, force: true });
});

test('appendRecords with an empty array writes nothing and creates no file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'never-created.jsonl');
  const count = await appendRecords(file, []);
  assert.equal(count, 0);
  await assert.rejects(() => readFile(file), { code: 'ENOENT' });
  await rm(dir, { recursive: true, force: true });
});

test('a record missing id/content_hash is rejected by appendRecords before any write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await assert.rejects(() => appendRecords(file, [{ content_hash: 'a' }]), (err) => err.code === 'E_STORE_WRITE');
  await assert.rejects(() => appendRecords(file, [{ id: 'h:1' }]), (err) => err.code === 'E_STORE_WRITE');
  await assert.rejects(() => readFile(file), { code: 'ENOENT' }, 'a fully-invalid batch must not create the file at all');
  await rm(dir, { recursive: true, force: true });
});

test('appendRecords closes its handle even after a successful write (Windows-safe rename after)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'store-'));
  const file = join(dir, 'a.jsonl');
  await appendRecords(file, [{ id: 'h:1', content_hash: 'a' }]);
  await rename(file, file + '.moved');
  await rm(dir, { recursive: true, force: true });
});
