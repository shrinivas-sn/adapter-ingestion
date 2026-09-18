import { isValidDateOnly } from './normalize.mjs';

const KNOWN_NORMALIZERS = new Set(['text', 'number', 'iso-date', 'bool']);
// json-api only: feed/html/browser are excluded from this release (see plan.md
// section 1.3) and must fail validation, not silently pass through to a fetch
// layer that can only parse JSON.
const KINDS = new Set(['json-api']);
const MANDATORY_MAP_KEYS = ['source_id', 'url'];
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_HOST_BASENAME = /^(CON|NUL|AUX|PRN|COM[1-9]|LPT[1-9])$/i;
// adapter.host is interpolated straight into store/<host>.jsonl and
// runs/<host>/ paths (run.mjs). A bare hostname can never contain a path
// separator or a traversal segment, so this doubles as the filesystem-safety
// check without a second, path-specific rule.
const BARE_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

const KNOWN_ACCESS_KEYS = new Set(['tier', 'kind', 'url']);
const KNOWN_FETCH_KEYS = new Set([
  'method', 'headers', 'timeout_ms', 'max_duration_ms', 'max_records',
  'max_response_bytes', 'max_total_bytes', 'delay_ms', 'pagination',
  'incremental', 'retry',
]);
const KNOWN_PAGINATION_KEYS = new Set(['style', 'param', 'max_pages', 'per_page', 'per_page_param', 'allow_truncation']);
const KNOWN_INCREMENTAL_KEYS = new Set(['param', 'type']);
const KNOWN_RETRY_KEYS = new Set(['max_attempts', 'backoff_ms', 'max_delay_ms']);
const KNOWN_MAP_RULE_KEYS = new Set(['path', 'normalize']);
const KNOWN_CANARY_KEYS = new Set([
  'min_records', 'median_window', 'count_drop_ratio', 'required_field_ratio',
  'max_staleness_days', 'staleness_field',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const isSafeInt = (v) => Number.isSafeInteger(v);
const inIntRange = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function checkUnknownKeys(obj, known, label, need) {
  if (!isPlainObject(obj)) return;
  for (const key of Object.keys(obj)) {
    need(known.has(key), `${label}.${key}: unknown key (typo?)`);
  }
}

function hasReservedHostBasename(host) {
  // Windows treats everything up to the first dot as the basename for the
  // reserved-device-name check, so "CON.example.com" is just as unusable as
  // "CON" for a directory name -- checking only the first label is correct,
  // not a shortcut.
  return RESERVED_HOST_BASENAME.test(host.split('.')[0]);
}

function pathHasReservedSegment(path) {
  if (typeof path !== 'string' || path === '$') return false;
  return path.split('.').some((seg) => RESERVED_NAMES.has(seg));
}

function isValidPathString(path) {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path === '$') return true;
  return path.split('.').every((seg) => seg.length > 0);
}

function validateAccessSection(adapter, need, { requireTier }) {
  const access = adapter.access;
  need(isPlainObject(access), 'access is required');
  if (!isPlainObject(access)) return;
  checkUnknownKeys(access, KNOWN_ACCESS_KEYS, 'access', need);
  if (requireTier) {
    need(inIntRange(access.tier, 0, 5), 'access.tier must be an integer 0-5');
  }
  need(KINDS.has(access.kind), `access.kind must be one of ${[...KINDS].join(', ')}`);
  need(typeof access.url === 'string', 'access.url is required');
  if (typeof access.url === 'string') {
    let u;
    try {
      u = new URL(access.url);
    } catch {
      need(false, 'access.url must be a valid URL');
    }
    if (u) {
      need(u.protocol === 'http:' || u.protocol === 'https:', 'access.url must be http or https');
      need(!u.username && !u.password, 'access.url must not contain credentials');
      // A mismatch here means source_host/id (contract.mjs) would lie about
      // where a record actually came from -- the provenance guarantee this
      // whole framework exists to keep.
      need(
        !adapter.host || u.hostname === adapter.host || u.hostname.endsWith(`.${adapter.host}`),
        'access.url hostname must equal adapter.host, or be a subdomain of it',
      );
    }
  }
}

function validatePaginationSection(fetchCfg, need) {
  const p = fetchCfg?.pagination;
  if (p === undefined) return;
  need(isPlainObject(p), 'fetch.pagination must be an object');
  if (!isPlainObject(p)) return;
  checkUnknownKeys(p, KNOWN_PAGINATION_KEYS, 'fetch.pagination', need);
  need(p.style === 'page-param', 'fetch.pagination.style must be "page-param"');
  need(typeof p.param === 'string' && p.param.length > 0, 'fetch.pagination.param must be a nonempty string');
  if (p.max_pages !== undefined) {
    need(isSafeInt(p.max_pages) && p.max_pages > 0, 'fetch.pagination.max_pages must be a positive safe integer');
  }
  if (p.per_page !== undefined) {
    need(isSafeInt(p.per_page) && p.per_page > 0, 'fetch.pagination.per_page must be a positive safe integer');
  }
  if (p.per_page_param !== undefined) {
    need(typeof p.per_page_param === 'string' && p.per_page_param.length > 0,
      'fetch.pagination.per_page_param must be a nonempty string');
    need(p.per_page !== undefined, 'fetch.pagination.per_page_param requires per_page to be set');
    if (typeof p.param === 'string') {
      need(p.per_page_param !== p.param, 'fetch.pagination.per_page_param must differ from param');
    }
  }
  if (p.allow_truncation !== undefined) {
    need(typeof p.allow_truncation === 'boolean', 'fetch.pagination.allow_truncation must be a boolean');
  }
}

function validateIncrementalSection(fetchCfg, need) {
  const inc = fetchCfg?.incremental;
  if (inc === undefined) return;
  need(isPlainObject(inc), 'fetch.incremental must be an object');
  if (!isPlainObject(inc)) return;
  checkUnknownKeys(inc, KNOWN_INCREMENTAL_KEYS, 'fetch.incremental', need);
  need(typeof inc.param === 'string' && inc.param.length > 0, 'fetch.incremental.param must be a nonempty string');
  need(inc.type === 'iso-date', 'fetch.incremental.type must be "iso-date"');
  const p = fetchCfg?.pagination;
  if (isPlainObject(p) && typeof inc.param === 'string') {
    need(inc.param !== p.param, 'fetch.incremental.param must not collide with fetch.pagination.param');
    need(inc.param !== p.per_page_param, 'fetch.incremental.param must not collide with fetch.pagination.per_page_param');
  }
}

function validateRetrySection(fetchCfg, need) {
  const r = fetchCfg?.retry;
  if (r === undefined) return;
  need(isPlainObject(r), 'fetch.retry must be an object');
  if (!isPlainObject(r)) return;
  checkUnknownKeys(r, KNOWN_RETRY_KEYS, 'fetch.retry', need);
  if (r.max_attempts !== undefined) {
    need(inIntRange(r.max_attempts, 1, 5), 'fetch.retry.max_attempts must be an integer 1-5');
  }
  if (r.backoff_ms !== undefined) {
    need(inIntRange(r.backoff_ms, 0, 60_000), 'fetch.retry.backoff_ms must be an integer 0-60000');
  }
  if (r.max_delay_ms !== undefined) {
    need(inIntRange(r.max_delay_ms, 0, 60_000), 'fetch.retry.max_delay_ms must be an integer 0-60000');
  }
  if (r.backoff_ms !== undefined && r.max_delay_ms !== undefined) {
    need(r.max_delay_ms >= r.backoff_ms, 'fetch.retry.max_delay_ms must be >= backoff_ms');
  }
}

function validateFetchSection(adapter, need) {
  const f = adapter.fetch;
  if (f === undefined) return;
  need(isPlainObject(f), 'fetch must be an object');
  if (!isPlainObject(f)) return;
  checkUnknownKeys(f, KNOWN_FETCH_KEYS, 'fetch', need);
  if (f.method !== undefined) need(f.method === 'GET', 'fetch.method must be omitted or exactly GET');
  if (f.headers !== undefined) {
    need(isPlainObject(f.headers), 'fetch.headers must be a plain object');
    if (isPlainObject(f.headers)) {
      for (const [k, v] of Object.entries(f.headers)) {
        need(typeof v === 'string', `fetch.headers.${k} must be a string`);
      }
      try {
        // eslint-disable-next-line no-new -- native Headers is the source of
        // truth for what a valid header name/value actually is.
        new Headers(f.headers);
      } catch {
        need(false, 'fetch.headers must be a valid header map');
      }
    }
  }
  if (f.timeout_ms !== undefined) {
    need(inIntRange(f.timeout_ms, 1, 2_147_483_647), 'fetch.timeout_ms must be an integer 1-2147483647');
  }
  if (f.max_duration_ms !== undefined) {
    need(inIntRange(f.max_duration_ms, 1, 2_147_483_647), 'fetch.max_duration_ms must be an integer 1-2147483647');
  }
  if (f.max_records !== undefined) {
    need(isSafeInt(f.max_records) && f.max_records > 0, 'fetch.max_records must be a positive safe integer');
  }
  if (f.max_response_bytes !== undefined) {
    need(isSafeInt(f.max_response_bytes) && f.max_response_bytes > 0,
      'fetch.max_response_bytes must be a positive safe integer');
  }
  if (f.max_total_bytes !== undefined) {
    need(isSafeInt(f.max_total_bytes) && f.max_total_bytes > 0,
      'fetch.max_total_bytes must be a positive safe integer');
  }
  if (f.delay_ms !== undefined) {
    need(inIntRange(f.delay_ms, 0, 2_147_483_647), 'fetch.delay_ms must be an integer 0-2147483647');
  }
  validatePaginationSection(f, need);
  validateIncrementalSection(f, need);
  validateRetrySection(f, need);
}

function validateRecordsPath(adapter, need) {
  if (adapter.records_path === undefined) return;
  need(isValidPathString(adapter.records_path), 'records_path must be "$" or nonempty dot segments');
  need(!pathHasReservedSegment(adapter.records_path),
    'records_path must not use __proto__, constructor, or prototype');
}

function validateMap(adapter, need) {
  need(isPlainObject(adapter.map) && Object.keys(adapter.map).length > 0, 'map is required');
  if (!isPlainObject(adapter.map)) return;

  for (const key of Object.keys(adapter.map)) {
    need(!RESERVED_NAMES.has(key), `map.${key}: field name must not be __proto__, constructor, or prototype`);
  }
  for (const key of MANDATORY_MAP_KEYS) {
    need(adapter.map[key], `map.${key} is mandatory — the record contract requires it`);
  }
  for (const [name, rule] of Object.entries(adapter.map)) {
    need(isPlainObject(rule), `map.${name} must be an object`);
    if (!isPlainObject(rule)) continue;
    checkUnknownKeys(rule, KNOWN_MAP_RULE_KEYS, `map.${name}`, need);
    need(typeof rule.path === 'string' && rule.path.length > 0, `map.${name}.path is required`);
    if (typeof rule.path === 'string' && rule.path.length > 0) {
      need(isValidPathString(rule.path), `map.${name}.path must be "$" or nonempty dot segments`);
      need(!pathHasReservedSegment(rule.path),
        `map.${name}.path must not use __proto__, constructor, or prototype`);
    }
    if (rule.normalize !== undefined) {
      need(KNOWN_NORMALIZERS.has(rule.normalize), `map.${name}: unknown normalizer "${rule.normalize}"`);
    }
  }
}

function validateRequired(adapter, need) {
  if (adapter.required === undefined) return;
  need(Array.isArray(adapter.required), 'required must be an array');
  if (!Array.isArray(adapter.required)) return;
  need(adapter.required.every((f) => typeof f === 'string' && f.length > 0), 'required must contain nonempty strings');
  need(new Set(adapter.required).size === adapter.required.length, 'required must not contain duplicate field names');
  if (isPlainObject(adapter.map)) {
    for (const f of adapter.required) {
      if (typeof f === 'string') need(Boolean(adapter.map[f]), `required field "${f}" has no map entry`);
    }
  }
}

function validateCanary(adapter, need) {
  if (adapter.canary === undefined) return;
  need(isPlainObject(adapter.canary), 'canary must be an object');
  if (!isPlainObject(adapter.canary)) return;
  const c = adapter.canary;
  checkUnknownKeys(c, KNOWN_CANARY_KEYS, 'canary', need);
  if (c.min_records !== undefined) {
    need(isSafeInt(c.min_records) && c.min_records >= 0, 'canary.min_records must be a nonnegative safe integer');
  }
  if (c.median_window !== undefined) {
    need(inIntRange(c.median_window, 1, 100), 'canary.median_window must be an integer 1-100');
  }
  if (c.count_drop_ratio !== undefined) {
    need(isFiniteNum(c.count_drop_ratio) && c.count_drop_ratio >= 0 && c.count_drop_ratio <= 1,
      'canary.count_drop_ratio must be a finite number 0-1');
  }
  if (c.required_field_ratio !== undefined) {
    need(isFiniteNum(c.required_field_ratio) && c.required_field_ratio >= 0 && c.required_field_ratio <= 1,
      'canary.required_field_ratio must be a finite number 0-1');
  }
  const hasMax = c.max_staleness_days !== undefined;
  const hasField = c.staleness_field !== undefined;
  need(hasMax === hasField, 'canary.max_staleness_days and canary.staleness_field must both be set or both omitted');
  if (hasMax) {
    need(isFiniteNum(c.max_staleness_days) && c.max_staleness_days > 0,
      'canary.max_staleness_days must be a finite number > 0');
  }
  if (hasField) {
    need(typeof c.staleness_field === 'string' && isPlainObject(adapter.map) && Boolean(adapter.map?.[c.staleness_field]),
      'canary.staleness_field must name a field in map');
  }
}

export function validateAdapterConfig(adapter) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!isPlainObject(adapter)) {
    return { ok: false, errors: ['adapter must be an object'] };
  }

  need(adapter.version === 1, 'version must be 1');
  need(typeof adapter.host === 'string' && adapter.host.length > 0, 'host is required');
  if (typeof adapter.host === 'string' && adapter.host) {
    need(adapter.host.length <= 253, 'host must be at most 253 characters');
    need(BARE_HOSTNAME.test(adapter.host), 'host must be a bare hostname, no path separators or traversal segments');
    need(!hasReservedHostBasename(adapter.host),
      'host must not use a Windows reserved device name (CON/NUL/AUX/PRN/COM1-9/LPT1-9)');
  }

  validateAccessSection(adapter, need, { requireTier: true });
  validateFetchSection(adapter, need);
  validateRecordsPath(adapter, need);
  validateMap(adapter, need);
  validateRequired(adapter, need);
  validateCanary(adapter, need);

  return { ok: errors.length === 0, errors };
}

export function validateFetchConfig(adapter, { since } = {}) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  if (!isPlainObject(adapter)) {
    return { ok: false, errors: ['adapter must be an object'] };
  }

  validateAccessSection(adapter, need, { requireTier: false });
  validateFetchSection(adapter, need);

  if (since !== undefined) {
    need(typeof since === 'string' && since.length > 0 && isValidDateOnly(since),
      'since must be a valid nonempty YYYY-MM-DD date');
    need(isPlainObject(adapter.fetch?.incremental), 'since requires fetch.incremental to be configured');
  }

  return { ok: errors.length === 0, errors };
}
