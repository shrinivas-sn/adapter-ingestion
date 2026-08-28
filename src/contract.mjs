import { createHash } from 'node:crypto';

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

export function contentHash(fields) {
  return createHash('sha256').update(canonicalize(fields)).digest('hex');
}

// A missing value must be null, never undefined — an undefined field can cause a
// document store to silently reject the entire write. See SPEC §4.
export function assertNoUndefined(obj, path = '$') {
  if (obj === undefined) throw new Error(`undefined value at ${path}`);
  if (obj === null || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) assertNoUndefined(v, `${path}.${k}`);
}

export function buildRecord({ host, sourceId, sourceUrl, fields, raw, fetchedAt }) {
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
