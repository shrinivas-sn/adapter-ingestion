import { applyNormalizer } from './normalize.mjs';
import { buildRecord } from './contract.mjs';

export function getPath(obj, path) {
  if (path === '$') return obj;
  let cur = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
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
    const missing = (adapter.required ?? []).filter(
      (f) => fields[f] === null || fields[f] === '',
    );
    if (missing.length) { errors.push({ index, missing }); return; }
    const { source_id: sourceId, url, ...rest } = fields;
    records.push(buildRecord({
      host: adapter.host, sourceId, sourceUrl: url,
      fields: { source_id: sourceId, url, ...rest }, raw: item, fetchedAt,
    }));
  });
  return { records, errors };
}
