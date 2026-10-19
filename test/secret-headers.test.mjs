import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter } from '../src/adapter.mjs';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { KNOWN_KEYS } from '../src/config.mjs';

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
