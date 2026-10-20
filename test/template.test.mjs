import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateAdapter } from '../src/adapter.mjs';
import { extractAll } from '../src/extract.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';
import { parseTemplate, renderTemplate, MAX_TEMPLATE_LENGTH, MAX_PLACEHOLDERS } from '../src/template.mjs';

// template (since 0.8): build a map field from several values of the raw
// record. Shapes below come from real sources (OWID entity/year, the USGS
// eventpage link, openrouter ids with a slash), with invented values.

const render = (template, item) => {
  const parsed = parseTemplate(template);
  assert.equal(parsed.ok, true, parsed.error);
  return renderTemplate(parsed.parts, parsed.isUrl, item);
};

test('parseTemplate: a composite id is text and path parts, not a URL', () => {
  const r = parseTemplate('{entity}:{year}');
  assert.equal(r.ok, true);
  assert.equal(r.isUrl, false);
  assert.deepEqual(r.parts, [{ path: 'entity' }, { text: ':' }, { path: 'year' }]);
});

test('parseTemplate: http(s) in any case makes a URL template', () => {
  assert.equal(parseTemplate('https://h.test/e/{id}').isUrl, true);
  assert.equal(parseTemplate('http://h.test/e/{id}').isUrl, true);
  assert.equal(parseTemplate('HTTPS://h.test/{id}').isUrl, true);
  assert.equal(parseTemplate('ftp://h.test/{id}').isUrl, false);
});

test('parseTemplate: a template with no placeholder is a fixed value', () => {
  const r = parseTemplate('https://h.test/page');
  assert.equal(r.ok, true);
  assert.equal(render('https://h.test/page', {}), 'https://h.test/page');
  assert.equal(render('plain', {}), 'plain');
});

const ERRORS = [
  ['', 'must be a nonempty string of at most 2000 characters'],
  [42, 'must be a nonempty string of at most 2000 characters'],
  [null, 'must be a nonempty string of at most 2000 characters'],
  ['x'.repeat(MAX_TEMPLATE_LENGTH + 1), 'must be a nonempty string of at most 2000 characters'],
  ['a}b', 'has an unmatched "{" or "}"'],
  ['{a{b}}', 'has an unmatched "{" or "}"'],
  ['{a', 'has an unmatched "{" or "}"'],
  ['x{}y', 'has an empty placeholder "{}"'],
  ['{$}', 'placeholder "{$}" must be nonempty dot segments, not "$"'],
  ['{a..b}', 'placeholder "{a..b}" must be nonempty dot segments, not "$"'],
  ['{.a}', 'placeholder "{.a}" must be nonempty dot segments, not "$"'],
  ['{__proto__}', 'placeholder "{__proto__}" must not use __proto__, constructor, or prototype'],
  ['{a.constructor}', 'placeholder "{a.constructor}" must not use __proto__, constructor, or prototype'],
  ['{a}'.repeat(MAX_PLACEHOLDERS + 1), 'has more than 20 placeholders'],
  ['https://{host}/x', 'must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")'],
  ['https://h.test{port}/x', 'must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")'],
  ['https://{id}', 'must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")'],
  ['https:// bad host/{id}', 'must be an http(s) URL once filled in'],
];

for (const [template, error] of ERRORS) {
  test(`parseTemplate rejects ${JSON.stringify(String(template).slice(0, 40))}`, () => {
    assert.deepEqual(parseTemplate(template), { ok: false, error });
  });
}

test('parseTemplate: a long placeholder is cut to 100 characters in the error', () => {
  const r = parseTemplate(`{${'a..'.repeat(60)}}`);
  assert.equal(r.ok, false);
  assert.ok(r.error.length < 160, r.error);
});

test('parseTemplate: exactly 20 placeholders and 2000 characters are allowed', () => {
  assert.equal(parseTemplate('{a}'.repeat(MAX_PLACEHOLDERS)).ok, true);
  assert.equal(parseTemplate('x'.repeat(MAX_TEMPLATE_LENGTH)).ok, true);
});

test('renderTemplate: a composite id keeps values as they are', () => {
  const item = { entity: 'Less developed regions, excluding China', year: '1950' };
  assert.equal(render('{entity}:{year}', item), 'Less developed regions, excluding China:1950');
});

test('renderTemplate: a URL template encodes values but keeps "/"', () => {
  assert.equal(render('https://h.test/e/{id}', { id: 'anthropic/claude x?#' }),
    'https://h.test/e/anthropic/claude%20x%3F%23');
  assert.equal(render('https://h.test/q?c={c}&y={y}', { c: 'A&B=C', y: 2020 }), 'https://h.test/q?c=A%26B%3DC&y=2020');
});

test('renderTemplate: a finite number is used as String(n)', () => {
  assert.equal(render('{n}', { n: 5 }), '5');
  assert.equal(render('{n}', { n: -1.5 }), '-1.5');
  assert.equal(render('{n}', { n: 0 }), '0');
});

for (const [label, value] of [
  ['missing', undefined], ['null', null], ['empty string', ''], ['blank string', '  '],
  ['boolean', true], ['object', {}], ['array', []], ['NaN', NaN], ['Infinity', Infinity],
]) {
  test(`renderTemplate: a ${label} value makes the whole field null`, () => {
    const item = value === undefined ? { other: 'x' } : { other: 'x', v: value };
    assert.equal(render('{other}/{v}', item), null);
    assert.equal(render('https://h.test/{other}/{v}', item), null);
  });
}

test('renderTemplate: nested paths and array indexes read like map paths', () => {
  assert.equal(render('{a.b}-{list.1}', { a: { b: 'x' }, list: ['p', 'q'] }), 'x-q');
});

