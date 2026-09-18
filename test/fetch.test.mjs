import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, fetchAll } from '../src/fetch.mjs';
import { safeFailure } from '../src/errors.mjs';
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

test('pagination stops on a short page and respects max_pages', async () => {
  let page = 0;
  const impl = async () => jsonResponse(++page <= 5 ? [{ id: page * 10 }, { id: page * 10 + 1 }] : []);
  const { items, pages } = await fetchAll(adapter, { fetchImpl: impl });
  assert.equal(pages, 3);
  assert.equal(items.length, 6);
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
  const impl = async () => { throw new DOMException('aborted', 'TimeoutError'); };
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /timed out/);
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
  const limited = { ...adapter, fetch: { ...adapter.fetch, max_records: 3, pagination: { style: 'page-param', param: 'page', max_pages: 1 } } };
  const impl = async () => jsonResponse(Array.from({ length: 10 }, (_, i) => ({ id: i })));
  await assert.rejects(() => fetchAll(limited, { fetchImpl: impl }), (err) => err.code === 'E_RECORD_LIMIT');
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
  const secretAdapter = {
    ...adapter,
    access: { kind: 'json-api', url: 'https://example.test/api?token=SUPER_SECRET_TOKEN' },
    fetch: { ...adapter.fetch, pagination: { style: 'page-param', param: 'page', max_pages: 1 } },
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