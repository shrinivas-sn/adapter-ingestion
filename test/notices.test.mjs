import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectNotices, RULES, NOTICE_LIMIT } from '../src/notices.mjs';
import { readFile, readdir } from 'node:fs/promises';

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

const TYPO = 'A_TOP_LEVEL_KEY_TYPO';
const typoNotices = (a) => collectNotices(a, null).filter((n) => n.code === TYPO);

test('notices: A_TOP_LEVEL_KEY_TYPO suggests the setting a near-miss meant', () => {
  const table = {
    records_path: ['record_path', 'recordsPath', 'RecordsPath', 'Records_Path', 'records-path',
      'records__path', 'recordspath', 'records path', 'record-path', 'recordPath'],
    required: ['requried', 'require', 'Required', 'REQUIRED', 'requird', 'reqired'],
    canary: ['canry', 'Canary', 'CANARY', 'canery', 'cnary'],
    fetch: ['fecth', 'fetchs', 'Fetch', 'fetc'],
  };
  for (const [expected, typos] of Object.entries(table)) {
    for (const typo of typos) {
      const notices = collectNotices({ ...adapter, [typo]: 1 }, null);
      assert.equal(notices.length, 1, typo);
      assert.equal(notices[0].code, TYPO, typo);
      assert.equal(notices[0].kind, 'advice', typo);
      assert.equal(notices[0].since, '0.5.0', typo);
      assert.equal(notices[0].path, typo, typo);
      assert.ok(notices[0].message.includes(`Did you mean "${expected}"`), `${typo}: ${notices[0].message}`);
    }
  }
});

test('notices: A_TOP_LEVEL_KEY_TYPO message is pinned', () => {
  assert.deepEqual(typoNotices({ ...adapter, record_path: 'results' }), [{
    code: TYPO,
    kind: 'advice',
    message: '"record_path" is not an adapter key, so it is ignored. Did you mean "records_path"? If it is your own note, start its name with "_".',
    since: '0.5.0',
    docs: 'https://github.com/shrinivas-sn/adapter-ingestion/blob/main/README.md#writing-an-adapter-by-hand',
    path: 'record_path',
  }]);
});

test('notices: A_TOP_LEVEL_KEY_TYPO stays quiet on metadata keys', () => {
  const quiet = ['fixtures', 'generated_at', 'generator_model', 'verified_against_fixtures', 'notes',
    'description', 'owner', 'comment', 'tags', 'source', 'license', 'id', 'title', 'docs', 'url',
    'author', 'schedule', 'cron', 'enabled', 'label', 'kind', 'status', 'path', 'mode', 'meta',
    'metadata', '$id', '$comment', 'schema', 'records', 'record', 'fields', 'filter', 'cost', 'post',
    'hosts', 'versions', 'maps', 'HTML', 'htm', 'fetched', 'fetcher', 'fetched_at', 'fetches',
    'canal', 'canaries', 'requirement', 'requirements', 'required_by', 'acquired', 'retired',
    'records_note', 'record_count', 'records_url', 'retry', 'request', 'timeout'];
  for (const key of quiet) assert.deepEqual(typoNotices({ ...adapter, [key]: 1 }), [], key);
});

test('notices: A_TOP_LEVEL_KEY_TYPO accepted near-misses are silenced by "_"', () => {
  assert.ok(typoNotices({ ...adapter, canard: 1 })[0].message.includes('Did you mean "canary"'));
  assert.ok(typoNotices({ ...adapter, requires: 1 })[0].message.includes('Did you mean "required"'));
  for (const key of ['_canard', '_requires', '_canary', '_record_path']) {
    assert.deepEqual(typoNotices({ ...adapter, [key]: 1 }), [], key);
  }
});

test('notices: A_TOP_LEVEL_KEY_TYPO skips a setting that is already set', () => {
  assert.deepEqual(typoNotices({ ...adapter, records_path: '$', record_path: 'x' }), []);
  assert.deepEqual(typoNotices({ ...adapter, required: ['url'], requried: [] }), []);
  assert.equal(typoNotices({ ...adapter, records_path: null, record_path: 'x' }).length, 1);
});

test('notices: A_TOP_LEVEL_KEY_TYPO tolerates any adapter value', () => {
  for (const value of [null, [], 'x', 42]) {
    assert.deepEqual(typoNotices(value), [], JSON.stringify(value));
  }
  assert.deepEqual(typoNotices(JSON.parse('{"__proto__": {}, "_notes": "x"}')), []);
  assert.deepEqual(typoNotices({ ...adapter, ['r'.repeat(10000)]: 1 }), []);
});

test('notices: A_TOP_LEVEL_KEY_TYPO caps its own hits at 10', () => {
  const keys = ['record_path', 'Record_Path', 'RECORD_PATH', 'recordsPath', 'RecordsPath',
    'records-path', 'records__path', 'Records_Path', 'requried', 'Required', 'REQUIRED',
    'canry', 'Canary', 'CANARY', 'fecth'];
  const a = { ...adapter };
  for (const key of keys) a[key] = 1;
  assert.equal(typoNotices(a).length, 10);
});

test('notices: A_TOP_LEVEL_KEY_TYPO messages are printable ASCII and value-free', () => {
  const lookalike = 'rеcords_path';
  const [cyrillic] = typoNotices({ ...adapter, [lookalike]: 1 });
  assert.ok(cyrillic.message.includes('r\\u0435cords_path'), cyrillic.message);
  assert.match(cyrillic.message, /^[\x20-\x7e]+$/);
  assert.equal(cyrillic.path, lookalike);
  const [newline] = typoNotices({ ...adapter, 'record_path\n': 1 });
  assert.match(newline.message, /^[\x20-\x7e]+$/);
  const [secret] = typoNotices({ ...adapter, record_path: 'https://example.test/secret' });
  assert.doesNotMatch(secret.message, /https?:/);
  assert.doesNotMatch(secret.message, /example\.test/);
});

test('notices: A_TOP_LEVEL_KEY_TYPO is quiet for every repo adapter', async () => {
  const dir = new URL('../adapters/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.adapter.json'));
  assert.ok(files.length > 0);
  for (const f of files) {
    const a = JSON.parse(await readFile(new URL(f, dir), 'utf8'));
    assert.deepEqual(typoNotices(a), [], f);
  }
});
