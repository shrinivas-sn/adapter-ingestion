import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runBin, disposableCwd, assertNoLeakage, VALID_ADAPTER } from './helpers/bin.mjs';

test('bin: no command is a usage error (exit 2)', async () => {
  const { code, stderr } = await runBin([]);
  assert.equal(code, 2);
  assert.match(stderr, /usage: adapter-ingestion/);
});

test('bin: --help prints usage and exits 0', async () => {
  const { code, stdout } = await runBin(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /usage: adapter-ingestion/);
});

test('bin: an unknown command exits 2, as JSON with --json', async () => {
  const text = await runBin(['frobnicate']);
  assert.equal(text.code, 2);
  assert.match(text.stderr, /unknown command: frobnicate/);
  const json = await runBin(['frobnicate', '--json']);
  assert.equal(json.code, 2);
  assert.deepEqual(JSON.parse(json.stdout), { error: { code: 'E_OPTIONS', message: 'unknown command: frobnicate' } });
});

test('bin: an unknown flag exits 2', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runBin(['validate', 'a.json', '--bogus'], { cwd });
  assert.equal(code, 2);
  assertNoLeakage(stderr);
});

test('bin validate: a valid adapter exits 0 (text and --json)', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify(VALID_ADAPTER));
  const text = await runBin(['validate', 'a.json'], { cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^valid: a\.json/);
  const json = await runBin(['validate', 'a.json', '--json'], { cwd });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, errors: [] });
});

test('bin validate: an invalid adapter exits 2 and lists every error', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify({ ...VALID_ADAPTER, version: 2, map: {} }));
  const json = await runBin(['validate', 'a.json', '--json'], { cwd });
  assert.equal(json.code, 2);
  const out = JSON.parse(json.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.errors.includes('version must be 1'));
  assert.ok(out.errors.length >= 2);
  const text = await runBin(['validate', 'a.json'], { cwd });
  assert.match(text.stdout, /^invalid: a\.json\n {2}- version must be 1/);
});

test('bin validate: a missing file or bad JSON exits 2 with no stack trace or file content', async (t) => {
  const cwd = await disposableCwd(t);
  const missing = await runBin(['validate', 'nope.json', '--json'], { cwd });
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.stdout), { error: { code: 'E_OPTIONS', message: 'failed to load adapter "nope.json": file not found' } });
  await writeFile(join(cwd, 'bad.json'), '{ "secret-token-123": ');
  const bad = await runBin(['validate', 'bad.json'], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not valid JSON/);
  assert.ok(!bad.stderr.includes('secret-token-123'));
  assertNoLeakage(bad.stderr);
});

test('bin validate: a missing path or an extra argument is a usage error', async () => {
  assert.equal((await runBin(['validate'])).code, 2);
  assert.equal((await runBin(['validate', 'a.json', 'b.json'])).code, 2);
});

test('bin explain: a known code prints meaning, cause and fix', async () => {
  const json = await runBin(['explain', 'E_FETCH', '--json']);
  assert.equal(json.code, 0);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(out), ['code', 'kind', 'meaning', 'cause', 'fix']);
  assert.equal(out.code, 'E_FETCH');
  const advice = await runBin(['explain', 'A_CANARY_NO_HISTORY']);
  assert.equal(advice.code, 0);
  assert.match(advice.stdout, /^A_CANARY_NO_HISTORY \(advice\)\nmeaning: /);
});

test('bin explain: an unknown code exits 2', async () => {
  const { code, stdout } = await runBin(['explain', 'NOPE', '--json']);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).error.code, 'E_OPTIONS');
  assert.equal((await runBin(['explain', 'constructor'])).code, 2);
});
