import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter } from '../src/adapter.mjs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { KNOWN_KEYS } from '../src/config.mjs';
import { resolveHeaders } from '../src/fetch/headers.mjs';
import { fetchAll } from '../src/fetch.mjs';
import { jsonResponse } from './helpers/fixtures.mjs';
import { computeAdapterFingerprint } from '../src/fingerprint.mjs';
import { runBin, disposableCwd } from './helpers/bin.mjs';
import { startServer } from './helpers/http-server.mjs';

const base = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' } },
};
const withHeaders = (headers) => ({ ...base, fetch: { headers } });

// ---- validation -----------------------------------------------------------

const VALID_HEADERS = {
  'a required reference': { Authorization: { env: 'API_TOKEN' } },
  'an optional reference': { 'x-api-key': { env: 'KEY_1', optional: true } },
  'a literal next to a reference': { A: 'literal', B: { env: '_X' } },
};

for (const [name, headers] of Object.entries(VALID_HEADERS)) {
  test(`secret headers: validateAdapter accepts ${name}`, () => {
    const result = validateAdapter(withHeaders(headers));
    assert.deepEqual(result, { ok: true, errors: [] });
  });
}

const INVALID_HEADERS = [
  [{ A: { env: '1BAD' } }, 'fetch.headers.A.env'],
  [{ A: { env: '' } }, 'fetch.headers.A.env'],
  [{ A: { env: 5 } }, 'fetch.headers.A.env'],
  [{ A: {} }, 'fetch.headers.A.env'],
  [{ A: { env: 'X', optional: 'yes' } }, 'fetch.headers.A.optional'],
  [{ A: { env: 'X', secret: true } }, 'fetch.headers.A.secret: unknown key'],
];

for (const [headers, expected] of INVALID_HEADERS) {
  test(`secret headers: validateAdapter rejects ${JSON.stringify(headers)}`, () => {
    const result = validateAdapter(withHeaders(headers));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes(expected)), JSON.stringify(result.errors));
  });
}

