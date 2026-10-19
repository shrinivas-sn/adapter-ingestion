import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter } from '../src/adapter.mjs';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { KNOWN_KEYS } from '../src/config.mjs';
import { resolveHeaders } from '../src/fetch/headers.mjs';
import { fetchAll } from '../src/fetch.mjs';
import { jsonResponse } from './helpers/fixtures.mjs';

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
