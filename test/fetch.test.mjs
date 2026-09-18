import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, fetchAll } from '../src/fetch.mjs';
import { safeFailure } from '../src/errors.mjs';
import { retryDelay, waitFor } from '../src/http.mjs';
import { jsonResponse } from './helpers/fixtures.mjs';

const adapter = {
  host: 'example.test', records_path: '$',
  access: { kind: 'json-api', url: 'https://example.test/api' },
  fetch: {
    method: 'GET',
    headers: { 'User-Agent': '<BROWSER_UA>' },
    pagination: { style: 'page-param', param: 'page', per_page_param: 'per_page', per_page: 2, max_pages: 3 },
    incremental: { param: 'after', type: 'iso-date' },
  },
};

test('buildUrl adds pagination and incremental params', () => {
  const u = new URL(buildUrl(adapter, { page: 2, since: '2026-01-01' }));
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('per_page'), '2');
  assert.equal(u.searchParams.get('after'), '2026-01-01');
});

test('the configured User-Agent is sent on every request', async () => {
  const seen = [];
  const impl = async (url, init) => { seen.push(init.headers['User-Agent']); return jsonResponse([]); };
  await fetchAll(adapter, { fetchImpl: impl });
  assert.deepEqual(seen, ['<BROWSER_UA>']);
});

test('pagination stops on a short page and respects max_pages, with allow_truncation set', async () => {
  const truncating = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { ...adapter.fetch.pagination, allow_truncation: true } } };
  let page = 0;
  const impl = async () => jsonResponse(++page <= 5 ? [{ id: page * 10 }, { id: page * 10 + 1 }] : []);
  const { items, pages, diagnostics } = await fetchAll(truncating, { fetchImpl: impl });
  assert.equal(pages, 3);
  assert.equal(items.length, 6);
  assert.equal(diagnostics.complete, false);
  assert.equal(diagnostics.stop_reason, 'max_pages');
});

// --- P02: the default (no allow_truncation) rejects a cap hit on a non-terminal page ---

test('hitting max_pages on a still-full page is rejected by default (no allow_truncation)', async () => {
  let page = 0;
  const impl = async () => jsonResponse(++page <= 5 ? [{ id: page * 10 }, { id: page * 10 + 1 }] : []);
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), (err) => err.code === 'E_PAGE_LIMIT');
});

test('a non-ok status throws with the status code, so a UA block fails loudly', async () => {
  const impl = async () => jsonResponse({}, { status: 403 });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /403/);
});

test('a records_path that resolves to a string throws instead of being spread character-by-character', async () => {
  // Strings are iterable — an unguarded `...batch` would silently "paginate"
  // through individual characters as if they were records.
  const impl = async () => jsonResponse('not-an-array');
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /expected an array/);
});

test('a records_path that resolves to an object throws a clear error', async () => {
  const impl = async () => jsonResponse({ message: 'rest_post_invalid_page_number' });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /expected an array/);
});

test('every request carries an abort signal so a hung connection can be cut off', async () => {
  let seenSignal;
  const impl = async (url, init) => { seenSignal = init.signal; return jsonResponse([]); };
  await fetchAll(adapter, { fetchImpl: impl });
  assert.ok(seenSignal instanceof AbortSignal, 'fetchImpl must receive a real AbortSignal');
});

test('a timeout-shaped abort is reported as a timeout, not a generic failure', async () => {
  // Exercises the error-message branch fetchAll takes when the signal fires,
  // without depending on a real timer actually elapsing in the test run.
  // E_TIMEOUT is retryable by default (Task 6); this test is about
  // classification, not retry behavior, so a single attempt keeps it fast.
  const single = { ...adapter, fetch: { ...adapter.fetch, retry: { max_attempts: 1 } } };
  const impl = async () => { throw new DOMException('aborted', 'TimeoutError'); };
  await assert.rejects(() => fetchAll(single, { fetchImpl: impl }), /timed out/);
});

