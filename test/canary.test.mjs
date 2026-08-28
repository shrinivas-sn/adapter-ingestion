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
