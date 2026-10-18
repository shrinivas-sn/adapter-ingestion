import { extractAll } from './extract.mjs';
import { validateAdapterConfig } from './config.mjs';

// `kinds` registers caller-defined source kinds (see runIngest's kinds option).
// A null/absent second argument is ignored, as it was before the option existed.
/**
 * Validate an adapter without touching the network. Never throws.
 * @param {any} adapter
 * @param {{ kinds?: Record<string, import('./types.mjs').Kind> } | null} [options]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAdapter(adapter, options) {
  return validateAdapterConfig(adapter, { kinds: options?.kinds });
}

/**
 * @param {import('./types.mjs').Adapter} adapter
 * @param {any[]} fixtureItems
 * @returns {{ total: number, parsed: number, ratio: number, fieldFailures: Record<string, number> }}
 */
export function verifyAgainstFixtures(adapter, fixtureItems) {
  // Uses extractAll's full counters, not its (now capped at 20) error
  // samples — a fixture set larger than the sample cap must still report
  // an accurate ratio and complete per-field failure breakdown.
  const { records, fieldFailures } = extractAll(fixtureItems, adapter,
    { fetchedAt: new Date(0).toISOString() });
  const total = fixtureItems.length;
  return { total, parsed: records.length, ratio: total ? records.length / total : 0, fieldFailures };
}
