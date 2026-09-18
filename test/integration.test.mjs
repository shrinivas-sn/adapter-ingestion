import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile, unlink, readdir, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAll } from '../src/fetch.mjs';
import { safeFailure } from '../src/errors.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords, readIndex, readLatestRecords } from '../src/store.mjs';
import { extractAll } from '../src/extract.mjs';
import { startServer } from './helpers/http-server.mjs';
import { tempPaths, loadAdapterFixture, newestStalenessInstant } from './helpers/fixtures.mjs';

const workerPath = fileURLToPath(new URL('./helpers/store-worker.mjs', import.meta.url));

function waitForMessage(child, predicate) {
  return new Promise((resolve) => {
    function onMessage(m) {
      if (predicate(m)) {
        child.off('message', onMessage);
        resolve(m);
      }
    }
    child.on('message', onMessage);
  });
}

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

  // Retries are Task 6's own concern (proved separately below with a server
  // that actually recovers) -- disabled here so this test proves exactly one
  // thing: a single stalled attempt times out and nothing else happens.
  const adapter = baseAdapter(origin, { timeout_ms: 80, retry: { max_attempts: 1 } });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }),
    (err) => err.code === 'E_TIMEOUT');

  // Whether/when the OS-level socket itself is torn down is undici's own
  // implementation detail, not something this package controls or needs to
  // assert on; close() below forces it regardless.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(requestCount, 1, 'a single-attempt config must not retry');
});

test('H03: a mid-body stall (headers sent, body never completes) times out', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[{"id":1}'); // never closes the array or ends the response
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { timeout_ms: 80, retry: { max_attempts: 1 } });
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

  // 500 is retryable by default (Task 6); this test is about safe-failure
  // projection, not retry behavior, so keep it to a single attempt.
  const adapter = baseAdapter(origin, { retry: { max_attempts: 1 } });
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

// --- R01: only transient failures are retried, over a real connection ---

test('R01: a real 503 then 200 succeeds after exactly one retry', async (t) => {
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      if (calls === 1) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { retry: { max_attempts: 3, backoff_ms: 10, max_delay_ms: 100 } });
  const { diagnostics } = await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(calls, 2);
  assert.equal(diagnostics.attempts, 2);
  assert.equal(diagnostics.retries, 1);
});

test('R01: a real 403 is answered once and never retried', async (t) => {
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => { calls++; res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { retry: { max_attempts: 3, backoff_ms: 10, max_delay_ms: 100 } });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }), (err) => err.code === 'E_HTTP_STATUS');
  assert.equal(calls, 1);
});

test('R01: a real connection reset is retried and the second attempt succeeds', async (t) => {
  // Empirically verified shape (Node 22.15, native fetch/undici): the server
  // destroying the socket before any response surfaces to fetch() as a
  // TypeError('fetch failed') with .cause.code === 'UND_ERR_SOCKET' -- not
  // TimeoutError/AbortError -- so classifyFetchError correctly falls through
  // to the generic, retryable E_FETCH.
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      if (calls === 1) { req.socket.destroy(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[{"id":1}]');
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { retry: { max_attempts: 3, backoff_ms: 10, max_delay_ms: 100 } });
  const { items, diagnostics } = await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(calls, 2);
  assert.equal(items.length, 1);
  assert.equal(diagnostics.retries, 1);
});

test('R01: repeated connection resets exhaust retries and stay bounded at max_attempts', async (t) => {
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req) => { calls++; req.socket.destroy(); },
  });
  t.after(close);

  const adapter = baseAdapter(origin, { retry: { max_attempts: 3, backoff_ms: 5, max_delay_ms: 20 } });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }), (err) => err.code === 'E_FETCH');
  assert.equal(calls, 3, 'never more than max_attempts requests, no matter how many times it fails');
});

// --- R02: Retry-After is honored as a floor, deferred/aborted correctly ---

test('R02: a real 429 with Retry-After: 1 waits at least the requested second before retrying', async (t) => {
  let calls = 0;
  const times = [];
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      times.push(Date.now());
      if (calls === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]');
    },
  });
  t.after(close);

  // A generous cap/budget so the 1-second Retry-After is honored, not deferred.
  const adapter = baseAdapter(origin, {
    max_duration_ms: 10_000,
    retry: { max_attempts: 2, backoff_ms: 0, max_delay_ms: 5000 },
  });
  await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(calls, 2);
  assert.ok(times[1] - times[0] >= 950, `expected >=~1s between attempts, got ${times[1] - times[0]}ms`);
});

