import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateAdapter } from '../src/adapter.mjs';
import { KNOWN_KEYS } from '../src/config.mjs';
import { HTML_KNOWN_KEYS } from '../src/kinds/html.mjs';

const ROOT = new URL('../', import.meta.url);
const schema = JSON.parse(await readFile(new URL('schema/adapter.schema.json', ROOT), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateSchema = ajv.compile(schema);

const base = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' } },
};
const htmlBase = {
  ...base,
  access: { tier: 2, kind: 'html', url: 'https://example.test/list' },
  html: { mode: 'select', rows: 'tr', fields: { id: { attr: 'id' }, link: { selector: 'a', attr: 'href', resolve_url: true } } },
};

test('schema: every repo adapter passes', async () => {
  const dir = new URL('adapters/', ROOT);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.adapter.json') && f !== 'example.adapter.json');
  assert.ok(files.length > 0);
  for (const f of files) {
    const adapter = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    assert.equal(validateSchema(adapter), true, `${f}: ${JSON.stringify(validateSchema.errors)}`);
  }
});

test('schema: minimal json-api and html adapters pass both the schema and validateAdapter', () => {
  for (const adapter of [base, htmlBase, { ...htmlBase, html: { mode: 'script_json', script: 'script#__NEXT_DATA__' } }]) {
    assert.equal(validateSchema(adapter), true, JSON.stringify(validateSchema.errors));
    assert.equal(validateAdapter(adapter).ok, true);
  }
});

test('schema: an adapter with $schema passes both', () => {
  const adapter = { $schema: './node_modules/@shrinivas-sn/adapter-ingestion/schema/adapter.schema.json', ...base };
  assert.equal(validateSchema(adapter), true);
  assert.equal(validateAdapter(adapter).ok, true);
});

const INVALID = {
  'unknown access key': { ...base, access: { ...base.access, kindd: 'x' } },
  'unknown fetch key': { ...base, fetch: { timeout: 5 } },
  'unknown pagination key': { ...base, fetch: { pagination: { style: 'page-param', param: 'p', maxpages: 2 } } },
  'unknown incremental key': { ...base, fetch: { incremental: { param: 's', type: 'iso-date', extra: 1 } } },
  'unknown retry key': { ...base, fetch: { retry: { attempts: 2 } } },
  'unknown map rule key': { ...base, map: { ...base.map, title: { path: 't', normalise: 'text' } } },
  'unknown canary key': { ...base, canary: { min_record: 1 } },
  'version 2': { ...base, version: 2 },
  'missing host': (({ host, ...rest }) => rest)(base),
  'missing map.url': { ...base, map: { source_id: { path: 'id' } } },
  'html kind without html': { ...base, access: { ...base.access, kind: 'html' } },
  'html block on a json-api adapter': { ...base, html: htmlBase.html },
  'unknown html field key': { ...htmlBase, html: { ...htmlBase.html, fields: { id: { attribute: 'id' } } } },
  'select html with script': { ...htmlBase, html: { ...htmlBase.html, script: 'x' } },
  'staleness_field without max_staleness_days': { ...base, map: { ...base.map, d: { path: 'd' } }, canary: { staleness_field: 'd' } },
};

for (const [name, adapter] of Object.entries(INVALID)) {
  test(`schema: rejected by both schema and validateAdapter: ${name}`, () => {
    assert.equal(validateSchema(adapter), false, 'schema should reject');
    assert.equal(validateAdapter(adapter).ok, false, 'validateAdapter should reject');
  });
}

test('schema drift: each section lists exactly the keys the engine knows', () => {
  const props = (def) => Object.keys(schema.$defs[def].properties).sort();
  assert.deepEqual(props('access'), KNOWN_KEYS.access);
  assert.deepEqual(props('fetch'), KNOWN_KEYS.fetch);
  assert.deepEqual(props('pagination'), KNOWN_KEYS.pagination);
  assert.deepEqual(props('incremental'), KNOWN_KEYS.incremental);
  assert.deepEqual(props('retry'), KNOWN_KEYS.retry);
  assert.deepEqual(props('map_rule'), KNOWN_KEYS.map_rule);
  assert.deepEqual(props('canary'), KNOWN_KEYS.canary);
  assert.deepEqual(props('html_select'), HTML_KNOWN_KEYS.select);
  assert.deepEqual(props('html_script_json'), HTML_KNOWN_KEYS.script_json);
  assert.deepEqual(props('html_field'), HTML_KNOWN_KEYS.field);
});

test('schema drift: top-level keys match KNOWN_KEYS.top_level', () => {
  assert.deepEqual(Object.keys(schema.properties).sort(), KNOWN_KEYS.top_level);
});
