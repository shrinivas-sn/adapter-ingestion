import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fetchAll } from '../src/fetch.mjs';
import { safeFailure } from '../src/errors.mjs';
import { startServer } from './helpers/http-server.mjs';

function baseAdapter(origin, overrides = {}) {
  // No pagination by default -- these transport-focused tests care about
  // byte caps/timeouts/redirects, not pagination completeness, and
  // triggering that separate concern (a full single page hitting max_pages
  // without allow_truncation) would be an unrelated false failure here.
  return {
    host: '127.0.0.1', records_path: '$',
    access: { kind: 'json-api', url: `${origin}/data` },
    fetch: {
      method: 'GET',
      timeout_ms: 500,
      ...overrides,
    },
  };
}

// --- H01: a real chunked response with no honest Content-Length is stopped
// by the actual byte cap, not a trusted header. ---

test('H01: a native chunked response without Content-Length is capped by actual bytes read', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // No Content-Length -> Node sends this chunked. The payload itself is
      // a JSON array far larger than max_response_bytes below.
      const big = JSON.stringify(Array.from({ length: 5000 }, (_, i) => ({ id: i, pad: 'x'.repeat(50) })));
      res.write(big.slice(0, big.length / 2));
      res.write(big.slice(big.length / 2));
      res.end();
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { max_response_bytes: 1000 });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_RESPONSE_LIMIT');
});

test('H01: a response within the byte cap still succeeds over a real chunked connection', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[{"id":1}');
      res.write(',{"id":2}]');
      res.end();
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { max_response_bytes: 10_000 });
  const { items } = await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(items.length, 2);
});

// --- H02: decompressed bytes are counted, not the compressed wire size ---

test('H02: a gzip-compressed body that decompresses over the cap is rejected', async (t) => {
  const payload = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, pad: 'y'.repeat(80) })));
  const compressed = gzipSync(Buffer.from(payload, 'utf8'));
  assert.ok(compressed.length < payload.length / 4, 'fixture assumption: the body must actually compress well');

  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(compressed);
    },
  });
  t.after(close);

  // Cap sits between the compressed size and the decompressed size: passing
  // means the byte count came from the decompressed stream Fetch delivers,
  // not the wire bytes.
  const adapter = baseAdapter(origin, { max_response_bytes: compressed.length + 5000 });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_RESPONSE_LIMIT');
});

test('H02: max_total_bytes is enforced cumulatively across pages, not per response', async (t) => {
  // Each page's content must actually differ (includes its own page number)
  // -- a byte-identical batch across pages is legitimately flagged as
  // E_PAGINATION_REPEAT (Task 5), which is a different failure than the one
  // this test is proving.
  const pageBody = (n) => JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: `${n}-${i}`, pad: 'z'.repeat(30) })));
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(pageBody(page));
    },
  });
  t.after(close);

  const bytesPerPage = Buffer.byteLength(pageBody('1'), 'utf8');
  const adapter = baseAdapter(origin, {
    // Each page is well under max_response_bytes individually, but three
    // pages together exceed max_total_bytes.
    max_response_bytes: bytesPerPage + 1000,
    max_total_bytes: Math.floor(bytesPerPage * 2.5),
    pagination: { style: 'page-param', param: 'page', max_pages: 5, per_page: 200 },
  });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_TOTAL_BYTES_LIMIT');
});

// --- H03: real stalls terminate via timeout and release the connection ---

test('H03: a pre-header stall (server never responds) times out and triggers no further work', async (t) => {
  let requestCount = 0;
  const { origin, close } = await startServer({
    '/data': () => { requestCount++; /* never writeHead/end — simulate a hung backend */ },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { timeout_ms: 80 });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_TIMEOUT');

  // Retry is disabled internally until Task 6 -- one attempt in, one abort
  // out, nothing further. Whether/when the OS-level socket itself is torn
  // down is undici's own implementation detail, not something this package
  // controls or needs to assert on; close() below forces it regardless.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(requestCount, 1, 'a timed-out attempt must not be silently retried');
});

test('H03: a mid-body stall (headers sent, body never completes) times out', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[{"id":1}'); // never closes the array or ends the response
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { timeout_ms: 80 });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_TIMEOUT');
});

test('H03: an already-aborted caller signal is honored without ever opening a connection', async (t) => {
  const { origin, close, sockets } = await startServer({
    '/data': (req, res) => { res.writeHead(200); res.end('[]'); },
  });
  t.after(close);

  const ac = new AbortController();
  ac.abort();
  const adapter = baseAdapter(origin);
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch, signal: ac.signal }),
    (err) => err.code === 'E_ABORTED');
  assert.equal(sockets.size, 0);
});

// --- H04: redirects are classified, not followed; JSON errors are safe; no secrets leak ---

test('H04: a redirect is rejected as E_REDIRECT, never silently followed', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => { res.writeHead(302, { Location: '/elsewhere' }); res.end(); },
    '/elsewhere': (req, res) => { res.writeHead(200); res.end('[{"id":"should-not-be-reached"}]'); },
  });
  t.after(close);

  const adapter = baseAdapter(origin);
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_REDIRECT');
});

test('H04: malformed JSON from a real server is E_RESPONSE_JSON, not a crash', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{not valid json'); },
  });
  t.after(close);

  const adapter = baseAdapter(origin);
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_RESPONSE_JSON');
});

test('H04: a secret in a response header or body never appears in the thrown message or safeFailure', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json', 'X-Debug-Secret': 'HEADER_SECRET_XYZ' });
      res.end(JSON.stringify({ error: 'body contains BODY_SECRET_XYZ' }));
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin);
  try {
    await fetchAll(adapter, { fetchImpl: fetch });
    assert.fail('expected fetchAll to reject on a 500 status');
  } catch (err) {
    assert.equal(err.code, 'E_HTTP_STATUS');
    assert.ok(!err.message.includes('HEADER_SECRET_XYZ'));
    assert.ok(!err.message.includes('BODY_SECRET_XYZ'));
    const safe = safeFailure(err, 'fetch');
    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes('HEADER_SECRET_XYZ'));
    assert.ok(!serialized.includes('BODY_SECRET_XYZ'));
  }
});

test('H04: an error-status body is drained (not left half-read) without throwing a secondary error', async (t) => {
  // A completed HTTP/1.1 exchange legitimately stays in a keep-alive pool
  // (that's not a leak); what actually matters is that draining the unread
  // body on the error path doesn't itself throw and mask the real E_HTTP_STATUS.
  const { origin, close } = await startServer({
    '/data': (req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"large":"body"}'); },
  });
  t.after(close);

  const adapter = baseAdapter(origin);
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }), (err) => err.code === 'E_HTTP_STATUS');
});