for (const value of [123, null, ['x']]) {
  test(`secret headers: a ${JSON.stringify(value)} header keeps the 0.5 message`, () => {
    const result = validateAdapter(withHeaders({ A: value }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes('fetch.headers.A must be a string'), JSON.stringify(result.errors));
  });
}

test('secret headers: an invalid header name with a reference is still rejected', () => {
  const result = validateAdapter(withHeaders({ 'bad name': { env: 'X' } }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('fetch.headers must be a valid header map'), JSON.stringify(result.errors));
});

// ---- schema ---------------------------------------------------------------

const schema = JSON.parse(await readFile(new URL('../schema/adapter.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

test('secret headers: schema header_ref lists exactly KNOWN_KEYS.header_ref', () => {
  assert.deepEqual(Object.keys(schema.$defs.header_ref.properties).sort(), KNOWN_KEYS.header_ref);
});

for (const [name, headers] of Object.entries(VALID_HEADERS)) {
  test(`secret headers: the schema accepts ${name}`, () => {
    assert.equal(validateSchema(withHeaders(headers)), true, JSON.stringify(validateSchema.errors));
  });
}

for (const headers of [{ A: { env: '1BAD' } }, { A: { env: 'X', secret: true } }, { A: { optional: true } }]) {
  test(`secret headers: schema and validateAdapter both reject ${JSON.stringify(headers)}`, () => {
    assert.equal(validateSchema(withHeaders(headers)), false, 'schema should reject');
    assert.equal(validateAdapter(withHeaders(headers)).ok, false, 'validateAdapter should reject');
  });
}

// ---- run-time resolution ----------------------------------------------------

// Unique names, deleted after each test, so nothing leaks between tests.
let envCounter = 0;
function envVar(t, value) {
  const name = `ADAPTER_TEST_TOKEN_${process.pid}_${++envCounter}`;
  if (value !== undefined) process.env[name] = value;
  t.after(() => { delete process.env[name]; });
  return name;
}

test('secret headers: resolveHeaders copies strings in order and reads references', (t) => {
  const v = envVar(t, 'Bearer abc');
  const out = resolveHeaders({ 'User-Agent': 'ua', Authorization: { env: v }, Accept: 'x' });
  assert.deepEqual(Object.entries(out), [['User-Agent', 'ua'], ['Authorization', 'Bearer abc'], ['Accept', 'x']]);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});

test('secret headers: resolveHeaders of undefined is {}', () => {
  assert.deepEqual(resolveHeaders(undefined), {});
});

test('secret headers: an optional reference that is unset or empty is left out', (t) => {
  const unset = envVar(t);
  const empty = envVar(t, '');
  assert.deepEqual(resolveHeaders({ A: { env: unset, optional: true }, B: { env: empty, optional: true }, C: 'c' }), { C: 'c' });
});

for (const value of [undefined, '']) {
  test(`secret headers: a required reference that is ${value === undefined ? 'unset' : 'empty'} throws E_HEADER_ENV`, (t) => {
    const v = envVar(t, value);
    assert.throws(() => resolveHeaders({ Authorization: { env: v } }), (err) => {
      assert.equal(err.code, 'E_HEADER_ENV');
      assert.ok(err.message.includes('fetch.headers.Authorization') && err.message.includes(v), err.message);
      assert.deepEqual(err.details, { header: 'Authorization', env: v });
      return true;
    });
  });
}

test('secret headers: an invalid value throws E_HEADER_ENV without the value anywhere', (t) => {
  const v = envVar(t, 'tok\nen-SECRET123');
  assert.throws(() => resolveHeaders({ Authorization: { env: v } }), (err) => {
    assert.equal(err.code, 'E_HEADER_ENV');
    assert.equal(err.cause, undefined);
    assert.ok(!err.message.includes('SECRET123'), err.message);
    assert.ok(!JSON.stringify(err.details).includes('SECRET123'));
    return true;
  });
});

const fetchAdapter = (headers, extra = {}) => ({
  host: 'example.test', records_path: '$',
  access: { kind: 'json-api', url: 'https://example.test/api' },
  fetch: { headers, ...extra },
});

test('secret headers: fetchAll sends the resolved value as a plain object', async (t) => {
  const v = envVar(t, 'Bearer xyz');
  const seen = [];
  const impl = async (url, init) => { seen.push(init.headers); return jsonResponse([]); };
  await fetchAll(fetchAdapter({ 'User-Agent': 'ua', Authorization: { env: v } }), { fetchImpl: impl });
  assert.deepEqual(seen, [{ 'User-Agent': 'ua', Authorization: 'Bearer xyz' }]);
});

test('secret headers: fetchAll makes no request and does not retry when a required variable is unset', async (t) => {
  const v = envVar(t);
  let calls = 0;
  const impl = async () => { calls++; return jsonResponse([]); };
  await assert.rejects(
    fetchAll(fetchAdapter({ Authorization: { env: v } }, { retry: { max_attempts: 3 } }), { fetchImpl: impl }),
    (err) => err.code === 'E_HEADER_ENV',
  );
  assert.equal(calls, 0);
});

// ---- end to end: run reports and the CLI -----------------------------------

async function headerServer(t) {
  const seen = [];
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, link: 'https://example.test/1', title: 'One' }]));
    },
  });
  t.after(close);
  return { origin, seen };
}

async function writeRefAdapter(cwd, origin, ref) {
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { headers: { Authorization: ref }, retry: { max_attempts: 1 } },
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify(adapter));
  return adapter;
}

async function allFileText(dir) {
  const files = await readdir(dir, { recursive: true, withFileTypes: true });
  const texts = await Promise.all(files.filter((f) => f.isFile())
    .map((f) => readFile(join(f.parentPath ?? f.path, f.name), 'utf8')));
  return texts.join('\n');
}