test('renderTemplate: a non-object record gives null, never a throw', () => {
  const { parts, isUrl } = parseTemplate('{a}');
  assert.equal(renderTemplate(parts, isUrl, null), null);
  assert.equal(renderTemplate(parts, isUrl, 'text'), null);
});

test('renderTemplate: values are read from own properties only', () => {
  const item = Object.create({ inherited: 'leak' });
  assert.equal(render('{inherited}', item), null);
  assert.equal(render('{toString}', {}), null);
});

// ---- Task 1.2: validation, schema, extraction, end to end ----

const base = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { template: 'https://example.test/e/{id}' } },
};
const withMap = (map) => ({ ...base, map: { ...base.map, ...map } });
const schema = JSON.parse(await readFile(new URL('../schema/adapter.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

test('validateAdapter and the schema accept template rules', () => {
  for (const adapter of [base, withMap({ source_id: { template: '{a}:{b}' } }), withMap({ fixed: { template: 'https://example.test/' } })]) {
    assert.deepEqual(validateAdapter(adapter), { ok: true, errors: [] });
    assert.equal(validateSchema(adapter), true, JSON.stringify(validateSchema.errors));
  }
});

const INVALID_RULES = {
  'path and template': [{ url: { path: 'link', template: 'https://example.test/{id}' } }, 'map.url must have either path or template, not both'],
  'template and normalize': [{ url: { template: 'https://example.test/{id}', normalize: 'text' } }, 'map.url.template cannot be combined with normalize or assume_zone'],
  'template and assume_zone': [{ url: { template: 'https://example.test/{id}', assume_zone: 'Z' } }, 'map.url.template cannot be combined with normalize or assume_zone'],
  'empty template': [{ url: { template: '' } }, 'map.url.template must be a nonempty string of at most 2000 characters'],
  'placeholder in host': [{ url: { template: 'https://{h}/x' } }, 'map.url.template must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")'],
};

for (const [name, [map, message]] of Object.entries(INVALID_RULES)) {
  test(`validateAdapter rejects ${name}`, () => {
    const r = validateAdapter(withMap(map));
    assert.equal(r.ok, false);
    assert.ok(r.errors.includes(message), JSON.stringify(r.errors));
  });
}

test('the schema rejects what validateAdapter rejects, where JSON Schema can tell', () => {
  for (const name of ['path and template', 'template and normalize', 'template and assume_zone', 'empty template']) {
    assert.equal(validateSchema(withMap(INVALID_RULES[name][0])), false, name);
  }
});

test('a rule with neither path nor template keeps the 0.7 message exactly', () => {
  const r = validateAdapter(withMap({ url: {} }));
  assert.deepEqual(r.errors, ['map.url.path is required']);
  assert.equal(validateSchema(withMap({ url: {} })), false);
});

test('extractAll renders templates and drops a record whose url has a missing value', () => {
  const adapter = withMap({ source_id: { template: '{a}:{b}' }, url: { template: 'https://example.test/e/{a}' } });
  const { records, errors } = extractAll([{ a: 'x', b: 2 }, { b: 3 }], adapter, { fetchedAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(records.length, 1);
  assert.equal(records[0].fields.source_id, 'x:2');
  assert.equal(records[0].id, 'example.test:x:2');
  assert.equal(records[0].source_url, 'https://example.test/e/x');
  assert.equal(errors[0].code, 'E_RECORD_INVALID');
  assert.deepEqual(errors[0].missing.sort(), ['source_id', 'url']);
});

test('extractAll on an unvalidated adapter with a broken template gives null, never a throw', () => {
  const adapter = withMap({ note: { template: '{a' }, other: { template: 42 } });
  const { records } = extractAll([{ id: 'x', a: 'y' }], adapter, { fetchedAt: '2026-10-20T00:00:00.000Z' });
  assert.equal(records.length, 1);
  assert.equal(records[0].fields.note, null);
  assert.equal(records[0].fields.other, null);
});

test('runIngest stores a templated url end to end', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'template-'));
  try {
    const paths = { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
    const fetchImpl = async () => new Response(JSON.stringify([{ id: 'org/a b' }]), { status: 200 });
    const { report } = await runIngest({ adapter: base, paths, fetchImpl, now: new Date('2026-10-20T00:00:00Z') });
    assert.equal(report.outcome, 'ok', JSON.stringify(report.failure ?? report.errors));
    const records = await readRecords(paths.storeFile);
    assert.equal(records[0].source_url, 'https://example.test/e/org/a%20b');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- Review fix: the host must stay literal however the URL parser reads it ----

const HOST_LITERAL = 'must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")';
for (const template of ['https:///{p}', ' https://{p}/x', 'https:\\{p}/x', 'http:{p}', '\thttps://{p}', 'https://h.test{p}/x']) {
  test(`parseTemplate: ${JSON.stringify(template)} cannot let a value choose the host`, () => {
    assert.deepEqual(parseTemplate(template), { ok: false, error: HOST_LITERAL });
  });
}

test('parseTemplate: a placeholder in the port is rejected', () => {
  assert.equal(parseTemplate('https://h.test:{port}/x').ok, false);
});

test('parseTemplate: odd but literal hosts are URL templates, so values are encoded', () => {
  for (const template of [' https://h.test/{p}', 'https:\\h.test/{p}', 'https:///h.test/{p}']) {
    const r = parseTemplate(template);
    assert.equal(r.ok, true, template);
    assert.equal(r.isUrl, true, template);
    assert.equal(new URL(renderTemplate(r.parts, r.isUrl, { p: 'a b/c?d' })).host, 'h.test');
  }
});
