import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKind, builtinKindNames } from '../src/kinds/index.mjs';

test('json-api is a built-in kind that parses bytes exactly like the old JSON path', () => {
  assert.deepEqual(resolveKind('json-api').parse({ bytes: Buffer.from('[1]') }), [1]);
  assert.equal(resolveKind('json-api').parse({ bytes: Buffer.alloc(0) }), null);
});

test('an unknown kind resolves to null', () => {
  assert.equal(resolveKind('nope'), null);
});

test('builtinKindNames is sorted', () => {
  const names = builtinKindNames();
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('json-api'));
});
