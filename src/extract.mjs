import { applyNormalizer } from './normalize.mjs';
import { buildRecord, isValidSourceId, isValidSourceUrl } from './contract.mjs';
import { IngestionError } from './errors.mjs';

// Own properties only. A naive `cur[seg]` bracket read falls through to the
// prototype chain for any segment an object doesn't itself have (e.g.
// "constructor" resolving to a live constructor function, or "__proto__"
// resolving to the real [[Prototype]] when no own key shadows it) — both a
// correctness bug (unexpected non-JSON values reaching fields) and a
// pollution surface. Object.hasOwn gates every step; a JSON.parse-created
// own "__proto__" key is read like any other own key, and an absent one
// stays absent instead of leaking the prototype.
export function getPath(obj, path) {
  if (path === '$') return obj;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function isMissingRequiredValue(v) {
  if (v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

export function extractAll(rawItems, adapter, { fetchedAt }) {
  const records = [];
  const errors = [];
  rawItems.forEach((item, index) => {
    const fields = {};
    for (const [name, rule] of Object.entries(adapter.map)) {
      const raw = getPath(item, rule.path);
      const value = rule.normalize ? applyNormalizer(rule.normalize, raw) : (raw ?? null);
      fields[name] = value === undefined ? null : value;
    }

    // Identity and URL are always required, independently of adapter.required
    // (SPEC §3.3) — an adapter author leaving them off `required` must not be
    // able to let unrelated records collapse onto one another.
    const missing = new Set(
      (adapter.required ?? []).filter((f) => isMissingRequiredValue(fields[f])),
    );
    if (!isValidSourceId(fields.source_id)) missing.add('source_id');
    if (!isValidSourceUrl(fields.url)) missing.add('url');

    if (missing.size) { errors.push({ index, missing: [...missing] }); return; }

    const { source_id: sourceId, url, ...rest } = fields;
    try {
      records.push(buildRecord({
        host: adapter.host, sourceId, sourceUrl: url,
        fields: { source_id: sourceId, url, ...rest }, raw: item, fetchedAt,
      }));
    } catch (err) {
      if (err instanceof IngestionError) { errors.push({ index, missing: [] }); return; }
      throw err;
    }
  });
  return { records, errors };
}
