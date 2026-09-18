import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCanary } from '../src/canary.mjs';

const cfg = { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9, max_staleness_days: 14 };
const rep = (fetched, parsed) => ({ stages: { fetched, parsed }, finished_at: '2026-01-10T00:00:00.000Z' });
const history = [rep(100, 100), rep(98, 98), rep(102, 102)];

test('a healthy run passes', () => {
  assert.equal(checkCanary(rep(99, 99), history, cfg).status, 'ok');
});

test('zero records is always a breach', () => {
  const out = checkCanary(rep(0, 0), history, cfg);
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /min_records/);
});

test('a count collapse against the trailing median is a breach', () => {
  const out = checkCanary(rep(30, 30), history, cfg);
  assert.match(out.breaches.join(' '), /count_drop_ratio/);
});

test('fetching fine but parsing almost nothing is a breach — the renamed-field case', () => {
  const out = checkCanary(rep(100, 10), history, cfg);
  assert.match(out.breaches.join(' '), /required_field_ratio/);
});

test('no history means no median check, but min_records still applies', () => {
  assert.equal(checkCanary(rep(5, 5), [], cfg).status, 'ok');
  assert.equal(checkCanary(rep(0, 0), [], cfg).status, 'stale');
});

test('a source that stopped publishing new items is caught by staleness, not just counts', () => {
  const staleCfg = { ...cfg, staleness_field: 'posted_at' };
  const fresh = { ...rep(50, 50), newest_staleness_value: new Date().toISOString() };
  assert.equal(checkCanary(fresh, history, staleCfg).status, 'ok');

  const oldDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const stale = { ...rep(50, 50), newest_staleness_value: oldDate };
  const out = checkCanary(stale, history, staleCfg);
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /staleness/);
});

test('staleness with no value found is itself a breach, not silently skipped', () => {
  const staleCfg = { ...cfg, staleness_field: 'posted_at' };
  const out = checkCanary({ ...rep(50, 50), newest_staleness_value: null }, history, staleCfg);
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /staleness/);
});

test('staleness is not evaluated unless both max_staleness_days and staleness_field are set', () => {
  const { max_staleness_days, ...noStaleness } = cfg;
  const out = checkCanary({ ...rep(50, 50), newest_staleness_value: null }, history, noStaleness);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.skipped, [{ check: 'staleness', reason: 'not_configured' }]);
});

// --- C02: incremental skip semantics, empty snapshot, deterministic now ---

test('an empty incremental run skips ratio with empty_batch and the other three with incremental_batch', () => {
  const out = checkCanary({ ...rep(0, 0), mode: 'incremental' }, history, cfg);
  assert.equal(out.status, 'ok', 'an empty delta is not stale proof');
  assert.deepEqual(
    out.skipped.sort((a, b) => a.check.localeCompare(b.check)),
    [
      { check: 'count_drop_ratio', reason: 'incremental_batch' },
      { check: 'min_records', reason: 'incremental_batch' },
      { check: 'required_field_ratio', reason: 'empty_batch' },
      { check: 'staleness', reason: 'incremental_batch' },
    ],
  );
});

test('an incremental run with a nonempty batch still evaluates required_field_ratio normally', () => {
  const out = checkCanary({ ...rep(100, 10), mode: 'incremental' }, history, cfg);
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /required_field_ratio/);
  assert.deepEqual(
    out.skipped.map((s) => s.check).sort(),
    ['count_drop_ratio', 'min_records', 'staleness'],
  );
});

test('an empty snapshot batch ([]) is stale via min_records, not skipped', () => {
  const out = checkCanary(rep(0, 0), history, cfg);
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /min_records/);
  assert.ok(!out.skipped.some((s) => s.check === 'min_records'));
});

test('count_drop_ratio is explicitly skipped (no_history), not silently ok, when there is no eligible history', () => {
  const out = checkCanary(rep(5, 5), [], cfg);
  assert.equal(out.status, 'ok');
  assert.ok(out.skipped.some((s) => s.check === 'count_drop_ratio' && s.reason === 'no_history'));
});

test('checkCanary excludes explicitly failed/stale history from the median even when passed directly', () => {
  const goodAndBad = [
    { stages: { parsed: 100 }, outcome: 'ok' },
    { stages: { parsed: 2 }, outcome: 'stale' }, // must not drag the median down
    { stages: { parsed: 1 }, outcome: 'error' }, // must not drag the median down
    { stages: { parsed: 98 }, outcome: 'ok' },
  ];
  const out = checkCanary(rep(99, 99), goodAndBad, cfg);
  assert.equal(out.status, 'ok', 'median of the two real ok runs (100, 98) must not include the failed/stale entries');
});

test('staleness accepts finite epoch milliseconds, not just ISO strings', () => {
  const staleCfg = { ...cfg, staleness_field: 'posted_at' };
  const now = new Date('2026-06-01T00:00:00Z');
  const fresh = { ...rep(50, 50), newest_staleness_value: now.getTime() - 2 * 86_400_000 };
  assert.equal(checkCanary(fresh, history, staleCfg, { now }).status, 'ok');

  const old = { ...rep(50, 50), newest_staleness_value: now.getTime() - 30 * 86_400_000 };
  assert.equal(checkCanary(old, history, staleCfg, { now }).status, 'stale');
});

test('staleness accepts a strict date-only value and an explicit-zone timestamp, deterministically via injected now', () => {
  const staleCfg = { ...cfg, staleness_field: 'posted_at' };
  const now = new Date('2026-06-15T00:00:00Z');

  const dateOnly = { ...rep(50, 50), newest_staleness_value: '2026-06-14' };
  assert.equal(checkCanary(dateOnly, history, staleCfg, { now }).status, 'ok');

  const explicitZone = { ...rep(50, 50), newest_staleness_value: '2026-06-14T23:00:00+05:30' };
  assert.equal(checkCanary(explicitZone, history, staleCfg, { now }).status, 'ok');

  const staleDateOnly = { ...rep(50, 50), newest_staleness_value: '2026-04-01' };
  assert.equal(checkCanary(staleDateOnly, history, staleCfg, { now }).status, 'stale');
});

test('staleness rejects a zone-less timestamp as invalid, not a locale-parsed guess', () => {
  const staleCfg = { ...cfg, staleness_field: 'posted_at' };
  const now = new Date('2026-06-15T00:00:00Z');
  const zoneLess = { ...rep(50, 50), newest_staleness_value: '2026-06-14T23:00:00' };
  const out = checkCanary(zoneLess, history, staleCfg, { now });
  assert.equal(out.status, 'stale');
  assert.match(out.breaches.join(' '), /not a valid date/);
});
