import { getPath } from './extract.mjs';
import { isValidPathString, pathHasReservedSegment } from './config.mjs';
import { isValidDateOnly } from './normalize.mjs';
import { IngestionError } from './errors.mjs';

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

const KNOWN_OPS = new Set(Object.keys(OPS));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isJsonPrimitive = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function validateRuleShape(rule, need) {
  if (!isPlainObject(rule)) { need(false, 'rule must be an object'); return; }

  need(typeof rule.field === 'string' && rule.field.length > 0, 'field is required');
  if (typeof rule.field === 'string' && rule.field.length > 0) {
    need(isValidPathString(rule.field), 'field must be "$" or nonempty dot segments');
    need(!pathHasReservedSegment(rule.field), 'field must not use __proto__, constructor, or prototype');
  }

  need(KNOWN_OPS.has(rule.op), `op must be one of ${[...KNOWN_OPS].join(', ')}`);
  if (!KNOWN_OPS.has(rule.op)) return;

  const knownKeys = rule.op === 'between'
    ? new Set(['field', 'op', 'min', 'max'])
    : new Set(['field', 'op', 'value']);
  for (const key of Object.keys(rule)) {
    need(knownKeys.has(key), `${key}: unknown key for op "${rule.op}"`);
  }

  switch (rule.op) {
    case 'any_of':
    case 'none_of':
      need(Array.isArray(rule.value) && rule.value.every(isJsonPrimitive),
        `value must be an array of JSON primitives for op "${rule.op}"`);
      break;
    case 'includes_any':
    case 'excludes_any':
      need(Array.isArray(rule.value) && rule.value.every((x) => typeof x === 'string'),
        `value must be an array of strings for op "${rule.op}"`);
      break;
    case 'gte':
    case 'lte':
      need(isFiniteNum(rule.value), `value must be a finite number for op "${rule.op}"`);
      break;
    case 'between':
      need(isFiniteNum(rule.min) && isFiniteNum(rule.max), 'min and max must both be finite numbers');
      if (isFiniteNum(rule.min) && isFiniteNum(rule.max)) {
        need(rule.min <= rule.max, 'min must be <= max');
      }
      break;
    case 'within_days':
      need(Number.isInteger(rule.value) && rule.value >= 0, 'value must be a nonnegative integer for within_days');
      break;
    case 'after_date':
      need(isValidDateOnly(rule.value), 'value must be a valid YYYY-MM-DD date for after_date');
      break;
    case 'exists':
      need(typeof rule.value === 'boolean', 'value must be a boolean for exists');
      break;
    default:
      break;
  }
}

export function validateFilter(filterDef) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!isPlainObject(filterDef)) return { ok: false, errors: ['filter must be an object'] };

  if (filterDef.version !== undefined) need(filterDef.version === 1, 'version must be 1');
  if (filterDef.mode !== undefined) {
    need(filterDef.mode === 'all' || filterDef.mode === 'any', 'mode must be "all" or "any"');
  }
  need(Array.isArray(filterDef.rules), 'rules must be an array');
  if (Array.isArray(filterDef.rules)) {
    filterDef.rules.forEach((rule, i) => {
      validateRuleShape(rule, (cond, msg) => need(cond, `rules[${i}]: ${msg}`));
    });
  }

  return { ok: errors.length === 0, errors };
}

function assertValidNow(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IngestionError('E_OPTIONS', 'now must be a valid Date');
  }
}

export function evaluateRule(record, rule, now = new Date()) {
  const errors = [];
  validateRuleShape(rule, (cond, msg) => { if (!cond) errors.push(msg); });
  if (errors.length) {
    throw new IngestionError('E_FILTER_INVALID', `invalid rule: ${errors.join('; ')}`, { details: { errors } });
  }
  assertValidNow(now);

  const fn = OPS[rule.op];
  const value = getPath(record, rule.field);
  const missing = value === undefined || value === null;
  if (missing) return PASSES_WHEN_MISSING.has(rule.op) || (rule.op === 'exists' && rule.value === false);
  return fn(value, rule, now);
}

export function applyFilter(records, filterDef, now = new Date()) {
  const { ok, errors } = validateFilter(filterDef);
  if (!ok) {
    throw new IngestionError('E_FILTER_INVALID', `invalid filter: ${errors.join('; ')}`, { details: { errors } });
  }
  assertValidNow(now);

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
