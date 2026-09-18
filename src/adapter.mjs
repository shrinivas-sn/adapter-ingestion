import { extractAll } from './extract.mjs';
import { validateAdapterConfig } from './config.mjs';

export function validateAdapter(adapter) {
  return validateAdapterConfig(adapter);
}

export function verifyAgainstFixtures(adapter, fixtureItems) {
  const { records, errors } = extractAll(fixtureItems, adapter,
    { fetchedAt: new Date(0).toISOString() });
  const fieldFailures = {};
  for (const e of errors) for (const f of e.missing) fieldFailures[f] = (fieldFailures[f] ?? 0) + 1;
  const total = fixtureItems.length;
  return { total, parsed: records.length, ratio: total ? records.length / total : 0, fieldFailures };
}