test('a response over max_response_bytes is rejected before the body is read', async () => {
  // Only the early Content-Length hint is exercised here — H01 (actual byte
  // counting against a chunked response with no honest Content-Length) is
  // proved against a real server in test/integration.test.mjs.
  const capped = { ...adapter, fetch: { ...adapter.fetch, max_response_bytes: 100 } };
  let bodyRead = false;
  const impl = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-length' ? '999999' : null) },
    json: async () => { bodyRead = true; return []; },
    body: { cancel: async () => {} },
  });
  await assert.rejects(() => fetchAll(capped, { fetchImpl: impl }), /too large/);
  assert.equal(bodyRead, false);
});

// --- E_RECORD_LIMIT checked before an unbounded spread ---

test('max_records is enforced before appending, not after an unbounded spread', async () => {
  const limited = { ...adapter, fetch: { ...adapter.fetch, max_records: 3, pagination: { style: 'page-param', param: 'page', max_pages: 1, allow_truncation: true } } };
  const impl = async () => jsonResponse(Array.from({ length: 10 }, (_, i) => ({ id: i })));
  await assert.rejects(() => fetchAll(limited, { fetchImpl: impl }), (err) => err.code === 'E_RECORD_LIMIT');
});

test('exactly max_records is accepted; one more overflows', async () => {
  const exact = { ...adapter, fetch: { ...adapter.fetch, max_records: 4,
    pagination: { style: 'page-param', param: 'page', per_page: 2, max_pages: 2, allow_truncation: true } } };
  let page = 0;
  const impl = async () => jsonResponse([{ id: ++page * 10 }, { id: page * 10 + 1 }]);
  const { items } = await fetchAll(exact, { fetchImpl: impl });
  assert.equal(items.length, 4);

  page = 0;
  const overflow = { ...exact, fetch: { ...exact.fetch, max_records: 3 } };
  await assert.rejects(() => fetchAll(overflow, { fetchImpl: impl }), (err) => err.code === 'E_RECORD_LIMIT');
});

// --- P03: repeated-page detection and legitimate overlapping IDs ---

test('an endpoint that ignores its page parameter and repeats a batch fails E_PAGINATION_REPEAT', async () => {
  const paginated = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', max_pages: 3 } } };
  // Same content every time, regardless of the page query param actually sent.
  const impl = async () => jsonResponse([{ id: 1 }, { id: 2 }]);
  await assert.rejects(() => fetchAll(paginated, { fetchImpl: impl }), (err) => err.code === 'E_PAGINATION_REPEAT');
});

test('E_PAGINATION_REPEAT fires even with allow_truncation set', async () => {
  const paginated = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', max_pages: 3, allow_truncation: true } } };
  const impl = async () => jsonResponse([{ id: 1 }, { id: 2 }]);
  await assert.rejects(() => fetchAll(paginated, { fetchImpl: impl }), (err) => err.code === 'E_PAGINATION_REPEAT');
});

test('overlapping IDs across genuinely different batches are valid, not a repeat', async () => {
  const paginated = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', max_pages: 2 } } };
  const batches = [[{ id: 1 }, { id: 2 }], []];
  // Page 2 differs (empty), so no false repeat — but a later, separate test
  // exercises truly overlapping non-identical batches below.
  const impl = async () => jsonResponse(batches.shift());
  const { items } = await fetchAll(paginated, { fetchImpl: impl });
  assert.equal(items.length, 2);
});

test('two different batches that happen to share an ID do not trigger repeat detection', async () => {
  const paginated = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', per_page: 2, max_pages: 2, allow_truncation: true } } };
  const batches = [
    [{ id: 2, v: 'first' }, { id: 3, v: 'first' }],
    [{ id: 2, v: 'second' }, { id: 4, v: 'second' }], // id 2 overlaps but the batch content differs
  ];
  const impl = async () => jsonResponse(batches.shift());
  const { items } = await fetchAll(paginated, { fetchImpl: impl });
  assert.equal(items.length, 4);
});

