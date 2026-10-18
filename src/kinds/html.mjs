import { IngestionError } from '../errors.mjs';

// access.kind "html": server-rendered pages turned into one plain object per
// matching row, driven entirely by CSS selectors in the adapter. Nothing here
// knows about any particular site.
//
// cheerio is an optional peer dependency, loaded on first use only, so a
// json-api-only consumer never needs it installed.

const MODES = ['select'];
const SELECT_KEYS = new Set(['mode', 'rows', 'fields']);
const FIELD_KEYS = new Set(['selector', 'attr', 'resolve_url']);
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
  return typeof v === 'string' && v.length > 0 && v.length <= max;
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

async function parse({ bytes, contentType, url, adapter }) {
  const cheerio = await loadCheerio();
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const charset = charsetOf(contentType);
  // defaultEncoding matters: with no BOM, meta or header label, cheerio
  // would otherwise decode as windows-1252 and turn UTF-8 text into mojibake.
  const $ = cheerio.loadBuffer(buffer, {
    encoding: { ...(charset ? { transportLayerEncodingLabel: charset } : {}), defaultEncoding: 'utf-8' },
  });

  const { rows, fields } = adapter.html;
  const fieldEntries = Object.entries(fields);
  const rowSet = select(() => $(rows), 'html.rows');
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

export const htmlKind = Object.freeze({ name: 'html', validate, parse });
