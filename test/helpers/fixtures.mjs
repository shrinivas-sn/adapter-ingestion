import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPath } from '../../src/extract.mjs';
import { applyNormalizer, isValidDateOnly } from '../../src/normalize.mjs';

export const baseAdapter = {
  version: 1, host: 'example.test',
  access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' },
    title: { path: 'title', normalize: 'text' } },
  required: ['title'],
};

export const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), { status: 200, ...init });

export async function tempPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'adapter-ingestion-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
}

// Loads a real recorded adapter and its recorded fixture the same way
// scripts/verify-earthquake-adapter.mjs does -- Task 10's fixture-replay
// tests exercise real recorded config/data, not hand-authored stand-ins.
export async function loadAdapterFixture(host) {
  const adapter = JSON.parse(await readFile(`adapters/${host}.adapter.json`, 'utf8'));
  const fixtureRoot = JSON.parse(await readFile(adapter.fixtures[0], 'utf8'));
  return { adapter, fixtureRoot };
}

// The plan requires runIngest's logical `now` to be chosen explicitly from
// the fixture's own newest mapped staleness value (never a disabled
// freshness check) -- this walks the adapter's real map/normalize rule for
// canary.staleness_field, the same transform extractAll itself would apply,
// rather than re-deriving each fixture's newest timestamp by hand.
export function newestStalenessInstant(adapter, fixtureRoot) {
  const rawItems = getPath(fixtureRoot, adapter.records_path ?? '$');
  const rule = adapter.map[adapter.canary.staleness_field];
  let best = null;
  for (const item of rawItems) {
    const raw = getPath(item, rule.path);
    const value = rule.normalize ? applyNormalizer(rule.normalize, raw) : raw;
    if (value === null || value === undefined) continue;
    const instant = typeof value === 'number' ? value
      : isValidDateOnly(value) ? Date.parse(`${value}T00:00:00Z`)
      : Date.parse(value);
    if (!Number.isFinite(instant)) continue;
    if (best === null || instant > best) best = instant;
  }
  return best;
}
