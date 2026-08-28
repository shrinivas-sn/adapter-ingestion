import { getPath } from './extract.mjs';

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const dayStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

// Rules that are satisfied by absence. Everything else fails on a missing field:
// absence is not a match, but absence IS the absence of a disqualifier. SPEC §6.
const PASSES_WHEN_MISSING = new Set(['none_of', 'excludes_any']);

const OPS = {
  any_of:       (v, r) => asArray(v).some((x) => r.value.includes(x)),
  none_of:      (v, r) => !asArray(v).some((x) => r.value.includes(x)),
  between:      (v, r) => typeof v === 'number' && v >= r.min && v <= r.max,
  gte:          (v, r) => typeof v === 'number' && v >= r.value,
  lte:          (v, r) => typeof v === 'number' && v <= r.value,
  includes_any: (v, r) => r.value.some((w) => String(v).toLowerCase().includes(w.toLowerCase())),
  excludes_any: (v, r) => !r.value.some((w) => String(v).toLowerCase().includes(w.toLowerCase())),
  exists:       (v, r) => (r.value === false ? v === null : v !== null),
  within_days:  (v, r, now) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    if (Number.isNaN(t)) return false;
    const limit = dayStart(now) + r.value * 86400000;
    return t >= dayStart(now) && t <= limit;
  },
  after_date:   (v, r) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return !Number.isNaN(t) && t >= Date.parse(`${r.value}T00:00:00Z`);
  },
};

export function evaluateRule(record, rule, now) {
  const fn = OPS[rule.op];
  if (!fn) throw new Error(`unknown filter op: ${rule.op}`);
  const value = getPath(record, rule.field);
  const missing = value === undefined || value === null;
  if (missing) return PASSES_WHEN_MISSING.has(rule.op) || (rule.op === 'exists' && rule.value === false);
  return fn(value, rule, now);
}

export function applyFilter(records, filterDef, now = new Date()) {
  const mode = filterDef.mode ?? 'all';
  const kept = [];
  const dropped = [];
  for (const record of records) {
    const failed = filterDef.rules.filter((r) => !evaluateRule(record, r, now));
    const passes = mode === 'all' ? failed.length === 0 : failed.length < filterDef.rules.length;
    if (passes) kept.push(record);
    else dropped.push({ id: record.id, failed });
  }
  return { kept, dropped };
}