// --- Termination table: single page, empty page, unknown page size, cap of 1 ---

test('no pagination configured: one response is always complete, stop_reason single_page', async () => {
  const unpaginated = { ...adapter, fetch: { method: 'GET' } };
  const impl = async () => jsonResponse([{ id: 1 }]);
  const { diagnostics } = await fetchAll(unpaginated, { fetchImpl: impl });
  assert.equal(diagnostics.complete, true);
  assert.equal(diagnostics.stop_reason, 'single_page');
});

test('an empty first page is complete, stop_reason empty_page', async () => {
  const paginated = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', max_pages: 3 } } };
  const impl = async () => jsonResponse([]);
  const { items, pages, diagnostics } = await fetchAll(paginated, { fetchImpl: impl });
  assert.equal(items.length, 0);
  assert.equal(pages, 1);
  assert.equal(diagnostics.complete, true);
  assert.equal(diagnostics.stop_reason, 'empty_page');
});

test('unknown page size (no per_page declared) continues until an empty page', async () => {
  const a = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', max_pages: 3 } } };
  const batches = [[{ id: 1 }], [{ id: 2 }], []];
  const result = await fetchAll(a, { fetchImpl: async () => jsonResponse(batches.shift()) });
  assert.equal(result.pages, 3);
  assert.equal(result.items.length, 2);
  assert.equal(result.diagnostics.complete, true);
  assert.equal(result.diagnostics.stop_reason, 'empty_page');
});

test('max_pages of exactly 1 still requires allow_truncation if the single page looks full', async () => {
  const capOne = { ...adapter, fetch: { ...adapter.fetch,
    pagination: { style: 'page-param', param: 'page', per_page: 2, max_pages: 1 } } };
  const impl = async () => jsonResponse([{ id: 1 }, { id: 2 }]); // exactly per_page, looks full
  await assert.rejects(() => fetchAll(capOne, { fetchImpl: impl }), (err) => err.code === 'E_PAGE_LIMIT');

  const allowed = { ...capOne, fetch: { ...capOne.fetch, pagination: { ...capOne.fetch.pagination, allow_truncation: true } } };
  const { diagnostics } = await fetchAll(allowed, { fetchImpl: impl });
  assert.equal(diagnostics.complete, false);
  assert.equal(diagnostics.stop_reason, 'max_pages');
});

// --- max_duration_ms: the whole fetch phase has a deadline, not just each attempt ---

test('fetchAll fails with E_FETCH_DEADLINE once the overall duration budget is exceeded', async () => {
  const deadlined = {
    ...adapter,
    fetch: {
      ...adapter.fetch, max_duration_ms: 20,
      // per_page must match every returned batch size, or the loop stops
      // itself on a short page before the deadline ever gets a chance to fire.
      pagination: { style: 'page-param', param: 'page', per_page: 2, max_pages: 5 },
    },
  };
  let calls = 0;
  const impl = async () => {
    calls++;
    if (calls > 1) await new Promise((r) => setTimeout(r, 40));
    return jsonResponse([{ id: calls }, { id: calls + 1 }]);
  };
  await assert.rejects(() => fetchAll(deadlined, { fetchImpl: impl }), (err) => err.code === 'E_FETCH_DEADLINE');
});

// --- caller-supplied signal (fetchAll's own `signal` option) ---

test('fetchAll rejects immediately with E_ABORTED when the caller signal is already aborted', async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  const impl = async () => { called = true; return jsonResponse([]); };
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl, signal: ac.signal }),
    (err) => err.code === 'E_ABORTED');
  assert.equal(called, false);
});

// --- H04: safe failures never embed the full request URL (query/secrets) ---

