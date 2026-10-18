// Within-source only. Cross-source fuzzy matching (the same listing on several
// portals) is deliberately out of scope for v1 — see SPEC §3.
/**
 * @param {import('./types.mjs').StoreRecord[]} records
 * @param {Map<string, string>} index
 * @returns {{ fresh: import('./types.mjs').StoreRecord[], changed: import('./types.mjs').StoreRecord[], unchanged: import('./types.mjs').StoreRecord[] }}
 */
export function splitByIndex(records, index) {
  const collapsed = new Map();
  for (const r of records) collapsed.set(r.id, r);

  const fresh = [], changed = [], unchanged = [];
  for (const r of collapsed.values()) {
    if (!index.has(r.id)) fresh.push(r);
    else if (index.get(r.id) !== r.content_hash) changed.push(r);
    else unchanged.push(r);
  }
  return { fresh, changed, unchanged };
}
