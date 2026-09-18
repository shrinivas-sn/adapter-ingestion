import { extractAll } from './extract.mjs';
import { validateAdapterConfig } from './config.mjs';

export function validateAdapter(adapter) {
  return validateAdapterConfig(adapter);
}

export function verifyAgainstFixtures(adapter, fixtureItems) {
  // Uses extractAll's full counters, not its (now capped at 20) error
  // samples — a fixture set larger than the sample cap must still report
  // an accurate ratio and complete per-field failure breakdown.
  const { records, fieldFailures } = extractAll(fixtureItems, adapter,
    { fetchedAt: new Date(0).toISOString() });
  const total = fixtureItems.length;
  return { total, parsed: records.length, ratio: total ? records.length / total : 0, fieldFailures };
}