test('secret headers: bin run sends the secret, and it reaches no file and no output', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, seen } = await headerServer(t);
  await writeRefAdapter(cwd, origin, { env: 'ADAPTER_TEST_TOKEN_1' });
  const { code, stdout, stderr } = await runBin(['run', 'adapter.json', '--json', '--history', 'h.jsonl'],
    { cwd, env: { ADAPTER_TEST_TOKEN_1: 'SECRET-abc123' } });
  assert.equal(code, 0, stderr);
  assert.deepEqual(seen, ['SECRET-abc123']);
  const onDisk = await allFileText(cwd);
  assert.ok(onDisk.includes('ADAPTER_TEST_TOKEN_1'), 'the adapter file is read');
  for (const text of [onDisk, stdout, stderr]) assert.ok(!text.includes('abc123'));
});

test('secret headers: bin run with the variable unset exits 2 with E_HEADER_ENV and sends nothing', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, seen } = await headerServer(t);
  await writeRefAdapter(cwd, origin, { env: 'ADAPTER_TEST_TOKEN_1' });
  const { code, stdout } = await runBin(['run', 'adapter.json', '--json'], { cwd, env: { ADAPTER_TEST_TOKEN_1: '' } });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).failure.code, 'E_HEADER_ENV');
  assert.equal(seen.length, 0);
  const runsDir = join(cwd, 'runs', '127.0.0.1');
  const reports = (await readdir(runsDir)).filter((f) => f.startsWith('report-')).sort();
  const report = JSON.parse(await readFile(join(runsDir, reports.at(-1)), 'utf8'));
  assert.equal(report.outcome, 'error');
  assert.equal(report.failure.code, 'E_HEADER_ENV');
});

test('secret headers: bin run with an optional variable unset sends no header and exits 0', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, seen } = await headerServer(t);
  await writeRefAdapter(cwd, origin, { env: 'ADAPTER_TEST_TOKEN_1', optional: true });
  const { code, stderr } = await runBin(['run', 'adapter.json', '--json'], { cwd, env: { ADAPTER_TEST_TOKEN_1: '' } });
  assert.equal(code, 0, stderr);
  assert.deepEqual(seen, [undefined]);
});

test('secret headers: the fingerprint does not depend on the secret value', (t) => {
  const v = envVar(t, 'one');
  const adapter = { ...base, fetch: { headers: { Authorization: { env: v } } } };
  const first = computeAdapterFingerprint(adapter);
  process.env[v] = 'two';
  assert.equal(computeAdapterFingerprint(adapter), first);
});

test('secret headers: the older node src/run.mjs entry point also exits 2 for E_HEADER_ENV', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, seen } = await headerServer(t);
  await writeRefAdapter(cwd, origin, { env: 'ADAPTER_TEST_TOKEN_1' });
  const runMjs = fileURLToPath(new URL('../src/run.mjs', import.meta.url));
  const child = spawn(process.execPath, [runMjs, 'adapter.json'], {
    cwd, env: { ...process.env, ADAPTER_TEST_TOKEN_1: '' }, stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 2);
  assert.equal(seen.length, 0);
});

for (const name of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
  test(`secret headers: an unset variable named ${name} fails instead of sending an inherited value`, () => {
    assert.throws(() => resolveHeaders({ A: { env: name } }), (err) => err.code === 'E_HEADER_ENV');
    assert.deepEqual(resolveHeaders({ A: { env: name, optional: true } }), {});
  });
}

test('secret headers: text-mode bin run output never contains the secret', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, seen } = await headerServer(t);
  await writeRefAdapter(cwd, origin, { env: 'ADAPTER_TEST_TOKEN_1' });
  const ok = await runBin(['run', 'adapter.json'], { cwd, env: { ADAPTER_TEST_TOKEN_1: 'SECRET-abc123' } });
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(seen, ['SECRET-abc123']);
  const bad = await runBin(['run', 'adapter.json'], { cwd, env: { ADAPTER_TEST_TOKEN_1: 'SECRET\nabc123' } });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /E_HEADER_ENV/);
  for (const text of [ok.stdout, ok.stderr, bad.stdout, bad.stderr, await allFileText(cwd)]) {
    assert.ok(!text.includes('abc123'));
  }
});
