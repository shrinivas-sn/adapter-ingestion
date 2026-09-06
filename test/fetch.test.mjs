import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, fetchAll } from '../src/fetch.mjs';

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
const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test('buildUrl adds pagination and incremental params', () => {
  const u = new URL(buildUrl(adapter, { page: 2, since: '2026-01-01' }));
  assert.equal(u.searchParams.get('page'), '2');
  assert.equal(u.searchParams.get('per_page'), '2');
  assert.equal(u.searchParams.get('after'), '2026-01-01');
});

test('the configured User-Agent is sent on every request', async () => {
  const seen = [];
  const impl = async (url, init) => { seen.push(init.headers['User-Agent']); return ok([]); };
  await fetchAll(adapter, { fetchImpl: impl });
  assert.deepEqual(seen, ['<BROWSER_UA>']);
});

test('pagination stops on a short page and respects max_pages', async () => {
  let page = 0;
  const impl = async () => ok(++page <= 5 ? [{ id: page * 10 }, { id: page * 10 + 1 }] : []);
  const { items, pages } = await fetchAll(adapter, { fetchImpl: impl });
  assert.equal(pages, 3);
  assert.equal(items.length, 6);
});

test('a non-ok status throws with the status code, so a UA block fails loudly', async () => {
  const impl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /403/);
});

test('a records_path that resolves to a string throws instead of being spread character-by-character', async () => {
  // Strings are iterable — an unguarded `...batch` would silently "paginate"
  // through individual characters as if they were records.
  const impl = async () => ok('not-an-array');
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /expected an array/);
});

test('a records_path that resolves to an object throws a clear error', async () => {
  const impl = async () => ok({ message: 'rest_post_invalid_page_number' });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: impl }), /expected an array/);
});

test('every request carries an abort signal so a hung connection can be cut off', async () => {
  let seenSignal;
  const impl = async (url, init) => { seenSignal = init.signal; return ok([]); };
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
  const capped = { ...adapter, fetch: { ...adapter.fetch, max_response_bytes: 100 } };
  let bodyRead = false;
  const impl = async () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k === 'content-length' ? '999999' : null) },
    json: async () => { bodyRead = true; return []; },
  });
  await assert.rejects(() => fetchAll(capped, { fetchImpl: impl }), /too large/);
  assert.equal(bodyRead, false);
});
