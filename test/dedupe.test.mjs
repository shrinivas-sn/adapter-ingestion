import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitByIndex } from '../src/dedupe.mjs';

const r = (id, hash) => ({ id, content_hash: hash });

test('splits records into fresh, changed and unchanged', () => {
  const index = new Map([['h:1', 'a'], ['h:2', 'b']]);
  const out = splitByIndex([r('h:1', 'a'), r('h:2', 'B2'), r('h:3', 'c')], index);
  assert.deepEqual(out.unchanged.map((x) => x.id), ['h:1']);
  assert.deepEqual(out.changed.map((x) => x.id), ['h:2']);
  assert.deepEqual(out.fresh.map((x) => x.id), ['h:3']);
});

test('a duplicate id inside one batch is collapsed, last wins', () => {
  const out = splitByIndex([r('h:1', 'a'), r('h:1', 'a2')], new Map());
  assert.equal(out.fresh.length, 1);
  assert.equal(out.fresh[0].content_hash, 'a2');
});

test('an empty batch against an empty index yields nothing', () => {
  const out = splitByIndex([], new Map());
  assert.equal(out.fresh.length + out.changed.length + out.unchanged.length, 0);
});