test('a fetch failure never embeds the request URL (query string, potential secrets) in its message', async () => {
  // E_FETCH is retryable by default (Task 6); this test is about safe
  // projection, not retry behavior, so a single attempt keeps it fast.
  const secretAdapter = {
    ...adapter,
    access: { kind: 'json-api', url: 'https://example.test/api?token=SUPER_SECRET_TOKEN' },
    fetch: { ...adapter.fetch, pagination: { style: 'page-param', param: 'page', max_pages: 1 }, retry: { max_attempts: 1 } },
  };
  const impl = async () => { throw new Error('DNS lookup failed'); };
  try {
    await fetchAll(secretAdapter, { fetchImpl: impl });
    assert.fail('expected fetchAll to reject');
  } catch (err) {
    assert.ok(!err.message.includes('SUPER_SECRET_TOKEN'), 'raw thrown message must not contain the query secret');
    assert.ok(!err.message.includes('token='), 'raw thrown message must not contain the raw query string');
    assert.match(err.message, /DNS lookup failed/, 'the underlying reason is still preserved for in-memory debugging');
    assert.equal(err.details.fetch.origin, 'https://example.test');
    const safe = safeFailure(err, 'fetch');
    assert.ok(!safe.message.includes('SUPER_SECRET_TOKEN'));
    assert.ok(!JSON.stringify(safe).includes('SUPER_SECRET_TOKEN'));
    assert.equal(safe.code, 'E_FETCH');
    assert.equal(safe.stage, 'fetch');
  }
});

test('safeFailure passes through a self-authored message for a non-E_FETCH code', async () => {
  const impl = async () => jsonResponse({}, { status: 403 });
  try {
    await fetchAll(adapter, { fetchImpl: impl });
    assert.fail('expected fetchAll to reject');
  } catch (err) {
    const safe = safeFailure(err, 'fetch');
    assert.equal(safe.code, 'E_HTTP_STATUS');
    assert.match(safe.message, /403/);
  }
});

test('safeFailure never trusts a non-IngestionError to describe itself', () => {
  const safe = safeFailure(new Error('some raw underlying failure with a secret=XYZ'), 'fetch');
  assert.equal(safe.code, 'E_FETCH');
  assert.equal(safe.message, 'an unexpected error occurred');
  assert.equal(safe.stage, 'fetch');
});

// --- retryDelay: pure arithmetic, exhaustively testable without real waits ---

test('retryDelay: no Retry-After uses jitter alone, in [0, ceiling]', () => {
  const zero = retryDelay({ retryNumber: 1, backoffMs: 500, maxDelayMs: 10_000, retryAfter: undefined, random: () => 0 });
  assert.deepEqual(zero, { delayMs: 0, deferred: false, retryAfterMs: null });

  // random() returning just under 1 must not reach the ceiling itself —
  // full jitter is uniform in [0, ceiling), not [0, ceiling].
  const nearMax = retryDelay({ retryNumber: 1, backoffMs: 500, maxDelayMs: 10_000, retryAfter: undefined, random: () => 0.999999 });
  assert.ok(nearMax.delayMs < 500 && nearMax.delayMs > 490);
});

test('retryDelay: exponential ceiling doubles per attempt and saturates at max_delay_ms', () => {
  const at = (retryNumber) => retryDelay({ retryNumber, backoffMs: 1000, maxDelayMs: 3000, retryAfter: undefined, random: () => 1 }).delayMs;
  assert.equal(at(1), 1000); // 1000 * 2^0
  assert.equal(at(2), 2000); // 1000 * 2^1
  assert.equal(at(3), 3000); // 1000 * 2^2 = 4000, capped at max_delay_ms
  assert.equal(at(4), 3000); // stays capped
});

test('retryDelay: Retry-After in integer seconds is honored as a floor over jitter', () => {
  const r = retryDelay({ retryNumber: 1, backoffMs: 0, maxDelayMs: 10_000, retryAfter: '2', random: () => 0 });
  assert.deepEqual(r, { delayMs: 2000, deferred: false, retryAfterMs: 2000 });
});