test('R02/R03: caller abort during a Retry-After wait stops immediately, no second request', async (t) => {
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end('{}');
    },
  });
  t.after(close);

  const ac = new AbortController();
  const adapter = baseAdapter(origin, {
    max_duration_ms: 10_000,
    retry: { max_attempts: 2, backoff_ms: 0, max_delay_ms: 10_000 },
  });
  const promise = fetchAll(adapter, { fetchImpl: fetch, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  await assert.rejects(promise, (err) => err.code === 'E_ABORTED');
  assert.ok(Date.now() - start < 2000, 'must not wait out the full 5s Retry-After once aborted');
  assert.equal(calls, 1, 'the abort must land during the wait, before a second request is made');
});

// --- R03: page pacing is real, and a retry budget failure is distinct from E_FETCH_DEADLINE ---

test('R03: delay_ms paces successful pages with a real measurable gap; retries never count as pages', async (t) => {
  let calls = 0;
  const times = [];
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      times.push(Date.now());
      const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(page === '2' ? '[]' : '[{"id":1}]');
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, {
    delay_ms: 100,
    pagination: { style: 'page-param', param: 'page', max_pages: 5 },
  });
  const { pages, diagnostics } = await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(pages, 2);
  assert.equal(diagnostics.attempts, 2, 'no failures occurred here, so attempts must equal pages exactly');
  assert.ok(times[1] - times[0] >= 80, `expected >=~100ms pacing gap, got ${times[1] - times[0]}ms`);
});

test('a retry budget exhausted mid-page surfaces the original failure, not E_FETCH_DEADLINE', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      // Deliberately slower than max_duration_ms below, but well inside
      // timeout_ms, so this is a real completed 503 response, not a timeout.
      setTimeout(() => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); }, 60);
    },
  });
  t.after(close);

  // By the time the first (only) attempt's 503 is classified, elapsed time
  // already exceeds max_duration_ms -- remaining budget is negative, so any
  // computed retry wait exceeds it deterministically, regardless of jitter.
  // Task 6 requires this to "stop instead of issuing another attempt", not
  // to manufacture a separate E_FETCH_DEADLINE -- that code is reserved for
  // the top-of-page-loop budget check (already covered by
  // test/fetch.test.mjs's "fetchAll fails with E_FETCH_DEADLINE..." test,
  // which fires *between* pages rather than mid-retry-decision).
  const adapter = baseAdapter(origin, {
    timeout_ms: 500, max_duration_ms: 30,
    retry: { max_attempts: 3, backoff_ms: 1000, max_delay_ms: 5000 },
  });
  await assert.rejects(() => fetchAll(adapter, { fetchImpl: fetch }), (err) => err.code === 'E_HTTP_STATUS');
});

// --- H02 (completed): bytes from a retried, stalled attempt still count ---

test('H02: bytes from a stalled, retried attempt are still counted toward the cumulative total', async (t) => {
  let calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Sends a real, sizeable chunk, then hangs -- never ends the
        // response, so this attempt times out mid-body rather than failing
        // at the connection or status stage.
        res.write(`[{"id":"partial-before-stall","pad":"${'x'.repeat(5000)}"`);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 2 }]));
    },
  });
  t.after(close);

  const adapter = baseAdapter(origin, {
    timeout_ms: 80,
    retry: { max_attempts: 2, backoff_ms: 0, max_delay_ms: 100 },
  });
  const { diagnostics } = await fetchAll(adapter, { fetchImpl: fetch });
  assert.equal(diagnostics.retries, 1);
  // The stalled first attempt alone streamed well over 4000 bytes before
  // timing out; if only the small successful second attempt were counted,
  // this would be nowhere close.
  assert.ok(diagnostics.bytes > 4000, `expected cumulative bytes to include the stalled attempt, got ${diagnostics.bytes}`);
});

// --- E02: a native two-page endpoint where page 2 exhausts retries on 503 ---

