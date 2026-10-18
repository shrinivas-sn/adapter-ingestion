import { IngestionError } from '../errors.mjs';
import { decodeJson } from '../http.mjs';

// access.kind "html", driven entirely by CSS selectors in the adapter; nothing
// here knows about any particular site. Two modes:
//   select       one plain object per element matching `rows`
//   script_json  the JSON inside the first element matching `script`
//                (JSON-LD, __NEXT_DATA__, ...) becomes the body
//
// cheerio is an optional peer dependency, loaded on first use only, so a
// json-api-only consumer never needs it installed.

const MODES = ['select', 'script_json'];
const SELECT_KEYS = new Set(['mode', 'rows', 'fields']);
const SCRIPT_JSON_KEYS = new Set(['mode', 'script']);
const FIELD_KEYS = new Set(['selector', 'attr', 'resolve_url']);
// For the JSON Schema drift test (test/schema.test.mjs).
export const HTML_KNOWN_KEYS = Object.freeze({
  select: [...SELECT_KEYS].sort(),
  script_json: [...SCRIPT_JSON_KEYS].sort(),
  field: [...FIELD_KEYS].sort(),
});
const MAX_SELECTOR = 500;
const MAX_ATTR = 100;
const MAX_FIELDS = 100;
// Same set config.mjs guards map/required names with: a field named
// __proto__ would otherwise reach a plain-object assignment below.
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isBoundedString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function checkUnknownKeys(obj, known, label, need) {
  for (const key of Object.keys(obj)) {
    need(known.has(key), `${label}.${key}: unknown key (a typo, or a field from a newer version)`);
  }
}

function validate(adapter, need) {
  const html = adapter.html;
  need(isPlainObject(html), 'html is required when access.kind is "html"');
  if (!isPlainObject(html)) return;
  need(MODES.includes(html.mode), `html.mode must be one of ${MODES.join(', ')}`);
  if (html.mode === 'script_json') {
    // The script holds a whole document, so records_path walks it as usual.
    checkUnknownKeys(html, SCRIPT_JSON_KEYS, 'html', need);
    need(isBoundedString(html.script, MAX_SELECTOR), `html.script must be a nonempty string of at most ${MAX_SELECTOR} characters`);
    return;
  }
  if (html.mode !== 'select') return;

  checkUnknownKeys(html, SELECT_KEYS, 'html', need);
  need(isBoundedString(html.rows, MAX_SELECTOR), `html.rows must be a nonempty string of at most ${MAX_SELECTOR} characters`);
  // Each row is already one record; there is no wrapper to walk into.
  need(adapter.records_path === undefined || adapter.records_path === '$',
    'records_path must be "$" when html.mode is "select"');

  const fields = html.fields;
  need(isPlainObject(fields), 'html.fields must be an object of name -> rule');
  if (!isPlainObject(fields)) return;
  const names = Object.keys(fields);
  need(names.length >= 1 && names.length <= MAX_FIELDS, `html.fields must have 1-${MAX_FIELDS} entries`);
  need(!names.some((n) => RESERVED_NAMES.has(n)), 'html.fields must not use __proto__, constructor, or prototype');
  for (const name of names) {
    if (RESERVED_NAMES.has(name)) continue;
    const rule = fields[name];
    const label = `html.fields.${name}`;
    need(isPlainObject(rule), `${label} must be an object`);
    if (!isPlainObject(rule)) continue;
    checkUnknownKeys(rule, FIELD_KEYS, label, need);
    if (rule.selector !== undefined) {
      need(isBoundedString(rule.selector, MAX_SELECTOR), `${label}.selector must be a nonempty string of at most ${MAX_SELECTOR} characters`);
    }
    if (rule.attr !== undefined) {
      need(isBoundedString(rule.attr, MAX_ATTR), `${label}.attr must be a nonempty string of at most ${MAX_ATTR} characters`);
    }
    if (rule.resolve_url !== undefined) {
      need(typeof rule.resolve_url === 'boolean', `${label}.resolve_url must be a boolean`);
    }
  }
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
        'access.kind "html" needs the optional dependency cheerio: npm install cheerio', { cause: err });
    }
    throw err;
  }
  return cheerioModule;
}

// The charset parameter of Content-Type, if any. An unknown label is
// harmless: the encoding sniffer ignores it and falls back to BOM/meta.
function charsetOf(contentType) {
  if (typeof contentType !== 'string') return undefined;
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m ? m[1] : undefined;
}

// Selectors are compiled when used, so an unsupported pseudo-class or a
// syntax error surfaces here; it is the adapter's fault, not the page's.
function select(fn, label) {
  try {
    return fn();
  } catch {
    throw new IngestionError('E_ADAPTER_INVALID', `${label}: invalid selector`);
  }
}

function clean(value) {
  if (typeof value !== 'string') return null;
  // \s already covers U+00A0, which &nbsp; decodes to.
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

function resolveHttpUrl(value, base) {
  let u;
  try {
    u = new URL(value, base);
  } catch {
    return null;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
}

async function parse({ bytes, contentType, url, adapter, limits }) {
  const cheerio = await loadCheerio();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const charset = charsetOf(contentType);
  // defaultEncoding matters: with no BOM, meta or header label, cheerio
  // would otherwise decode as windows-1252 and turn UTF-8 text into mojibake.
  const $ = cheerio.loadBuffer(buffer, {
    encoding: { ...(charset ? { transportLayerEncodingLabel: charset } : {}), defaultEncoding: 'utf-8' },
  });

  if (adapter.html.mode === 'script_json') {
    const el = select(() => $(adapter.html.script).first(), 'html.script');
    if (el.length === 0) {
      throw new IngestionError('E_PARSE_NO_MATCH', 'html.script matched no element');
    }
    // Same decoder and E_RESPONSE_JSON as a json-api body.
    return decodeJson(Buffer.from(el.text(), 'utf8'));
  }

  const { rows, fields } = adapter.html;
  const fieldEntries = Object.entries(fields);
  const rowSet = select(() => $(rows), 'html.rows');
  // Each row becomes an object with one key per field, so a small page can
  // expand into a huge heap (millions of tiny <li> rows within the byte cap).
  // Refuse before building anything, with fetchAll's own max_records error.
  if (limits !== undefined && rowSet.length > limits.remainingRecords) {
    throw new IngestionError('E_RECORD_LIMIT', `fetch exceeded max_records (${limits.maxRecords})`);
  }
  // Compile every field selector once up front, so a broken one fails even
  // on a page where no row matched today.
  const probe = cheerio.load('');
  for (const [name, rule] of fieldEntries) {
    if (rule.selector !== undefined) select(() => probe(rule.selector), `html.fields.${name}`);
  }

  const items = [];
  rowSet.each((_, rowEl) => {
    const row = $(rowEl);
    const item = {};
    for (const [name, rule] of fieldEntries) {
      const el = rule.selector === undefined
        ? row
        : select(() => row.find(rule.selector).first(), `html.fields.${name}`);
      let value = el.length === 0 ? null : clean(rule.attr !== undefined ? el.attr(rule.attr) : el.text());
      if (value !== null && rule.resolve_url) value = resolveHttpUrl(value, url);
      item[name] = value;
    }
    items.push(item);
  });
  return items;
}

// 5 MB rather than the global 20 MB: parse5 builds a DOM roughly 100x the
// page size, so a hostile 20 MB page of tiny elements needs gigabytes.
// Real listing pages are well under 1 MB.
const defaults = Object.freeze({ max_response_bytes: 5_000_000 });

export const htmlKind = Object.freeze({ name: 'html', validate, parse, defaults });
