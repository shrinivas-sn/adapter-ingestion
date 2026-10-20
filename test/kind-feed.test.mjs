import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { feedDate } from '../src/kinds/feed.mjs';

// access.kind "feed" (since 0.9): RSS 2.0, RSS 1.0 and Atom. Shapes come
// from real feeds (WordPress News, GitHub releases, Python Insider, BBC);
// values are invented.

test('feedDate reads RFC 822 dates as ISO UTC', () => {
  assert.equal(feedDate('Tue, 06 Oct 2026 17:00:00 +0000'), '2026-10-06T17:00:00.000Z');
  assert.equal(feedDate('Mon, 19 Oct 2026 21:12:30 GMT'), '2026-10-19T21:12:30.000Z');
  assert.equal(feedDate('6 Oct 2026 12:00 EST'), '2026-10-06T17:00:00.000Z');
  assert.equal(feedDate('Tue, 06 Oct 2026 17:00:00 +0530'), '2026-10-06T11:30:00.000Z');
  assert.equal(feedDate('  tue, 06 oct 2026 17:00:00 pdt  '), '2026-10-07T00:00:00.000Z');
});

test('feedDate reads ISO dates with a zone (Atom, dc:date)', () => {
  assert.equal(feedDate('2026-10-14T15:22:04Z'), '2026-10-14T15:22:04.000Z');
  assert.equal(feedDate('2026-10-14T15:22:04+02:00'), '2026-10-14T13:22:04.000Z');
});

test('feedDate gives null for anything it cannot read exactly', () => {
  for (const bad of [
    'Tue, 06 Oct 26 17:00:00 GMT', // two-digit year
    '31 Feb 2026 10:00:00 GMT',
    '06 Oct 2026 24:00:00 GMT',
    '06 Oct 2026 17:00:60 GMT',
    '06 Oct 2026 17:00:00 A', // military zone
    '06 Oct 2026 17:00:00 +2500',
    '2026-10-14T15:22:04', // no zone
    '', '  ', 42, undefined, null,
  ]) {
    assert.equal(feedDate(bad), null, String(bad));
  }
});
