import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, evaluateRule, validateFilter } from '../src/filter.mjs';

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

// --- F01: an invalid filter is rejected even against an empty store ---

test('an invalid mode is rejected even for an empty store', () => {
  assert.throws(() => applyFilter([], { mode: 'al', rules: [] }, NOW),
    (err) => err.code === 'E_FILTER_INVALID');
});

test('validation runs even on a zero-record call, before any rule ever executes', () => {
  const f = { mode: 'all', rules: [{ field: 'fields.price', op: 'bogus_op', value: 1 }] };
  assert.throws(() => applyFilter([], f, NOW), (err) => err.code === 'E_FILTER_INVALID');
});

// --- empty all/any semantics preserved ---

test('empty all keeps everything, empty any keeps nothing', () => {
  const records = [rec({ a: 1 }), rec({ a: 2 })];
  assert.equal(applyFilter(records, { mode: 'all', rules: [] }, NOW).kept.length, 2);
  assert.equal(applyFilter(records, { mode: 'any', rules: [] }, NOW).kept.length, 0);
});

test('validateFilter accepts empty rules for both modes, even with zero records', () => {
  assert.equal(validateFilter({ mode: 'all', rules: [] }).ok, true);
  assert.equal(validateFilter({ mode: 'any', rules: [] }).ok, true);
});

// --- version/mode defaults preserved for callers that omit them ---

test('an omitted version and mode still validate and default to "all"', () => {
  const f = { rules: [{ field: 'fields.price', op: 'lte', value: 5 }] };
  assert.equal(validateFilter(f).ok, true);
  assert.equal(applyFilter([rec({ price: 1 })], f, NOW).kept.length, 1);
});

test('an explicit version other than 1 is rejected', () => {
  assert.equal(validateFilter({ version: 2, rules: [] }).ok, false);
});

// --- operand tables: valid/invalid per operator ---

test('any_of/none_of require an array of JSON primitives', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.tags', op: 'any_of', value: 'not-array' }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.tags', op: 'any_of', value: [{}] }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.tags', op: 'any_of', value: ['a', 1, true, null] }] }).ok, true);
});

test('includes_any/excludes_any require an array of strings', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.title', op: 'includes_any', value: [1, 2] }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.title', op: 'includes_any', value: ['x'] }] }).ok, true);
});

test('gte/lte require a finite numeric operand', () => {
  for (const value of ['5', NaN, Infinity, null, undefined]) {
    assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'gte', value }] }).ok, false);
  }
  assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'gte', value: 5 }] }).ok, true);
});

test('between requires finite min/max with min <= max', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'between', min: 20, max: 10 }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'between', min: 'a', max: 10 }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'between', min: 10, max: 10 }] }).ok, true);
});

test('within_days requires a nonnegative integer', () => {
  for (const value of [-1, 1.5, 'x', null]) {
    assert.equal(validateFilter({ rules: [{ field: 'fields.deadline', op: 'within_days', value }] }).ok, false);
  }
  assert.equal(validateFilter({ rules: [{ field: 'fields.deadline', op: 'within_days', value: 0 }] }).ok, true);
});

test('after_date requires a valid, calendar-correct YYYY-MM-DD', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.posted_at', op: 'after_date', value: '2026-02-31' }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.posted_at', op: 'after_date', value: 'not-a-date' }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.posted_at', op: 'after_date', value: '2026-01-01' }] }).ok, true);
});

test('exists requires a boolean operand', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.x', op: 'exists', value: 'true' }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.x', op: 'exists', value: true }] }).ok, true);
});

test('an unknown key on a rule is rejected', () => {
  assert.equal(validateFilter({
    rules: [{ field: 'fields.price', op: 'gte', value: 5, typo: true }],
  }).ok, false);
});

test('an unknown op is rejected', () => {
  assert.equal(validateFilter({ rules: [{ field: 'fields.price', op: 'greater_than', value: 5 }] }).ok, false);
});

test('a rule.field path must be own-property-valid, matching map path syntax', () => {
  assert.equal(validateFilter({ rules: [{ field: '', op: 'exists', value: true }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields..price', op: 'exists', value: true }] }).ok, false);
  assert.equal(validateFilter({ rules: [{ field: 'fields.__proto__.x', op: 'exists', value: true }] }).ok, false);
});

// --- array-intersection / absent-field semantics unchanged ---

test('array-field any_of intersection semantics are unchanged', () => {
  const f = { rules: [{ field: 'fields.tags', op: 'any_of', value: ['a', 'z'] }] };
  assert.equal(applyFilter([rec({ tags: ['q', 'a'] })], f, NOW).kept.length, 1);
  assert.equal(applyFilter([rec({ tags: ['q', 'r'] })], f, NOW).kept.length, 0);
});

test('an absent field still passes none_of/excludes_any and fails everything else', () => {
  const exists = { rules: [{ field: 'fields.missing', op: 'exists', value: true }] };
  assert.equal(applyFilter([rec({})], exists, NOW).kept.length, 0);
  const existsFalse = { rules: [{ field: 'fields.missing', op: 'exists', value: false }] };
  assert.equal(applyFilter([rec({})], existsFalse, NOW).kept.length, 1);
});

// --- direct evaluateRule validates its own rule too ---

test('evaluateRule throws E_FILTER_INVALID for a malformed rule, called directly', () => {
  assert.throws(() => evaluateRule(rec({ price: 5 }), { field: 'fields.price', op: 'nope' }, NOW),
    (err) => err.code === 'E_FILTER_INVALID');
});

test('evaluateRule accepts a well-formed rule directly, without going through applyFilter', () => {
  assert.equal(evaluateRule(rec({ price: 5 }), { field: 'fields.price', op: 'lte', value: 10 }, NOW), true);
});

// --- invalid `now` is E_OPTIONS for both public entry points ---

test('an invalid now is rejected as E_OPTIONS', () => {
  const f = { rules: [{ field: 'fields.price', op: 'lte', value: 5 }] };
  assert.throws(() => applyFilter([rec({ price: 1 })], f, new Date('not-a-date')),
    (err) => err.code === 'E_OPTIONS');
  assert.throws(() => evaluateRule(rec({ price: 1 }), { field: 'fields.price', op: 'lte', value: 5 }, 'not-a-date'),
    (err) => err.code === 'E_OPTIONS');
});
