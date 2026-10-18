// Notices tell a project what this engine version offers its adapter
// (advice, A_*) and what it will stop accepting (deprecation, D_*). They are
// information only: never a change to a run's outcome, exit code, records or
// canary. The same rules run inside runIngest (with run facts) and offline in
// `adapter-ingestion doctor`.
//
// A message names adapter keys only -- never a value, URL or header -- so a
// notice is always safe to log.

export const NOTICE_LIMIT = 20;

const DOCS = 'https://github.com/shrinivas-sn/adapter-ingestion/blob/main/README.md';

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
