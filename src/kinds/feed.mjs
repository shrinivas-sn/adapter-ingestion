import { IngestionError } from '../errors.mjs';
import { applyNormalizer } from '../normalize.mjs';

// access.kind "feed" (since 0.9): RSS 2.0, RSS 1.0 (RDF) and Atom 1.0, read
// into one item shape so one adapter map works for any feed. Nothing here
// knows any site. Every item has exactly these keys:
//   id, url, title, summary, content, published, updated, author, categories
// Strings are trimmed and empty ones are null; categories is an array; the
// two dates are ISO 8601 UTC or null.
//
// cheerio is an optional peer dependency, loaded on first use only, as for
// the html kind. Its XML mode never expands DTD entities, so a feed cannot
// grow itself (billion laughs) or read a local file (external entities).

// RFC 822 as RSS uses it: optional weekday, D Mon YYYY HH:MM[:SS] zone.
// Two-digit years and military zones are refused rather than guessed.
const RFC822_RE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-]\d{4})$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONES = Object.freeze({
  gmt: '+00:00', utc: '+00:00', ut: '+00:00', z: '+00:00',
  est: '-05:00', edt: '-04:00', cst: '-06:00', cdt: '-05:00',
  mst: '-07:00', mdt: '-06:00', pst: '-08:00', pdt: '-07:00',
});

/**
 * An item date as ISO 8601 UTC, or null. RFC 822 is rewritten as an ISO
 * string with an offset and handed to iso-datetime, so every range check
 * (day in month, hour, minute, second, offset) is the normalizer's own.
 * The weekday is not checked against the date.
 * @param {unknown} value
 * @returns {string | null}
 */