test('E02: page 1 succeeds, page 2 exhausts retries on 503 -- store stays byte-identical, no partial ingestion', async (t) => {
  const { storeFile, runsDir } = await tempPaths(t);
  // Seed existing store content before the failing run, to prove the failed
  // run truly writes nothing -- not just that an already-empty file stays empty.
  const seeded = `${JSON.stringify({ id: 'seed:1', content_hash: 'seedhash', fields: { source_id: 'seed', url: 'https://example.test/seed' } })}\n`;
  await writeFile(storeFile, seeded, 'utf8');

  let page2Calls = 0;
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1';
      if (page === '1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ id: 'a', link: 'https://example.test/a', title: 'A' }]));
        return;
      }
      page2Calls++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end('{}');
    },
  });
  t.after(close);

  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: {
      method: 'GET',
      // per_page 1: page 1's single item equals per_page (not a short page),
      // so pagination genuinely continues on to page 2.
      pagination: { style: 'page-param', param: 'page', max_pages: 5, per_page: 1 },
      retry: { max_attempts: 2, backoff_ms: 5, max_delay_ms: 50 },
    },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };

  let caught;
  try {
    await runIngest({ adapter, paths: { storeFile, runsDir }, fetchImpl: fetch, now: new Date() });
    assert.fail('expected runIngest to reject once page 2 exhausts retries');
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.report.outcome, 'error');
  assert.equal(caught.report.failure.code, 'E_HTTP_STATUS');
  assert.equal(caught.report.stages.fetched, 0, 'fetchAll never returned -- a genuine failure, not a partial ingestion');
  assert.equal(caught.report.storage.status, 'not_started');
  assert.ok(page2Calls >= 2, 'page 2 must actually have been retried, not failed on the first attempt alone');
  assert.ok(caught.report.failure.details?.fetch?.statuses?.includes(200),
    'the failure detail must still show page 1\'s progress, not just the final error');
  assert.equal(await readFile(storeFile, 'utf8'), seeded, 'the store must remain byte-identical to the seeded content');
});

// --- E03: a report-write failure after a successful append preserves committed storage; a recovered replay adds nothing ---

test('E03: runsDir-as-file forces E_REPORT_WRITE after a successful append; a recovered replay adds zero new lines', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'e03-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeFile = join(dir, 'store.jsonl');
  const blockedRunsDir = join(dir, 'runs-blocked');
  await writeFile(blockedRunsDir, 'not a directory');

  const { adapter: snapshotAdapter, fixtureRoot } = await loadAdapterFixture('earthquake.usgs.gov');
  // Incremental mode (vs. this same adapter's default snapshot mode) skips
  // the eligible-history scan entirely -- otherwise that scan hits the same
  // blocked runsDir first (E_REPORT_READ), before ever reaching the final
  // writeReport call this test means to isolate (matches run.test.mjs's O01
  // incremental case, which documents the same snapshot-vs-incremental split).
  const adapter = { ...snapshotAdapter, fetch: { ...snapshotAdapter.fetch, incremental: { param: 'since', type: 'iso-date' } } };
  const now = new Date(newestStalenessInstant(adapter, fixtureRoot) + 12 * 3600 * 1000);
  const impl = async () => new Response(JSON.stringify(fixtureRoot), { status: 200 });

  let caught;
  try {
    await runIngest({ adapter, paths: { storeFile, runsDir: blockedRunsDir }, since: '2026-01-01', now, fetchImpl: impl });
    assert.fail('expected the report write to fail');
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.code, 'E_REPORT_WRITE');
  assert.equal(caught.report.storage.status, 'committed');
  assert.ok(caught.report.storage.written > 0);

  const before = await readFile(storeFile, 'utf8');
  const recoveredRunsDir = join(dir, 'runs-recovered');
  const rerun = await runIngest({ adapter, paths: { storeFile, runsDir: recoveredRunsDir }, since: '2026-01-01', now, fetchImpl: impl });
  assert.equal(rerun.report.stages.written, 0);
  assert.equal(await readFile(storeFile, 'utf8'), before);
});

// --- L01 completion: the real runIngest orchestration boundary, across two real processes ---

