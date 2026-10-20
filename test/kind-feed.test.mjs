import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { feedDate, feedKind, _setCheerioLoaderForTest } from '../src/kinds/feed.mjs';
import { resolveKind, validateKindsOption } from '../src/kinds/index.mjs';
import { validateAdapter } from '../src/adapter.mjs';

// access.kind "feed" (since 0.9): RSS 2.0, RSS 1.0 and Atom. Shapes come
// from real feeds (WordPress News, GitHub releases, Python Insider, BBC);
// values are invented.

test('feedDate reads RFC 822 dates as ISO UTC', () => {
  assert.equal(feedDate('Tue, 06 Oct 2026 17:00:00 +0000'), '2026-10-06T17:00:00.000Z');
  assert.equal(feedDate('Mon, 19 Oct 2026 21:12:30 GMT'), '2026-10-19T21:12:30.000Z');
  assert.equal(feedDate('6 Oct 2026 12:00 EST'), '2026-10-06T17:00:00.000Z');
  assert.equal(feedDate('Tue, 06 Oct 2026 17:00:00 +0530'), '2026-10-06T11:30:00.000Z');
  assert.equal(feedDate('  tue, 06 oct 2026 17:00:00 pdt  '), '2026-10-07T00:00:00.000Z');
});

test('feedDate reads ISO dates with a zone (Atom, dc:date)', () => {
  assert.equal(feedDate('2026-10-14T15:22:04Z'), '2026-10-14T15:22:04.000Z');
  assert.equal(feedDate('2026-10-14T15:22:04+02:00'), '2026-10-14T13:22:04.000Z');
});

test('feedDate gives null for anything it cannot read exactly', () => {
  for (const bad of [
    'Tue, 06 Oct 26 17:00:00 GMT', // two-digit year
    '31 Feb 2026 10:00:00 GMT',
    '06 Oct 2026 24:00:00 GMT',
    '06 Oct 2026 17:00:60 GMT',
    '06 Oct 2026 17:00:00 A', // military zone
    '06 Oct 2026 17:00:00 +2500',
    '2026-10-14T15:22:04', // no zone
    '', '  ', 42, undefined, null,
  ]) {
    assert.equal(feedDate(bad), null, String(bad));
  }
});

const FEED_URL = 'https://example.test/feed/';
const KEYS = ['author', 'categories', 'content', 'id', 'published', 'summary', 'title', 'updated', 'url'];

async function parse(xml, { contentType = 'application/rss+xml; charset=utf-8', limits = undefined } = {}) {
  const bytes = Buffer.isBuffer(xml) ? xml : Buffer.from(xml, 'utf8');
  return feedKind.parse({ bytes, contentType, url: FEED_URL, adapter: { access: { kind: 'feed' } }, limits });
}

const rejectsAsync = (p, code, pattern) => assert.rejects(p, (err) => {
  assert.equal(err.code, code);
  if (pattern) assert.match(err.message, pattern);
  return true;
});

const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel><title>Example</title><link>https://example.test/</link>${items}</channel></rss>`;

afterEach(() => _setCheerioLoaderForTest(undefined));

test('an RSS 2.0 item fills every key', async () => {
  const [item] = await parse(rss(`<item>
    <title><![CDATA[Release 7.1 & more]]></title>
    <link>https://example.test/news/release-7-1/</link>
    <dc:creator><![CDATA[Ana Lee]]></dc:creator>
    <pubDate>Tue, 06 Oct 2026 17:00:00 +0000</pubDate>
    <category><![CDATA[Releases]]></category><category>Security</category><category> </category>
    <guid isPermaLink="false">https://example.test/?p=123</guid>
    <description><![CDATA[<p>Short.</p>]]></description>
    <content:encoded><![CDATA[<p>Long body.</p>]]></content:encoded>
  </item>`));
  assert.deepEqual(item, {
    id: 'https://example.test/?p=123',
    url: 'https://example.test/news/release-7-1/',
    title: 'Release 7.1 & more',
    summary: '<p>Short.</p>',
    content: '<p>Long body.</p>',
    published: '2026-10-06T17:00:00.000Z',
    updated: null,
    author: 'Ana Lee',
    categories: ['Releases', 'Security'],
  });
});

test('RSS: no guid gives a null id; author wins over dc:creator', async () => {
  const [item] = await parse(rss(`<item><title>T</title><link>/rel</link>
    <author>ana@example.test (Ana)</author><dc:creator>Other</dc:creator></item>`));
  assert.equal(item.id, null);
  assert.equal(item.url, 'https://example.test/rel');
  assert.equal(item.author, 'ana@example.test (Ana)');
  assert.deepEqual(item.categories, []);
});

