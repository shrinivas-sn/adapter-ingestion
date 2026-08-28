import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter } from '../src/filter.mjs';

const NOW = new Date('2026-01-10T12:00:00Z');
const rec = (fields) => ({ id: 'h:1', fields });

test('any_of on an array field is ANY-match, not ALL', () => {
  const f = { mode: 'all', rules: [{ field: 'fields.tags', op: 'any_of', value: ['a', 'z'] }] };
  assert.equal(applyFilter([rec({ tags: ['a', 'b'] })], f, NOW).kept.length, 1);
  assert.equal(applyFilter([rec({ tags: ['b'] })], f, NOW).kept.length, 0);
});

test('between is inclusive on both bounds', () => {
  const f = { mode: 'all', rules: [{ field: 'fields.price', op: 'between', min: 10, max: 20 }] };
  assert.equal(applyFilter([rec({ price: 10 }), rec({ price: 20 }), rec({ price: 21 })], f, NOW).kept.length, 2);
});

test('within_days counts the boundary day as inside the window', () => {
  const f = { mode: 'all', rules: [{ field: 'fields.deadline', op: 'within_days', value: 5 }] };
  const { kept } = applyFilter([rec({ deadline: '2026-01-15' }), rec({ deadline: '2026-01-16' })], f, NOW);
  assert.equal(kept.length, 1);
});

test('a missing field fails a positive rule but passes a negative one', () => {
  const pos = { mode: 'all', rules: [{ field: 'fields.city', op: 'any_of', value: ['x'] }] };
  const neg = { mode: 'all', rules: [{ field: 'fields.city', op: 'none_of', value: ['x'] }] };
  assert.equal(applyFilter([rec({})], pos, NOW).kept.length, 0);
  assert.equal(applyFilter([rec({})], neg, NOW).kept.length, 1);
});

test('mode any passes a record matching a single rule', () => {
  const f = { mode: 'any', rules: [
    { field: 'fields.price', op: 'lte', value: 5 },
    { field: 'fields.tags', op: 'any_of', value: ['a'] },
  ] };
  assert.equal(applyFilter([rec({ price: 100, tags: ['a'] })], f, NOW).kept.length, 1);
});

test('dropped records report which rule rejected them', () => {
  const f = { mode: 'all', rules: [{ field: 'fields.price', op: 'lte', value: 5 }] };
  const { dropped } = applyFilter([rec({ price: 100 })], f, NOW);
  assert.equal(dropped[0].failed[0].op, 'lte');
});
