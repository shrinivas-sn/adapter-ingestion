import { extractAll } from './extract.mjs';

const KNOWN_NORMALIZERS = new Set(['text', 'number', 'iso-date', 'bool']);
const KINDS = new Set(['json-api', 'feed', 'html', 'browser']);
const MANDATORY_MAP_KEYS = ['source_id', 'url'];

export function validateAdapter(adapter) {
  const errors = [];
  const need = (cond, msg) => { if (!cond) errors.push(msg); };

  need(adapter?.version === 1, 'version must be 1');
  need(typeof adapter?.host === 'string' && adapter.host, 'host is required');
  need(Number.isInteger(adapter?.access?.tier), 'access.tier must be an integer');
  need(KINDS.has(adapter?.access?.kind), `access.kind must be one of ${[...KINDS].join(', ')}`);
  need(typeof adapter?.access?.url === 'string', 'access.url is required');
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
