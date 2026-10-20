import { isValidPathString, pathHasReservedSegment } from './config.mjs';
import { getPath } from './extract.mjs';

// A map rule's `template` (since 0.8): "{entity}:{year}" or
// "https://example.org/item/{id}". Validation and extraction both go through
// parseTemplate, so the engine can never accept a template it would then
// read differently.

export const MAX_TEMPLATE_LENGTH = 2000;
export const MAX_PLACEHOLDERS = 20;

const URL_TEMPLATE_RE = /^https?:\/\//i;

/** @param {string} p */
const shown = (p) => p.slice(0, 100);

/**
 * @param {any} template
 * @returns {{ ok: true, parts: Array<{ text: string } | { path: string }>, isUrl: boolean } | { ok: false, error: string }}
 */
export function parseTemplate(template) {
  if (typeof template !== 'string' || template.length === 0 || template.length > MAX_TEMPLATE_LENGTH) {
    return { ok: false, error: `must be a nonempty string of at most ${MAX_TEMPLATE_LENGTH} characters` };
  }
  /** @type {Array<{ text: string } | { path: string }>} */
  const parts = [];
  let placeholders = 0;
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('{', i);
    const close = template.indexOf('}', i);
    // A "}" before the next "{" closes nothing.
    if (close !== -1 && (open === -1 || close < open)) {
      return { ok: false, error: 'has an unmatched "{" or "}"' };
    }
    if (open === -1) {
      parts.push({ text: template.slice(i) });
      break;
    }
    if (open > i) parts.push({ text: template.slice(i, open) });
    const end = template.indexOf('}', open + 1);
    const nested = template.indexOf('{', open + 1);
    if (end === -1 || (nested !== -1 && nested < end)) {
      return { ok: false, error: 'has an unmatched "{" or "}"' };
    }
    const path = template.slice(open + 1, end);
    if (path.length === 0) return { ok: false, error: 'has an empty placeholder "{}"' };
    if (path === '$' || !isValidPathString(path)) {
      return { ok: false, error: `placeholder "{${shown(path)}}" must be nonempty dot segments, not "$"` };
    }
    if (pathHasReservedSegment(path)) {
      return { ok: false, error: `placeholder "{${shown(path)}}" must not use __proto__, constructor, or prototype` };
    }
    placeholders++;
    if (placeholders > MAX_PLACEHOLDERS) {
      return { ok: false, error: `has more than ${MAX_PLACEHOLDERS} placeholders` };
    }
    parts.push({ path });
    i = end + 1;
  }

  const isUrl = URL_TEMPLATE_RE.test(template);
  if (isUrl) {
    // The scheme and host are literal, so no value can change which site
    // the link points to.
    const afterScheme = template.slice(template.indexOf('://') + 3);
    const authority = afterScheme.split(/[/?#]/, 1)[0];
    if (authority.includes('{')) {
      return { ok: false, error: 'must keep the scheme and host literal (no placeholder before the first "/", "?" or "#" after "://")' };
    }
    const sample = parts.map((p) => ('text' in p ? p.text : 'x')).join('');
    try {
      // eslint-disable-next-line no-new -- the URL parser is the authority on what parses.
      new URL(sample);
    } catch {
      return { ok: false, error: 'must be an http(s) URL once filled in' };
    }
  }
  return { ok: true, parts, isUrl };
}

/**
 * Builds the value, or null when any placeholder has no usable value: a
 * half-built id or link would be wrong without anyone noticing.
 * @param {Array<{ text: string } | { path: string }>} parts
 * @param {boolean} isUrl
 * @param {any} item
 * @returns {string | null}
 */
export function renderTemplate(parts, isUrl, item) {
  let out = '';
  for (const part of parts) {
    if ('text' in part) {
      out += part.text;
      continue;
    }
    const v = getPath(item, part.path);
    let s;
    if (typeof v === 'string' && v.trim() !== '') s = v;
    else if (typeof v === 'number' && Number.isFinite(v)) s = String(v);
    else return null;
    // "/" stays so an id like "org/name" keeps its path shape; the host is
    // literal, so it cannot move the link to another site.
    out += isUrl ? encodeURIComponent(s).replaceAll('%2F', '/') : s;
  }
  return out;
}
