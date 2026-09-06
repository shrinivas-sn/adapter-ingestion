import { extractAll } from './extract.mjs';

const KNOWN_NORMALIZERS = new Set(['text', 'number', 'iso-date', 'bool']);
const KINDS = new Set(['json-api', 'feed', 'html', 'browser']);
const MANDATORY_MAP_KEYS = ['source_id', 'url'];
const KNOWN_CANARY_KEYS = new Set([
  'min_records', 'median_window', 'count_drop_ratio', 'required_field_ratio',
  'max_staleness_days', 'staleness_field',
]);
// adapter.host is interpolated straight into store/<host>.jsonl and
// runs/<host>/ paths (run.mjs). A bare hostname can never contain a path
// separator or a traversal segment, so this doubles as the filesystem-safety
// check without a second, path-specific rule.
const BARE_HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function validateAdapter(adapter) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(adapter?.version === 1, 'version must be 1');
  need(typeof adapter?.host === 'string' && adapter.host, 'host is required');
  if (typeof adapter?.host === 'string' && adapter.host) {
    need(BARE_HOSTNAME.test(adapter.host), 'host must be a bare hostname, no path separators or traversal segments');
  }
  need(Number.isInteger(adapter?.access?.tier), 'access.tier must be an integer');
  need(KINDS.has(adapter?.access?.kind), `access.kind must be one of ${[...KINDS].join(', ')}`);
  need(typeof adapter?.access?.url === 'string', 'access.url is required');
  if (typeof adapter?.access?.url === 'string') {
    try {
      const u = new URL(adapter.access.url);
      need(u.protocol === 'http:' || u.protocol === 'https:', 'access.url must be http or https');
      // A mismatch here means source_host/id (contract.mjs) would lie about
      // where a record actually came from -- the provenance guarantee this
      // whole framework exists to keep.
      need(
        !adapter.host || u.hostname === adapter.host || u.hostname.endsWith(`.${adapter.host}`),
        'access.url hostname must equal adapter.host, or be a subdomain of it',
      );
    } catch {
      errors.push('access.url must be a valid URL');
    }
  }
  need(adapter?.map && typeof adapter.map === 'object', 'map is required');

  if (adapter?.map) {
    for (const key of MANDATORY_MAP_KEYS) {
      need(adapter.map[key], `map.${key} is mandatory — the record contract requires it`);
    }
    for (const [name, rule] of Object.entries(adapter.map)) {
      need(typeof rule?.path === 'string', `map.${name}.path is required`);
      if (rule?.normalize) {
        need(KNOWN_NORMALIZERS.has(rule.normalize),
          `map.${name}: unknown normalizer "${rule.normalize}"`);
      }
    }
    for (const f of adapter.required ?? []) {
      need(adapter.map[f], `required field "${f}" has no map entry`);
    }
  }

  if (adapter?.canary && typeof adapter.canary === 'object') {
    for (const key of Object.keys(adapter.canary)) {
      need(KNOWN_CANARY_KEYS.has(key), `canary.${key}: unknown key (typo?)`);
    }
    const hasMax = adapter.canary.max_staleness_days !== undefined;
    const hasField = adapter.canary.staleness_field !== undefined;
    need(hasMax === hasField, 'canary.max_staleness_days and canary.staleness_field must both be set or both omitted');
    if (hasField) {
      need(adapter.map?.[adapter.canary.staleness_field], 'canary.staleness_field must name a field in map');
    }
  }

  return { ok: errors.length === 0, errors };
}

export function verifyAgainstFixtures(adapter, fixtureItems) {
  const { records, errors } = extractAll(fixtureItems, adapter,
    { fetchedAt: new Date(0).toISOString() });
  const fieldFailures = {};
  for (const e of errors) for (const f of e.missing) fieldFailures[f] = (fieldFailures[f] ?? 0) + 1;
  const total = fixtureItems.length;
  return { total, parsed: records.length, ratio: total ? records.length / total : 0, fieldFailures };
}
