import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { htmlKind, _setCheerioLoaderForTest } from '../src/kinds/html.mjs';
import { validateAdapter } from '../src/adapter.mjs';

const PAGE_URL = 'https://example.test/list/';

function adapterWith(html, extra = {}) {
  return {
    version: 1, host: 'example.test',
    access: { tier: 2, kind: 'html', url: PAGE_URL },
    html,
    records_path: '$',
    map: { source_id: { path: 'link' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['source_id', 'url', 'title'],
    ...extra,
  };
}

const SELECT = {
  mode: 'select',
  rows: 'table tr',
  fields: {
    title: { selector: 'td:nth-child(1)' },
    link: { selector: 'a', attr: 'href', resolve_url: true },
    date: { selector: 'td:nth-child(3)' },
  },
};

async function parse(html, { contentType = 'text/html; charset=utf-8', spec = SELECT } = {}) {
  const bytes = Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf8');
  return htmlKind.parse({ bytes, contentType, url: PAGE_URL, adapter: adapterWith(spec) });
}

afterEach(() => _setCheerioLoaderForTest(undefined));

test('a 2-row table gives 2 items with exact values, keys in fields order', async () => {
  const items = await parse(`<table>
    <tr><td>First</td><td><a href="/a">open</a></td><td>2026-01-01</td></tr>
    <tr><td>Second</td><td><a href="https://other.test/b">open</a></td><td>2026-01-02</td></tr>
  </table>`);
  assert.deepEqual(items, [
    { title: 'First', link: 'https://example.test/a', date: '2026-01-01' },
    { title: 'Second', link: 'https://other.test/b', date: '2026-01-02' },
  ]);
  assert.deepEqual(Object.keys(items[0]), ['title', 'link', 'date']);
});

test('a missing cell or attribute is null, never undefined or ""', async () => {
  const items = await parse('<table><tr><td>Only</td><td>no link</td></tr><tr><td> </td></tr></table>');
  assert.deepEqual(items, [
    { title: 'Only', link: null, date: null },
    { title: null, link: null, date: null },
  ]);
});

test('resolve_url: relative and protocol-relative resolve; javascript: and mailto: are null', async () => {
  const spec = { mode: 'select', rows: 'a', fields: { link: { attr: 'href', resolve_url: true } } };
  const items = await parse(
    '<a href="x/y">1</a><a href="//cdn.test/z">2</a><a href="javascript:alert(1)">3</a><a href="mailto:a@b.test">4</a><a href="\\docs\\f.pdf">5</a>',
    { spec },
  );
  assert.deepEqual(items.map((i) => i.link), [
    'https://example.test/list/x/y', 'https://cdn.test/z', null, null, 'https://example.test/docs/f.pdf',
  ]);
});

test('entities and &nbsp; decode, and whitespace collapses to single spaces', async () => {
  const [item] = await parse('<table><tr><td>\n  Fish&nbsp;&amp;  Chips &#8211;\tnow\n</td></tr></table>');
  assert.equal(item.title, 'Fish & Chips – now');
});

test('a windows-1252 body labelled in Content-Type decodes correctly', async () => {
  const body = Buffer.concat([Buffer.from('<table><tr><td>caf'), Buffer.from([0xe9]), Buffer.from('</td></tr></table>')]);
  const [item] = await parse(body, { contentType: 'text/html; charset=windows-1252' });
  assert.equal(item.title, 'café');
});

test('a UTF-8 body with no charset anywhere is still UTF-8 (cheerio would default to windows-1252)', async () => {
  const [item] = await parse('<table><tr><td>café</td></tr></table>', { contentType: 'text/html' });
  assert.equal(item.title, 'café');
});

test('a meta charset is honoured when the header has none', async () => {
  const body = Buffer.concat([
    Buffer.from('<html><head><meta charset="windows-1251"></head><body><table><tr><td>'),
    Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
    Buffer.from('</td></tr></table></body></html>'),
  ]);
  const [item] = await parse(body, { contentType: null });
  assert.equal(item.title, 'Привет');
});

test('a UTF-8 BOM wins over a missing header', async () => {
  const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<table><tr><td>Ünïcode</td></tr></table>')]);
  const [item] = await parse(body, { contentType: 'text/html' });
  assert.equal(item.title, 'Ünïcode');
});

test('a table written without tbody still matches "table tr", and unclosed tags parse', async () => {
  const items = await parse('<table><tr><td>A<td><a href=/a>x</a><td>d1<tr><td>B<td><td>d2</table>');
  assert.deepEqual(items.map((i) => i.title), ['A', 'B']);
  assert.equal(items[0].link, 'https://example.test/a');
});

test('zero matching rows is an empty batch, not an error', async () => {
  assert.deepEqual(await parse('<p>Sorry, no notice matched this category.</p>'), []);
});

test('an unsupported pseudo-class in rows or a field is E_ADAPTER_INVALID naming where', async () => {
  await assert.rejects(parse('<table></table>', { spec: { ...SELECT, rows: 'td:focus' } }),
    { code: 'E_ADAPTER_INVALID', message: 'html.rows: invalid selector' });
  const badField = { ...SELECT, fields: { ...SELECT.fields, date: { selector: 'td:focus' } } };
  await assert.rejects(parse('<table><tr><td>x</td></tr></table>', { spec: badField }),
    { code: 'E_ADAPTER_INVALID', message: 'html.fields.date: invalid selector' });
  // Checked even when no row matched, so a broken field cannot hide behind an empty page.
  await assert.rejects(parse('<p>none</p>', { spec: badField }),
    { code: 'E_ADAPTER_INVALID', message: 'html.fields.date: invalid selector' });
});

test('validation accepts a well-formed html adapter', () => {
  const r = validateAdapter(adapterWith(SELECT));
  assert.equal(r.ok, true, r.errors.join(' | '));
});

test('validation rejects bad html blocks with specific messages', () => {
  const errorsFor = (html, extra) => validateAdapter(adapterWith(html, extra)).errors;
  assert.ok(errorsFor({ ...SELECT, colour: 'x' }).includes('html.colour: unknown key (a typo, or a field from a newer version)'));
  assert.ok(errorsFor({ ...SELECT, rows: '' }).includes('html.rows must be a nonempty string of at most 500 characters'));
  assert.ok(errorsFor({ ...SELECT, rows: 'a'.repeat(501) }).includes('html.rows must be a nonempty string of at most 500 characters'));
  assert.ok(errorsFor({ ...SELECT, fields: { t: { selector: 'a', attr: '' } } })
    .includes('html.fields.t.attr must be a nonempty string of at most 100 characters'));
  assert.ok(errorsFor({ ...SELECT, fields: { t: { selector: 'a', resolve_url: 'yes' } } })
    .includes('html.fields.t.resolve_url must be a boolean'));
  assert.ok(errorsFor({ ...SELECT, fields: { t: { selektor: 'a' } } })
    .includes('html.fields.t.selektor: unknown key (a typo, or a field from a newer version)'));
  assert.ok(errorsFor({ ...SELECT, fields: {} }).includes('html.fields must have 1-100 entries'));
  assert.ok(errorsFor({ ...SELECT, fields: JSON.parse('{"__proto__": {"selector": "a"}}') })
    .includes('html.fields must not use __proto__, constructor, or prototype'));
  assert.ok(errorsFor({ ...SELECT, mode: 'xpath' }).some((e) => e.startsWith('html.mode must be one of')));
  assert.ok(errorsFor(SELECT, { records_path: 'items' }).includes('records_path must be "$" when html.mode is "select"'));
  assert.ok(errorsFor(undefined).includes('html is required when access.kind is "html"'));
});

test('an html block on a non-html kind is rejected', () => {
  const r = validateAdapter({ ...adapterWith(SELECT), access: { tier: 1, kind: 'json-api', url: PAGE_URL } });
  assert.ok(r.errors.includes('html is only allowed when access.kind is "html"'), r.errors.join(' | '));
});

test('a missing cheerio is E_KIND_DEPENDENCY with the install command', async () => {
  _setCheerioLoaderForTest(async () => {
    const err = new Error("Cannot find package 'cheerio'");
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  });
  await assert.rejects(parse('<table></table>'), {
    code: 'E_KIND_DEPENDENCY',
    message: 'access.kind "html" needs the optional dependency cheerio: npm install cheerio',
  });
});

const NEXT_PAGE = `<html><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":"a","link":"https://example.test/a","title":"A"}]}}}</script>
</body></html>`;

test('script_json: __NEXT_DATA__ becomes the body that records_path walks', async () => {
  const spec = { mode: 'script_json', script: 'script#__NEXT_DATA__' };
  const body = await parse(NEXT_PAGE, { spec });
  assert.deepEqual(body.props.pageProps.items[0].title, 'A');
});

test('script_json: the right JSON-LD block is picked by content when several exist', async () => {
  const page = `<script type="application/ld+json">{"@type":"WebSite","name":"x"}</script>
<script type="application/ld+json">{"@type":"ItemList","itemListElement":[{"url":"https://example.test/1","name":"One"}]}</script>`;
  const spec = { mode: 'script_json', script: 'script[type="application/ld+json"]:contains("ItemList")' };
  const body = await parse(page, { spec });
  assert.equal(body.itemListElement[0].name, 'One');
});

test('script_json: no matching element is E_PARSE_NO_MATCH; broken JSON is E_RESPONSE_JSON', async () => {
  const spec = { mode: 'script_json', script: 'script#__NEXT_DATA__' };
  await assert.rejects(parse('<p>no script</p>', { spec }),
    { code: 'E_PARSE_NO_MATCH', message: 'html.script matched no element' });
  await assert.rejects(parse('<script id="__NEXT_DATA__">{"props":</script>', { spec }), { code: 'E_RESPONSE_JSON' });
  await assert.rejects(parse('<p></p>', { spec: { mode: 'script_json', script: 'script:focus' } }),
    { code: 'E_ADAPTER_INVALID', message: 'html.script: invalid selector' });
});

test('script_json validation: any records_path is allowed; script is required and bounded', () => {
  const ok = validateAdapter(adapterWith({ mode: 'script_json', script: 'script#__NEXT_DATA__' },
    { records_path: 'props.pageProps.items' }));
  assert.equal(ok.ok, true, ok.errors.join(' | '));
  const errorsFor = (html) => validateAdapter(adapterWith(html)).errors;
  assert.ok(errorsFor({ mode: 'script_json' }).includes('html.script must be a nonempty string of at most 500 characters'));
  assert.ok(errorsFor({ mode: 'script_json', script: 's', rows: 'tr' })
    .includes('html.rows: unknown key (a typo, or a field from a newer version)'));
});
