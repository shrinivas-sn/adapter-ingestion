import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNormalizer } from '../src/normalize.mjs';

test('text collapses whitespace, strips tags and entities', () => {
  assert.equal(applyNormalizer('text', '  <b>Hello</b>&amp;  there \n'), 'Hello& there');
  assert.equal(applyNormalizer('text', null), null);
});

test('numeric character references are decoded, not deleted', () => {
  // Real WordPress title text: &#8211; is an en dash, &#038; is a
  // double-encoded ampersand. Deleting them (an earlier version of this
  // normalizer did) silently mangles the title -- a missing dash just
  // reads as a stray double space, not an obvious defect.
  assert.equal(applyNormalizer('text', 'KPSC Recruitment &#8211; 319 Posts'), 'KPSC Recruitment – 319 Posts');
  assert.equal(applyNormalizer('text', 'Worker &#038; Helper'), 'Worker & Helper');
  assert.equal(applyNormalizer('text', 'Caf&#x00e9;'), 'Café');
});

test('number strips currency, separators and units', () => {
  assert.equal(applyNormalizer('number', '  ₹ 25,000/month '), 25000);
  assert.equal(applyNormalizer('number', '1.5'), 1.5);
  assert.equal(applyNormalizer('number', 'not a number'), null);
});

test('iso-date parses common formats to YYYY-MM-DD', () => {
  assert.equal(applyNormalizer('iso-date', '2026-09-03T10:00:00'), '2026-09-03');
  assert.equal(applyNormalizer('iso-date', '03-Sep-2026'), '2026-09-03');
  assert.equal(applyNormalizer('iso-date', '03/09/2026'), '2026-09-03');
  assert.equal(applyNormalizer('iso-date', 'whenever'), null);
});

test('bool maps common truthy and falsy tokens', () => {
  assert.equal(applyNormalizer('bool', 'Yes'), true);
  assert.equal(applyNormalizer('bool', 'no'), false);
  assert.equal(applyNormalizer('bool', 'maybe'), null);
});

test('an unknown normalizer name throws rather than passing data through', () => {
  assert.throws(() => applyNormalizer('nope', 'x'), /unknown normalizer/i);
});