test('RSS: a permalink guid stands in for a missing link, a non-permalink does not', async () => {
  const items = await parse(rss(`
    <item><guid>https://example.test/a</guid></item>
    <item><guid isPermaLink="true">https://example.test/b</guid></item>
    <item><guid isPermaLink="false">https://example.test/c</guid></item>
    <item><guid>tag:example.test,2026:d</guid></item>`));
  assert.deepEqual(items.map((i) => i.url), ['https://example.test/a', 'https://example.test/b', null, null]);
  assert.deepEqual(items.map((i) => i.id),
    ['https://example.test/a', 'https://example.test/b', 'https://example.test/c', 'tag:example.test,2026:d']);
});

test('RSS 1.0 (RDF): items are siblings of channel; dc:date is read', async () => {
  const items = await parse(`<?xml version="1.0"?>
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel rdf:about="https://example.test/"><title>Ex</title></channel>
    <item rdf:about="https://example.test/1"><title>One</title><link>https://example.test/1</link>
      <dc:date>2026-10-01T08:00:00+01:00</dc:date></item>
    <item rdf:about="https://example.test/2"><title>Two</title><link>https://example.test/2</link></item>
  </rdf:RDF>`);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'One');
  assert.equal(items[0].published, '2026-10-01T07:00:00.000Z');
  assert.equal(items[1].published, null);
});

const atom = (entries, feedAuthor = '') => `<?xml version="1.0" encoding="UTF-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom"><id>tag:example.test,2026:feed</id><title>Ex</title>
  <updated>2026-10-14T15:15:32Z</updated>${feedAuthor}${entries}</feed>`;

test('an Atom entry fills every key; the alternate html link wins over self', async () => {
  const [item] = await parse(atom(`<entry>
    <id>tag:example.test,2026:Repository/1/v26.12.0</id>
    <updated>2026-10-14T15:22:04Z</updated><published>2026-10-14T15:00:00+02:00</published>
    <link rel="self" type="application/atom+xml" href="https://example.test/self"/>
    <link rel="alternate" type="application/json" href="https://example.test/json"/>
    <link rel="alternate" type="text/html" href="https://example.test/releases/tag/v26.12.0"/>
    <title>v26.12.0</title><summary>Notes</summary>
    <content type="html">&lt;p&gt;Body&lt;/p&gt;</content>
    <author><name>octo</name></author>
    <category term="release"/><category term="lts"/><category label="no term"/>
  </entry>`), { contentType: 'application/atom+xml; charset=utf-8' });
  assert.deepEqual(item, {
    id: 'tag:example.test,2026:Repository/1/v26.12.0',
    url: 'https://example.test/releases/tag/v26.12.0',
    title: 'v26.12.0',
    summary: 'Notes',
    content: '<p>Body</p>',
    published: '2026-10-14T13:00:00.000Z',
    updated: '2026-10-14T15:22:04.000Z',
    author: 'octo',
    categories: ['release', 'lts'],
  });
});

test('Atom: a link without rel is the alternate; relative hrefs resolve; javascript: is dropped', async () => {
  const items = await parse(atom(`
    <entry><id>a</id><link href="/x"/></entry>
    <entry><id>b</id><link rel="alternate" href="javascript:alert(1)"/></entry>
    <entry><id>c</id><link rel="enclosure" href="https://example.test/file.mp3"/></entry>`));
  assert.deepEqual(items.map((i) => i.url), ['https://example.test/x', null, null]);
});

test('Atom: xhtml content keeps its markup; a missing entry author falls back to the feed author', async () => {
  const [item] = await parse(atom(`<entry><id>a</id>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Hi <b>there</b></p></div></content>
  </entry>`, '<author><name>Feed Team</name></author>'));
  assert.equal(item.content, '<div xmlns="http://www.w3.org/1999/xhtml"><p>Hi <b>there</b></p></div>');
  assert.equal(item.author, 'Feed Team');
});

test('every item has exactly the nine keys, in every format', async () => {
  const all = [
    ...await parse(rss('<item/>')),
    ...await parse(atom('<entry/>')),
    ...await parse('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><item/></rdf:RDF>'),
  ];
  assert.equal(all.length, 3);
  for (const item of all) assert.deepEqual(Object.keys(item).sort(), KEYS);
});

