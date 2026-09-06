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
});
