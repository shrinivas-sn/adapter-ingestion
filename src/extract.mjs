import { applyNormalizer } from './normalize.mjs';
import { buildRecord, isValidSourceId, isValidSourceUrl } from './contract.mjs';
import { IngestionError } from './errors.mjs';

const MAX_ERROR_SAMPLES = 20;

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

// A blank/absent identity field is "missing"; a present-but-malformed one
// (wrong type, bad protocol, embedded credentials) is "invalid" — the two
// are different failure modes worth telling apart in a diagnostic sample.
function classifyIdentity(value, isValid) {
  if (isMissingRequiredValue(value)) return 'missing';
  return isValid(value) ? null : 'invalid';
}

function safeSourceId(v) {
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number') return String(v).slice(0, 200);
  return null;
}

function safeSourceUrl(v) {
  if (typeof v !== 'string' || v.length === 0) return null;
  try {
    const u = new URL(v);
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().slice(0, 500);
  } catch {
    return null;
  }
}

export function extractAll(rawItems, adapter, { fetchedAt }) {
  const records = [];
  const errors = [];
  let errorCount = 0;
  const fieldFailures = {};

  const recordFailure = (index, code, missing, invalid, sourceId, sourceUrl) => {
    errorCount++;
    for (const f of missing) fieldFailures[f] = (fieldFailures[f] ?? 0) + 1;
    for (const f of invalid) fieldFailures[f] = (fieldFailures[f] ?? 0) + 1;
    if (errors.length < MAX_ERROR_SAMPLES) {
      errors.push({
        index, code, missing: [...missing], invalid: [...invalid],
        source_id: safeSourceId(sourceId), source_url: safeSourceUrl(sourceUrl),
      });
    }
  };

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
    const invalid = new Set();

    const idClass = classifyIdentity(fields.source_id, isValidSourceId);
    if (idClass === 'missing') missing.add('source_id');
    else if (idClass === 'invalid') invalid.add('source_id');
    const urlClass = classifyIdentity(fields.url, isValidSourceUrl);
    if (urlClass === 'missing') missing.add('url');
    else if (urlClass === 'invalid') invalid.add('url');

    if (missing.size || invalid.size) {
      recordFailure(index, 'E_RECORD_INVALID', missing, invalid, fields.source_id, fields.url);
      return;
    }

    const { source_id: sourceId, url, ...rest } = fields;
    try {
      records.push(buildRecord({
        host: adapter.host, sourceId, sourceUrl: url,
        fields: { source_id: sourceId, url, ...rest }, raw: item, fetchedAt,
      }));
    } catch (err) {
      if (err instanceof IngestionError) {
        recordFailure(index, err.code, [], [], sourceId, url);
        return;
      }
      throw err;
    }
  });

  return { records, errors, errorCount, fieldFailures };
}