test('an empty feed gives no items', async () => {
  assert.deepEqual(await parse('<rss version="2.0"><channel><title>Quiet</title></channel></rss>'), []);
  assert.deepEqual(await parse(atom('')), []);
});

test('a root that is not a feed is E_PARSE naming the root', async () => {
  await rejectsAsync(parse('<!doctype html><html><body>Not found</body></html>'), 'E_PARSE',
    /^feed: the root element is <html>, not rss, rdf:RDF or feed$/);
  await rejectsAsync(parse(''), 'E_PARSE', /root element is \(none\)/);
  await rejectsAsync(parse('just text'), 'E_PARSE', /root element is \(none\)/);
});

test('encodings: BOM, Content-Type charset, then the XML declaration, else UTF-8', async () => {
  const title = async (bytes, contentType) => (await parse(bytes, { contentType }))[0].title;
  const head = (decl) => Buffer.from(`${decl}<rss><channel><item><title>caf`);
  const tail = Buffer.from('</title></item></channel></rss>');
  const e9 = Buffer.from([0xe9]);
  const utf8E = Buffer.from('é');
  assert.equal(await title(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), head(''), utf8E, tail]), 'text/xml'), 'café');
  assert.equal(await title(Buffer.concat([head(''), e9, tail]), 'text/xml; charset=iso-8859-1'), 'café');
  assert.equal(await title(Buffer.concat([head('<?xml version="1.0" encoding="ISO-8859-1"?>'), e9, tail]),
    'application/octet-stream'), 'café');
  assert.equal(await title(Buffer.concat([head(''), utf8E, tail]), undefined), 'café');
  await rejectsAsync(parse(rss('<item/>'), { contentType: 'text/xml; charset=bogus-xyz' }), 'E_PARSE',
    /unknown encoding "bogus-xyz"/);
});

test('DTD entities are never expanded and external entities never read', async () => {
  const [item] = await parse(`<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "AAAA"><!ENTITY b "&a;&a;&a;">
    <!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&b; &x; &amp; &#233;</title></item></channel></rss>`);
  assert.equal(item.title, '&b; &x; & é');
});

test('more items than max_records allows is E_RECORD_LIMIT before building any', async () => {
  await rejectsAsync(parse(rss('<item/><item/>'), { limits: { maxRecords: 1, remainingRecords: 1 } }),
    'E_RECORD_LIMIT', /^fetch exceeded max_records \(1\)$/);
  assert.equal((await parse(rss('<item/>'), { limits: { maxRecords: 1, remainingRecords: 1 } })).length, 1);
});

test('a missing cheerio is E_KIND_DEPENDENCY with the install command', async () => {
  _setCheerioLoaderForTest(async () => { throw Object.assign(new Error('nope'), { code: 'ERR_MODULE_NOT_FOUND' }); });
  await rejectsAsync(parse(rss('<item/>')), 'E_KIND_DEPENDENCY',
    /^access\.kind "feed" needs the optional dependency cheerio: npm install cheerio$/);
});

test('validate: records_path must be absent or "$"', () => {
  const errors = [];
  const need = (ok, msg) => { if (!ok) errors.push(msg); };
  feedKind.validate({ records_path: '$' }, need);
  feedKind.validate({}, need);
  assert.deepEqual(errors, []);
  feedKind.validate({ records_path: 'items' }, need);
  assert.deepEqual(errors, ['records_path must be "$" when access.kind is "feed"']);
});

const WORDPRESS = {
  version: 1,
  host: 'wordpress.org',
  access: { tier: 0, kind: 'feed', url: 'https://wordpress.org/news/feed/' },
  map: {
    source_id: { path: 'id' },
    url: { path: 'url' },
    title: { path: 'title', normalize: 'text' },
    published: { path: 'published', normalize: 'iso-datetime' },
  },
  required: ['source_id', 'url', 'title'],
};

test('feed is a built-in kind: the spec adapter validates', () => {
  assert.deepEqual(validateAdapter(WORDPRESS), { ok: true, errors: [] });
  const bad = validateAdapter({ ...WORDPRESS, records_path: 'x' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes('records_path must be "$" when access.kind is "feed"'), bad.errors.join(' | '));
});

test('a caller kind registered as feed still wins over the built-in', () => {
  const callerKind = { parse: async () => [] };
  assert.equal(resolveKind('feed'), feedKind);
  assert.doesNotThrow(() => validateKindsOption({ feed: callerKind }));
  const resolved = resolveKind('feed', { feed: callerKind });
  assert.notEqual(resolved, feedKind);
  assert.equal(resolved.name, 'feed');
});