test('L01 (orchestration): a contender runIngest fails on the lock before any HTTP request; a later replay adds zero duplicates', async (t) => {
  const p = await tempPaths(t);
  let requestCount = 0;
  let resolveRequestReceived;
  const requestReceived = new Promise((resolve) => { resolveRequestReceived = resolve; });
  let resolveGate;
  const gate = new Promise((resolve) => { resolveGate = resolve; });
  const gatedItems = [{ id: 'g1', link: 'https://example.test/g1', title: 'Gated' }];

  const { origin, close } = await startServer({
    '/data': async (req, res) => {
      requestCount++;
      resolveRequestReceived();
      await gate;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(gatedItems));
    },
  });
  t.after(close);

  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', retry: { max_attempts: 1 } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const paths = { storeFile: p.storeFile, runsDir: p.runsDir };
  const now = Date.parse('2026-09-18T00:00:00Z');

  const owner = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (owner.exitCode === null && !owner.killed) owner.kill(); });
  await waitForMessage(owner, (m) => m.event === 'ready');
  owner.send({ cmd: 'run-ingest', adapter, paths, now });

  // Once the gated server has actually received a request, run.mjs's own
  // lock-then-fetch ordering guarantees the owner already holds the store
  // lock -- fetchAll is only ever invoked from inside withStoreLock's callback.
  await requestReceived;

  const contender = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (contender.exitCode === null && !contender.killed) contender.kill(); });
  await waitForMessage(contender, (m) => m.event === 'ready');
  contender.send({ cmd: 'run-ingest', adapter, paths, now });
  const contenderResult = await waitForMessage(contender, (m) => m.event === 'run-error' || m.event === 'run-done');
  await new Promise((resolve) => contender.once('exit', resolve));

  assert.equal(contenderResult.event, 'run-error', 'the contender must fail, never complete');
  assert.equal(contenderResult.code, 'E_STORE_LOCKED');
  assert.equal(requestCount, 1, 'the contender must never have issued an HTTP request');

  resolveGate();
  const ownerResult = await waitForMessage(owner, (m) => m.event === 'run-done' || m.event === 'run-error');
  await new Promise((resolve) => owner.once('exit', resolve));
  assert.equal(ownerResult.event, 'run-done');
  assert.equal(ownerResult.report.outcome, 'ok');
  assert.equal(ownerResult.report.stages.written, 1);

  const before = await readFile(p.storeFile, 'utf8');
  const replay = await runIngest({ adapter, paths, fetchImpl: fetch, now: new Date(now) });
  assert.equal(replay.report.stages.written, 0, 'a later replay must add zero duplicates');
  assert.equal(await readFile(p.storeFile, 'utf8'), before);
});

// --- E04: a process killed mid-append leaves a synced valid line and a corrupt partial tail ---

test('E04: a process killed mid-append leaves a real corrupt tail; explicit recovery + replay heals the store', async (t) => {
  const p = await tempPaths(t);
  const adapter = {
    version: 1, host: 'example.test',
    access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const item1 = { id: 1, link: 'https://example.test/1', title: 'One' };
  const item2 = { id: 2, link: 'https://example.test/2', title: 'Two' };
  const { records } = extractAll([item1, item2], adapter, { fetchedAt: new Date('2026-09-18T00:00:00Z').toISOString() });
  const [record1, record2] = records;
  const validLine = JSON.stringify(record1);
  const fullSecondLine = JSON.stringify(record2);
  const partialLine = fullSecondLine.slice(0, Math.floor(fullSecondLine.length / 2));

  const worker = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await waitForMessage(worker, (m) => m.event === 'ready');
  worker.send({ cmd: 'hold-lock-partial-write', storeFile: p.storeFile, runId: 'crashed-worker', validLine, partialLine });
  await waitForMessage(worker, (m) => m.event === 'partial_written');

  worker.kill();
  await new Promise((resolve) => worker.once('exit', resolve));

  // The crash genuinely left the lock in place.
  const lockMeta = JSON.parse(await readFile(`${p.storeFile}.lock`, 'utf8'));
  assert.equal(lockMeta.run_id, 'crashed-worker');

  // Explicit, out-of-band recovery -- the only sanctioned way to clear a
  // lock left by a confirmed-dead process (proved separately by lock.test.mjs's L02).
  await unlink(`${p.storeFile}.lock`);

  const preReplayWarnings = [];
  const indexBeforeReplay = await readIndex(p.storeFile, { onWarning: (w) => preReplayWarnings.push(w) });
  assert.equal(indexBeforeReplay.get(record1.id), record1.content_hash, 'the earlier, fully-synced record survives the crash');
  assert.ok(preReplayWarnings.some((w) => w.code === 'W_STORE_CORRUPT_LINE'), 'the partial tail is warned, not silently accepted');

  const { report } = await runIngest({
    adapter, paths: { storeFile: p.storeFile, runsDir: p.runsDir },
    fetchImpl: async () => new Response(JSON.stringify([item1, item2]), { status: 200 }),
    now: new Date('2026-09-18T00:00:00Z'),
  });
  assert.equal(report.stages.unchanged, 1, 'the earlier record needs no rewrite');
  assert.equal(report.stages.fresh, 1, 'the record whose tail was corrupt reappears exactly once');
  assert.equal(report.stages.written, 1);
  assert.ok(report.warning_count >= 1, 'the corrupt-tail warning surfaces on the real replay too');

  // No fabricated report exists for the killed invocation -- runsDir holds
  // exactly the one report this recovery replay just wrote.
  const reportFiles = (await readdir(p.runsDir)).filter((n) => n.startsWith('report-'));
  assert.equal(reportFiles.length, 1);

  const latest = await readLatestRecords(p.storeFile);
  assert.equal(latest.length, 2, 'each ID appears exactly once in the latest view');
});

// --- Overlapping IDs across pages (valid content, different per page): last occurrence wins ---

test('a valid ID repeated across two pages with different content: the later page wins, and counts explain the collapse', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      const page = new URL(req.url, 'http://x').searchParams.get('page') ?? '1';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (page === '1') {
        res.end(JSON.stringify([
          { id: 'A', link: 'https://example.test/a', title: 'A page1' },
          { id: 'B', link: 'https://example.test/b', title: 'B' },
        ]));
      } else {
        res.end(JSON.stringify([
          { id: 'A', link: 'https://example.test/a', title: 'A page2' },
          { id: 'C', link: 'https://example.test/c', title: 'C' },
        ]));
      }
    },
  });
  t.after(close);

  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', pagination: { style: 'page-param', param: 'page', max_pages: 2, allow_truncation: true } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const { storeFile, runsDir } = await tempPaths(t);
  const { report } = await runIngest({ adapter, paths: { storeFile, runsDir }, fetchImpl: fetch, now: new Date() });
  assert.equal(report.stages.parsed, 4, 'both pages must be fully extracted before collapsing on id');
  assert.equal(report.stages.fresh, 3, 'A collapses to one row -- 4 parsed records become 3 distinct IDs');
  assert.equal(report.stages.written, 3);

  const latest = await readLatestRecords(storeFile);
  const a = latest.find((r) => r.fields.source_id === 'A');
  assert.equal(a.fields.title, 'A page2', 'the later page occurrence must win');
  assert.equal(latest.length, 3);
});

