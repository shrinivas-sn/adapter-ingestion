import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { applyNormalizer } from '../src/normalize.mjs';

// iso-datetime (since 0.7): keeps the time of day and returns UTC in one
// fixed shape. Formats below are taken from real sources (GitHub REST
// published_at, HN Algolia created_at, WordPress REST date_gmt), with
// invented values.
const CASES = [
  ['2026-10-16T21:15:03Z', '2026-10-16T21:15:03.000Z'],
  ['2026-10-19T15:23:15Z', '2026-10-19T15:23:15.000Z'],
  ['2026-10-19T20:53:15+05:30', '2026-10-19T15:23:15.000Z'],
  ['2026-10-19T01:00-05:00', '2026-10-19T06:00:00.000Z'],
  ['2026-10-19T23:30:00-01:00', '2026-10-20T00:30:00.000Z'],
  ['2026-12-31T23:30:00-01:00', '2027-01-01T00:30:00.000Z'],
  ['2026-10-19T15:23:15.123456789Z', '2026-10-19T15:23:15.123Z'],
  ['2026-10-19T15:23:15.9999Z', '2026-10-19T15:23:15.999Z'],
  ['2026-10-19T15:23:15.5Z', '2026-10-19T15:23:15.500Z'],
  ['  2026-10-19T15:23:15Z  ', '2026-10-19T15:23:15.000Z'],
  ['0050-06-01T12:00:00Z', '0050-06-01T12:00:00.000Z'],
  ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
  ['2026-10-06T17:00:00', null],
  ['2026-10-19', null],
  ['2025-02-29T00:00:00Z', null],
  ['2026-10-19T24:00:00Z', null],
  ['2026-10-19T23:59:60Z', null],
  ['2026-10-19T12:00:00+24:00', null],
  ['2026-10-19 15:23:15Z', null],
  ['2026-10-19T15:23:15+0530', null],
  ['0001-01-01T00:30:00+01:00', null],
  ['9999-12-31T23:30:00-01:00', null],
  [1792423395, null],
  ['', null],
  [null, null],
  [undefined, null],
];

test('iso-datetime: every spec case gives the spec output', () => {
  for (const [input, want] of CASES) {
    assert.equal(applyNormalizer('iso-datetime', input), want, `input ${JSON.stringify(input)}`);
  }
});

test('iso-datetime: assume_zone "Z" reads a zone-less time as UTC; an own zone wins', () => {
  const opts = { assume_zone: 'Z' };
  assert.equal(applyNormalizer('iso-datetime', '2026-10-06T17:00:00', opts), '2026-10-06T17:00:00.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-18T06:50', opts), '2026-10-18T06:50:00.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-19T20:53:15+05:30', opts), '2026-10-19T15:23:15.000Z');
  assert.equal(applyNormalizer('iso-datetime', '2026-10-19', opts), null);
  assert.equal(applyNormalizer('iso-datetime', '2026-02-30T10:00:00', opts), null);
});

test('applyNormalizer: an assume_zone other than "Z" throws', () => {
  assert.throws(() => applyNormalizer('iso-datetime', 'x', { assume_zone: 'UTC' }), /assume_zone must be "Z"/);
  assert.throws(() => applyNormalizer('iso-datetime', 'x', { assume_zone: '+05:30' }), /assume_zone must be "Z"/);
});

test('applyNormalizer: other normalizers ignore options; iso-date is unchanged', () => {
  assert.equal(applyNormalizer('text', ' a ', { assume_zone: 'Z' }), 'a');
  assert.equal(applyNormalizer('iso-date', '2026-10-19T20:53:15+05:30'), '2026-10-19');
  assert.equal(applyNormalizer('iso-date', '2026-10-19T20:53:15+05:30', { assume_zone: 'Z' }), '2026-10-19');
});

test('iso-datetime: output does not depend on the machine time zone', () => {
  const moduleUrl = new URL('../src/normalize.mjs', import.meta.url).href;
  const inputs = JSON.stringify(CASES.map(([input]) => input ?? null));
  const script = `import(${JSON.stringify(moduleUrl)}).then(({ applyNormalizer }) => {
    const inputs = ${inputs};
    process.stdout.write(JSON.stringify(inputs.map((v) => applyNormalizer('iso-datetime', v))));
  });`;
  const want = CASES.map(([, out]) => out);
  for (const tz of ['America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati']) {
    const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), want, `TZ=${tz}`);
  }
});