export function feedDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  const m = RFC822_RE.exec(s);
  if (!m) return applyNormalizer('iso-datetime', s);
  const [, day, mon, year, hour, minute, second = '00', zone] = m;
  const month = String(MONTHS.indexOf(mon.toLowerCase()) + 1).padStart(2, '0');
  const offset = ZONES[zone.toLowerCase()] ?? `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return applyNormalizer('iso-datetime', `${year}-${month}-${day.padStart(2, '0')}T${hour}:${minute}:${second}${offset}`);
}

let loadCheerioModule = () => import('cheerio');
let cheerioModule = null;

// Tests swap the loader to simulate a consumer without the optional peer;
// undefined restores the real import. Not part of the public API.
export function _setCheerioLoaderForTest(loader) {
  loadCheerioModule = loader ?? (() => import('cheerio'));
  cheerioModule = null;
}

async function loadCheerio() {
  if (cheerioModule) return cheerioModule;
  try {
    cheerioModule = await loadCheerioModule();
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new IngestionError('E_KIND_DEPENDENCY',
        'access.kind "feed" needs the optional dependency cheerio: npm install cheerio', { cause: err });
    }
    throw err;
  }
  return cheerioModule;
}

function validate(adapter, need) {
  // The body is already the array of items; there is no wrapper to walk into.
  need(adapter.records_path === undefined || adapter.records_path === '$',
    'records_path must be "$" when access.kind is "feed"');
}

const XML_DECL_RE = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/;

// The charset parameter of Content-Type, if any (same rule as the html kind).
function charsetOf(contentType) {
  if (typeof contentType !== 'string') return undefined;
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1] : undefined;
}

// BOM, then the transport's charset, then the XML declaration, then UTF-8.
// Decoding is lenient like the html kind: one stray byte in a CMS feed
// becomes U+FFFD instead of failing the run.
function decode(buffer, contentType) {
  let label;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) label = 'utf-8';
  else if (buffer[0] === 0xff && buffer[1] === 0xfe) label = 'utf-16le';
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) label = 'utf-16be';
  else label = charsetOf(contentType) ?? XML_DECL_RE.exec(buffer.subarray(0, 1024).toString('latin1'))?.[1] ?? 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(label);
  } catch {
    throw new IngestionError('E_PARSE', `feed: unknown encoding "${label}"`);
  }
  return decoder.decode(buffer);
}

function elementChildren(el) {
  return (el?.children ?? []).filter((c) => c.type === 'tag');
}

function child(el, name) {
  return elementChildren(el).find((c) => c.name === name);
}

function childrenNamed(el, name) {
  return elementChildren(el).filter((c) => c.name === name);
}

function clean(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s;
}

function resolveHttpUrl(value, base) {
  if (value === null) return null;
  let u;
  try {
    u = new URL(value, base);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

function rssItem($, el, base) {
  const text = (name) => {
    const c = child(el, name);
    return c === undefined ? null : clean($(c).text());
  };
  const guidEl = child(el, 'guid');
  const guid = text('guid');
  // RSS 2.0: a guid is a permalink unless it says isPermaLink="false".
  const guidIsLink = guidEl !== undefined && $(guidEl).attr('isPermaLink') !== 'false';
  return {
    id: guid,
    url: resolveHttpUrl(text('link') ?? (guidIsLink ? guid : null), base),
    title: text('title'),
    summary: text('description'),
    content: text('content:encoded'),
    published: feedDate(text('pubDate') ?? text('dc:date')),
    updated: null,
    author: text('author') ?? text('dc:creator'),
    categories: childrenNamed(el, 'category').map((c) => clean($(c).text())).filter((v) => v !== null),
  };
}

function atomAuthor($, el) {
  const name = child(child(el, 'author'), 'name');
  return name === undefined ? null : clean($(name).text());
}

// The entry's page: a link with no rel or rel="alternate", an html one first.
function atomLink($, el) {
  const alternates = childrenNamed(el, 'link').filter((c) => {
    const rel = $(c).attr('rel');
    return rel === undefined || rel === 'alternate';
  });
  const html = alternates.find((c) => $(c).attr('type') === 'text/html');
  const link = html ?? alternates[0];
  return link === undefined ? null : clean($(link).attr('href'));
}

function atomEntry($, el, base, feedAuthor) {
  const text = (name) => {
    const c = child(el, name);
    return c === undefined ? null : clean($(c).text());
  };
  const contentEl = child(el, 'content');
  let content = null;
  if (contentEl !== undefined) {
    content = clean($(contentEl).attr('type') === 'xhtml' ? $(contentEl).html() : $(contentEl).text());
  }
  return {
    id: text('id'),
    url: resolveHttpUrl(atomLink($, el), base),
    title: text('title'),
    summary: text('summary'),
    content,
    published: feedDate(text('published')),
    updated: feedDate(text('updated')),
    author: atomAuthor($, el) ?? feedAuthor,
    categories: childrenNamed(el, 'category').map((c) => clean($(c).attr('term'))).filter((v) => v !== null),
  };
}

async function parse({ bytes, contentType, url, limits }) {
  const cheerio = await loadCheerio();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const $ = cheerio.load(decode(buffer, contentType), { xml: true });
  const root = $.root().children().get(0);
  const rootName = root?.name;

  let items;
  if (rootName === 'rss') items = childrenNamed(child(root, 'channel'), 'item');
  else if (rootName === 'rdf:RDF') items = childrenNamed(root, 'item');
  else if (rootName === 'feed') items = childrenNamed(root, 'entry');
  else {
    throw new IngestionError('E_PARSE',
      `feed: the root element is ${rootName === undefined ? '(none)' : `<${rootName}>`}, not rss, rdf:RDF or feed`);
  }
  // Refuse before building anything, with fetchAll's own max_records error.
  if (limits !== undefined && items.length > limits.remainingRecords) {
    throw new IngestionError('E_RECORD_LIMIT', `fetch exceeded max_records (${limits.maxRecords})`);
  }
  if (rootName === 'feed') {
    const feedAuthor = atomAuthor($, root);
    return items.map((el) => atomEntry($, el, url, feedAuthor));
  }
  return items.map((el) => rssItem($, el, url));
}

// 5 MB as for html: the XML DOM is many times the feed's size. The largest
// real sample (a GitHub releases feed) is 0.7 MB.
const defaults = Object.freeze({ max_response_bytes: 5_000_000 });

export const feedKind = Object.freeze({ name: 'feed', validate, parse, defaults });