// --- Cancellation: no store mutation before append; committed status survives a late cancellation ---

test('a caller abort during fetch produces no store mutation', async (t) => {
  const { origin, close } = await startServer({
    '/data': () => { /* never responds -- simulates a hang */ },
  });
  t.after(close);
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', timeout_ms: 5000, retry: { max_attempts: 1 } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const { storeFile, runsDir } = await tempPaths(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  let caught;
  try {
    await runIngest({ adapter, paths: { storeFile, runsDir }, fetchImpl: fetch, now: new Date(), signal: ac.signal });
    assert.fail('expected the run to abort');
  } catch (err) {
    caught = err;
  }
  assert.ok(Date.now() - start < 2000, 'must not wait out the full 5s timeout once aborted');
  assert.equal(caught.code, 'E_ABORTED');
  assert.equal(caught.report.storage.status, 'not_started');
  await assert.rejects(readFile(storeFile), { code: 'ENOENT' }, 'no store file must ever be created');
});

test('a caller abort during a Retry-After wait produces no store mutation', async (t) => {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end('{}');
    },
  });
  t.after(close);
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', max_duration_ms: 10_000, retry: { max_attempts: 2, backoff_ms: 0, max_delay_ms: 10_000 } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const { storeFile, runsDir } = await tempPaths(t);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const start = Date.now();
  let caught;
  try {
    await runIngest({ adapter, paths: { storeFile, runsDir }, fetchImpl: fetch, now: new Date(), signal: ac.signal });
    assert.fail('expected the run to abort');
  } catch (err) {
    caught = err;
  }
  assert.ok(Date.now() - start < 2000, 'must not wait out the full 5s Retry-After once aborted');
  assert.equal(caught.code, 'E_ABORTED');
  assert.equal(caught.report.storage.status, 'not_started');
  await assert.rejects(readFile(storeFile), { code: 'ENOENT' });
});

test('cancellation that lands only after the store append already committed does not roll back or fail the run', async (t) => {
  const items = [
    { id: 1, link: 'https://example.test/1', title: 'One' },
    { id: 2, link: 'https://example.test/2', title: 'Two' },
  ];
  const adapter = {
    version: 1, host: 'example.test',
    access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  const { storeFile, runsDir } = await tempPaths(t);
  const ac = new AbortController();

  const pollAndAbort = (async () => {
    for (;;) {
      try {
        const s = await stat(storeFile);
        if (s.size > 0) { ac.abort(); return; }
      } catch { /* not yet created */ }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();

  const { report } = await runIngest({
    adapter, paths: { storeFile, runsDir },
    fetchImpl: async () => new Response(JSON.stringify(items), { status: 200 }),
    now: new Date(), signal: ac.signal,
  });
  await pollAndAbort;
  assert.equal(report.outcome, 'ok', 'a cancellation arriving after append must not turn a committed run into a failure');
  assert.equal(report.stages.written, 2);
  const stored = await readRecords(storeFile);
  assert.equal(stored.length, 2);
});