test('retryDelay: Retry-After as an HTTP-date is honored; a past date collapses to 0', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const future = new Date(now + 5000).toUTCString();
  const r = retryDelay({ retryNumber: 1, backoffMs: 0, maxDelayMs: 10_000, retryAfter: future, nowMs: now, random: () => 0 });
  assert.equal(r.deferred, false);
  assert.ok(Math.abs(r.retryAfterMs - 5000) <= 1000, 'HTTP-date has 1-second resolution');

  const past = new Date(now - 5000).toUTCString();
  const pastResult = retryDelay({ retryNumber: 1, backoffMs: 0, maxDelayMs: 10_000, retryAfter: past, nowMs: now, random: () => 0 });
  assert.deepEqual(pastResult, { delayMs: 0, deferred: false, retryAfterMs: 0 });
});

test('retryDelay: an invalid Retry-After header falls back to local backoff, not a crash', () => {
  const r = retryDelay({ retryNumber: 1, backoffMs: 500, maxDelayMs: 10_000, retryAfter: 'not-a-real-header-value', random: () => 0 });
  assert.deepEqual(r, { delayMs: 0, deferred: false, retryAfterMs: null });
});

test('retryDelay: a Retry-After beyond max_delay_ms is deferred, never silently shortened', () => {
  const r = retryDelay({ retryNumber: 1, backoffMs: 500, maxDelayMs: 10_000, retryAfter: '20', random: () => 0 });
  assert.deepEqual(r, { delayMs: null, deferred: true, retryAfterMs: 20_000 });
});

// --- waitFor: abortable delay ---

test('waitFor resolves after the timer and rejects immediately for an already-aborted signal', async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(waitFor(1000, ac.signal), (err) => err.code === 'E_ABORTED');

  const start = Date.now();
  await waitFor(20, undefined);
  assert.ok(Date.now() - start >= 15);
});

test('waitFor rejects and cleans up as soon as the signal aborts mid-wait', async () => {
  const ac = new AbortController();
  const pending = waitFor(10_000, ac.signal);
  setTimeout(() => ac.abort(), 20);
  const start = Date.now();
  await assert.rejects(pending, (err) => err.code === 'E_ABORTED');
  assert.ok(Date.now() - start < 1000, 'must not wait for the full 10s timer once aborted');
});

// --- R01: transient failures are retried within max_attempts, permanent ones are not ---

test('a transient 503 retries once before succeeding, and diagnostics count attempts/retries', async () => {
  let calls = 0;
  const a = { ...adapter, fetch: { ...adapter.fetch, pagination: undefined,
    retry: { max_attempts: 3, backoff_ms: 0, max_delay_ms: 0 } } };
  const r = await fetchAll(a, { fetchImpl: async () =>
    (++calls === 1 ? jsonResponse({}, { status: 503 }) : jsonResponse([])) });
  assert.equal(calls, 2);
  assert.equal(r.diagnostics.attempts, 2);
  assert.equal(r.diagnostics.retries, 1);
});

test('a 401/403/404 is never retried, even with retries enabled', async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const a = { ...adapter, fetch: { ...adapter.fetch, pagination: undefined,
      retry: { max_attempts: 3, backoff_ms: 0, max_delay_ms: 0 } } };
    await assert.rejects(() => fetchAll(a, { fetchImpl: async () => { calls++; return jsonResponse({}, { status }); } }),
      (err) => err.code === 'E_HTTP_STATUS');
    assert.equal(calls, 1, `status ${status} must not be retried`);
  }
});

test('retries are exhausted after max_attempts, surfacing the last failure', async () => {
  let calls = 0;
  const a = { ...adapter, fetch: { ...adapter.fetch, pagination: undefined,
    retry: { max_attempts: 2, backoff_ms: 0, max_delay_ms: 0 } } };
  await assert.rejects(() => fetchAll(a, { fetchImpl: async () => { calls++; return jsonResponse({}, { status: 503 }); } }),
    (err) => err.code === 'E_HTTP_STATUS');
  assert.equal(calls, 2);
});