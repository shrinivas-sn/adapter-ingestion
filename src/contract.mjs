import { createHash } from 'node:crypto';
import { IngestionError } from './errors.mjs';

const MAX_FIELD_DEPTH = 100;

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function contentHash(fields) {
  return createHash('sha256').update(canonicalize(fields)).digest('hex');
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function containerKeys(v) {
  return Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
}

// A missing value must be null, never undefined — an undefined field can cause a
// document store to silently reject the entire write. See SPEC §4.
//
// Direct callers (not extractAll, which pre-filters against parsed JSON) can
// pass arbitrary JS values here, so this also rejects functions/symbols/
// bigint/non-finite numbers/non-plain objects/cycles, and bounds nesting to
// MAX_FIELD_DEPTH so a pathological direct-JS structure can't blow the call
// stack. Iterative, not recursive, for the same reason: depth is bounded by
// data, not by how deep a recursive call can safely go.
export function assertNoUndefined(root, rootPath = '$') {
  if (root === undefined) throw new IngestionError('E_RECORD_INVALID', `undefined value at ${rootPath}`);
  if (root === null || typeof root !== 'object') return;
  if (!Array.isArray(root) && !isPlainObject(root)) {
    throw new IngestionError('E_RECORD_INVALID', `non-plain object at ${rootPath}`);
  }

  const onPath = new Set([root]);
  const stack = [{ value: root, keys: containerKeys(root), idx: 0, path: rootPath, depth: 1 }];

  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.idx >= frame.keys.length) {
      onPath.delete(frame.value);
      stack.pop();
      continue;
    }
    const key = frame.keys[frame.idx++];
    const child = frame.value[key];
    const childPath = Array.isArray(frame.value) ? `${frame.path}[${key}]` : `${frame.path}.${key}`;

    if (child === undefined) throw new IngestionError('E_RECORD_INVALID', `undefined value at ${childPath}`);
    if (child === null) continue;
    const t = typeof child;
    if (t === 'function' || t === 'symbol' || t === 'bigint') {
      throw new IngestionError('E_RECORD_INVALID', `unsupported ${t} at ${childPath}`);
    }
    if (t === 'number' && !Number.isFinite(child)) {
      throw new IngestionError('E_RECORD_INVALID', `non-finite number at ${childPath}`);
    }
    if (t === 'object') {
      if (onPath.has(child)) throw new IngestionError('E_RECORD_INVALID', `circular reference at ${childPath}`);
      if (!Array.isArray(child) && !isPlainObject(child)) {
        throw new IngestionError('E_RECORD_INVALID', `non-plain object at ${childPath}`);
      }
      const depth = frame.depth + 1;
      if (depth > MAX_FIELD_DEPTH) {
        throw new IngestionError('E_RECORD_INVALID', `nesting exceeds ${MAX_FIELD_DEPTH} at ${childPath}`);
      }
      onPath.add(child);
      stack.push({ value: child, keys: containerKeys(child), idx: 0, path: childPath, depth });
    }
  }
}

// source_id: a non-whitespace-only string, or a finite number. Zero is valid;
// null/undefined/boolean/object/array/Infinity/NaN are not.
export function isValidSourceId(v) {
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return v.trim() !== '';
  return false;
}

// source_url: a nonempty absolute http(s) URL with no embedded credentials.
// Cross-host deep links are allowed — this is not a provenance check (that
// lives in config.mjs, comparing adapter.access.url against adapter.host).
export function isValidSourceUrl(v) {
  if (typeof v !== 'string' || v.length === 0) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
}

function isValidIsoTimestamp(v) {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

export function buildRecord({ host, sourceId, sourceUrl, fields, raw, fetchedAt }) {
  if (!isValidSourceId(sourceId)) {
    throw new IngestionError('E_RECORD_INVALID',
      'source_id must be a non-whitespace string or a finite number', { details: { sourceId } });
  }
  if (!isValidSourceUrl(sourceUrl)) {
    throw new IngestionError('E_RECORD_INVALID',
      'source_url must be a nonempty absolute http(s) URL without credentials', { details: { sourceUrl } });
  }
  if (!isValidIsoTimestamp(fetchedAt)) {
    throw new IngestionError('E_RECORD_INVALID', 'fetched_at must be a valid ISO timestamp');
  }
  assertNoUndefined(fields, '$.fields');
  return {
    id: `${host}:${sourceId}`,
    source_host: host,
    source_url: sourceUrl,
    fetched_at: fetchedAt,
    content_hash: contentHash(fields),
    fields,
    raw: raw ?? null,
  };
}
