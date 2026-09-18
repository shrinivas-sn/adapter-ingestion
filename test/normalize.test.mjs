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

// --- N01: bad numeric entities cannot throw ---

test('an out-of-range numeric entity becomes U+FFFD instead of throwing', () => {
  assert.equal(applyNormalizer('text', 'A &#1114112; B'), 'A � B');
});

test('a lone surrogate numeric entity becomes U+FFFD instead of throwing', () => {
  assert.equal(applyNormalizer('text', '&#xD800;'), '�');
  assert.equal(applyNormalizer('text', '&#55296;'), '�');
});

test('a zero numeric entity becomes U+FFFD, not a literal NUL', () => {
  assert.equal(applyNormalizer('text', '&#0;'), '�');
  assert.equal(applyNormalizer('text', '&#x0;'), '�');
});

test('a negative-looking or absurdly large numeric entity cannot throw or overflow', () => {
  assert.doesNotThrow(() => applyNormalizer('text', '&#999999999999999999999999;'));
  assert.equal(applyNormalizer('text', '&#999999999999999999999999;'), '�');
});

test('a double-encoded entity is not recursively re-decoded', () => {
  // "&amp;#38;" decodes &amp; -> & in one pass only, leaving a literal
  // "&#38;" in the output rather than cascading to a second decode of it.
  assert.equal(applyNormalizer('text', '&amp;#38;'), '&#38;');
});

// --- number: overflow is caught the same way non-finite typeof-number values already are ---

test('a huge digit string that overflows to Infinity normalizes to null', () => {
  assert.equal(applyNormalizer('number', '9'.repeat(400)), null);
});

// --- N02: leap years, month lengths, impossible dates, timestamp offsets, trailing garbage ---

test('iso-date rejects an impossible day of month', () => {
  assert.equal(applyNormalizer('iso-date', '2026-02-31'), null);
  assert.equal(applyNormalizer('iso-date', '2026-04-31'), null);
  assert.equal(applyNormalizer('iso-date', '2026-13-01'), null);
});

test('iso-date validates every month length including leap-year February', () => {
  assert.equal(applyNormalizer('iso-date', '2024-02-29'), '2024-02-29');
  assert.equal(applyNormalizer('iso-date', '2026-04-30'), '2026-04-30');
  assert.equal(applyNormalizer('iso-date', '2026-01-31'), '2026-01-31');
});

test('a non-leap century year rejects Feb 29, a 400-divisible century accepts it', () => {
  assert.equal(applyNormalizer('iso-date', '1900-02-29'), null);
  assert.equal(applyNormalizer('iso-date', '2000-02-29'), '2000-02-29');
});

test('a valid offset timestamp retains the written date, not the UTC-shifted date', () => {
  assert.equal(applyNormalizer('iso-date', '2026-09-12T00:30:00+05:30'), '2026-09-12');
  assert.equal(applyNormalizer('iso-date', '2026-09-12T23:45:00Z'), '2026-09-12');
});

test('iso-date rejects 24:00, leap seconds, and out-of-range offsets', () => {
  assert.equal(applyNormalizer('iso-date', '2026-09-12T24:00:00'), null);
  assert.equal(applyNormalizer('iso-date', '2026-09-12T10:00:60'), null);
  assert.equal(applyNormalizer('iso-date', '2026-09-12T10:00:00+25:00'), null);
  assert.equal(applyNormalizer('iso-date', '2026-09-12T10:61:00'), null);
});

test('iso-date accepts fractional seconds', () => {
  assert.equal(applyNormalizer('iso-date', '2026-09-12T10:00:00.123456789Z'), '2026-09-12');
});

test('iso-date rejects trailing garbage after an otherwise valid timestamp', () => {
  assert.equal(applyNormalizer('iso-date', '2026-09-12T10:00:00Zgarbage'), null);
  assert.equal(applyNormalizer('iso-date', '2026-09-12extra'), null);
});

test('iso-date rejects a two-digit year', () => {
  assert.equal(applyNormalizer('iso-date', '03-Sep-26'), null);
  assert.equal(applyNormalizer('iso-date', '03/09/26'), null);
});

test('iso-date rejects mismatched separators', () => {
  assert.equal(applyNormalizer('iso-date', '03-Sep/2026'), null);
  assert.equal(applyNormalizer('iso-date', '03-09/2026'), null);
});

test('iso-date accepts a full English month name and a whitespace-separated date', () => {
  assert.equal(applyNormalizer('iso-date', '03 September 2026'), '2026-09-03');
  assert.equal(applyNormalizer('iso-date', '3-Jan-2026'), '2026-01-03');
});

test('iso-date rejects a word that merely starts with a valid month prefix', () => {
  assert.equal(applyNormalizer('iso-date', '03-Septemberish-2026'), null);
  assert.equal(applyNormalizer('iso-date', '03-Janx-2026'), null);
});

test('iso-date leaves an epoch number unsupported rather than misreading it', () => {
  assert.equal(applyNormalizer('iso-date', 1_700_000_000), null);
  assert.equal(applyNormalizer('iso-date', '1700000000'), null);
});
