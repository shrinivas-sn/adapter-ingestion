import { test } from 'node:test';
import assert from 'node:assert/strict';
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
