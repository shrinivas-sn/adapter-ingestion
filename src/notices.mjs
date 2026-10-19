// Notices tell a project what this engine version offers its adapter
// (advice, A_*) and what it will stop accepting (deprecation, D_*). They are
// information only: never a change to a run's outcome, exit code, records or
// canary. The same rules run inside runIngest (with run facts) and offline in
// `adapter-ingestion doctor`.
//
// A message names adapter keys only -- never a value, URL or header -- so a
// notice is always safe to log.

import { KNOWN_KEYS } from './config.mjs';

export const NOTICE_LIMIT = 20;

const DOCS = 'https://github.com/shrinivas-sn/adapter-ingestion/blob/main/README.md';

// The optional settings the engine reads at run time: a misspelled one is
// silently ignored, so the typo notice checks these. Validation already
// rejects a missing required key or a bad html block, and $schema is
// editor-only.
export const TYPO_CHECKED_KEYS = Object.freeze(['canary', 'fetch', 'records_path', 'required']);

/**
 * Optimal string alignment distance: insert, delete, substitute and
 * adjacent transposition each cost 1.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
  /** @type {number[][]} */
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The key as a printable-ASCII JSON string: logs stay one line, and a
 * lookalike character (a Cyrillic letter, say) shows as \uXXXX.
 * @param {string} key
 * @returns {string}
 */
function quoteKey(key) {
  return JSON.stringify(key)
    .replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The setting an unknown top-level key probably meant, or null.
 * @param {Record<string, unknown>} adapter
 * @param {string} key
 * @returns {string | null}
 */
function suggestSetting(adapter, key) {
  if (KNOWN_KEYS.top_level.includes(key) || key.startsWith('_') || key.length > 64) return null;
  /** @param {string} s */
  const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, '');
  const nk = norm(key);
  let best = null;
  let bestDistance = Infinity;
  for (const k of TYPO_CHECKED_KEYS) {
    // The real setting is already there, so this key is something else.
    if (adapter[k] !== undefined && adapter[k] !== null) continue;
    const nn = norm(k);
    if (Math.abs(nk.length - nn.length) > 1) continue;
    const d = nk === nn ? 0 : editDistance(nk, nn);
    if (d <= 1 && d < bestDistance) {
      best = k;
      bestDistance = d;
    }
  }
  return best;
}

// rule.check(adapter, facts) -> [{ path?, message }]. facts is null when no
// run facts exist (an offline check with nothing to go on, or a run that
// failed before the canary); a rule that needs facts returns [] then.
export const RULES = Object.freeze([
  {
    code: 'A_CANARY_NO_HISTORY',
    kind: 'advice',
    since: '0.4.0',
    docs: `${DOCS}#canary-history-on-ci`,
    check(adapter, facts) {
      if (facts?.mode !== 'snapshot' || facts.historyCount !== 0 || facts.usesHistoryFile === true) return [];
      return [{
        path: 'canary.count_drop_ratio',
        message: 'count_drop_ratio has no comparable past runs to compare with. On CI with a fresh checkout this happens on every run; set paths.historyFile (CLI: --history) to a file you commit.',
      }];
    },
  },
  {
    code: 'A_TOP_LEVEL_KEY_TYPO',
    kind: 'advice',
    since: '0.5.0',
    docs: `${DOCS}#writing-an-adapter-by-hand`,
    check(adapter) {
      if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) return [];
      /** @type {{ path: string, message: string }[]} */
      const hits = [];
      for (const key of Object.keys(adapter)) {
        const suggestion = suggestSetting(adapter, key);
        if (suggestion !== null) {
          hits.push({
            path: key,
            message: `${quoteKey(key)} is not an adapter key, so it is ignored. Did you mean "${suggestion}"? If it is your own note, start its name with "_".`,
          });
        }
        // Leave other notices room under NOTICE_LIMIT.
        if (hits.length >= 10) break;
      }
      return hits;
    },
  },
]);

function toNotice(rule, hit) {
  const notice = { code: rule.code, kind: rule.kind, message: hit.message, since: rule.since, docs: rule.docs };
  if (rule.removed_in !== undefined) notice.removed_in = rule.removed_in;
  if (hit.path !== undefined) notice.path = hit.path;
  return notice;
}

export function collectNotices(adapter, facts = null, rules = RULES) {
  const byKey = new Map();
  for (const rule of rules) {
    let hits;
    try {
      hits = rule.check(adapter, facts);
    } catch {
      // A broken rule must never fail an ingestion run; it just says nothing.
      continue;
    }
    for (const hit of hits ?? []) {
      const key = `${rule.code}\u0000${hit.path ?? ''}`;
      if (!byKey.has(key)) byKey.set(key, toNotice(rule, hit));
    }
  }
  // Plain code-unit order, never locale order: reports must sort the same
  // on every machine.
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  return [...byKey.values()]
    .sort((a, b) => cmp(a.code, b.code) || cmp(a.path ?? '', b.path ?? ''))
    .slice(0, NOTICE_LIMIT);
}
