import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotices, RULES, NOTICE_LIMIT } from '../src/notices.mjs';

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' } },
};

const NO_HISTORY = 'A_CANARY_NO_HISTORY';

test('notices: A_CANARY_NO_HISTORY fires for a snapshot run with no history and no history file', () => {
  const notices = collectNotices(adapter, { mode: 'snapshot', historyCount: 0, usesHistoryFile: false });
  assert.deepEqual(notices, [{
    code: NO_HISTORY,
    kind: 'advice',
    message: 'count_drop_ratio has no comparable past runs to compare with. On CI with a fresh checkout this happens on every run; set paths.historyFile (CLI: --history) to a file you commit.',
    since: '0.4.0',
    docs: 'https://github.com/shrinivas-sn/adapter-ingestion/blob/main/README.md#canary-history-on-ci',
    path: 'canary.count_drop_ratio',
  }]);
});

test('notices: A_CANARY_NO_HISTORY stays quiet when history exists, a history file is used, or the run is incremental', () => {
  assert.deepEqual(collectNotices(adapter, { mode: 'snapshot', historyCount: 1, usesHistoryFile: false }), []);
  assert.deepEqual(collectNotices(adapter, { mode: 'snapshot', historyCount: 0, usesHistoryFile: true }), []);
  assert.deepEqual(collectNotices(adapter, { mode: 'incremental', historyCount: 0, usesHistoryFile: false }), []);
});

test('notices: no run facts means only adapter-level rules run (none fire today)', () => {
  assert.deepEqual(collectNotices(adapter, null), []);
  assert.deepEqual(collectNotices(adapter), []);
});

test('notices: a deprecation rule produces since and removed_in', () => {
  const rules = [{
    code: 'D_TEST_RULE', kind: 'deprecation', since: '0.4.0', removed_in: '0.6.0', docs: 'https://example.test/docs',
    check: () => [{ path: 'fetch.old_key', message: 'old_key is deprecated; use new_key.' }],
  }];
  assert.deepEqual(collectNotices(adapter, null, rules), [{
    code: 'D_TEST_RULE', kind: 'deprecation', message: 'old_key is deprecated; use new_key.',
    since: '0.4.0', docs: 'https://example.test/docs', removed_in: '0.6.0', path: 'fetch.old_key',
  }]);
});

test('notices: output is deduped by code and path, sorted, and capped', () => {
  const many = [{
    code: 'A_TEST_B', kind: 'advice', since: '0.4.0', docs: 'https://example.test/b',
    check: () => Array.from({ length: 25 }, (_, i) => ({ path: `p.${String(i).padStart(2, '0')}`, message: 'm' })),
  }, {
    code: 'A_TEST_A', kind: 'advice', since: '0.4.0', docs: 'https://example.test/a',
    check: () => [{ path: 'x', message: 'm' }, { path: 'x', message: 'duplicate' }],
  }];
  const notices = collectNotices(adapter, null, many);
  assert.equal(notices.length, NOTICE_LIMIT);
  assert.equal(notices[0].code, 'A_TEST_A');
  assert.equal(notices.filter((n) => n.code === 'A_TEST_A').length, 1);
  assert.equal(notices[1].path, 'p.00');
});

test('notices: a rule that throws is skipped, never fails the caller', () => {
  const rules = [
    { code: 'A_TEST_THROWS', kind: 'advice', since: '0.4.0', docs: 'https://example.test', check: () => { throw new Error('boom'); } },
    ...RULES,
  ];
  assert.deepEqual(collectNotices(adapter, { mode: 'snapshot', historyCount: 0 }, rules).map((n) => n.code), [NO_HISTORY]);
});

test('notices: shipped rule messages never embed a URL, header or value', () => {
  for (const rule of RULES) {
    for (const n of rule.check(adapter, { mode: 'snapshot', historyCount: 0, usesHistoryFile: false })) {
      assert.doesNotMatch(n.message, /https?:|example\.test/);
    }
  }
});
