import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers/http-server.mjs';
import { requestPage } from '../src/fetch/request.mjs';

function stageArgs(url, overrides = {}) {
  const statuses = [];
  return {
    url,
    adapter: { fetch: {} },
    fetchImpl: fetch,
    signal: undefined,
    timeoutMs: 5000,
    maxResponseBytes: 1_000_000,
    budget: { bytes: 0, maxBytes: 10_000_000 },
    retry: { maxAttempts: 3, backoffMs: 1, maxRetryDelayMs: 10 },
    deadline: { startedAt: Date.now(), maxDurationMs: 60_000 },
    fetchContext: (extra = {}) => ({ fetch: { origin: 'test', page: 1, pages: 0, statuses: [...statuses], ...extra } }),
    counters: { totalAttempts: 0, totalRetries: 0 },
    statuses,
    ...overrides,
  };
}

test('requestPage retries a 503 then returns the 200 body, counting through the shared counters', async () => {
  let hits = 0;
  const srv = await startServer({
    '/p': (req, res) => {
      hits++;
      if (hits === 1) { res.writeHead(503); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[1,2]');
    },
  });
  try {
    const args = stageArgs(`${srv.origin}/p`);
    const { buffer } = await requestPage(args);
    assert.equal(buffer.toString('utf8'), '[1,2]');
    assert.equal(args.counters.totalRetries, 1);
    assert.equal(args.counters.totalAttempts, 2);
    assert.deepEqual(args.statuses, [503, 200]);
  } finally {
    await srv.close();
  }
});

test('requestPage turns a 404 into E_HTTP_STATUS with the status in details', async () => {
  const srv = await startServer({ '/p': (req, res) => { res.writeHead(404); res.end(); } });
  try {
    await assert.rejects(requestPage(stageArgs(`${srv.origin}/p`)), (err) => {
      assert.equal(err.code, 'E_HTTP_STATUS');
      assert.equal(err.details.fetch.status, 404);
      return true;
    });
  } finally {
    await srv.close();
  }
});

test('requestPage returns the Content-Type header for the kind to use', async () => {
  const srv = await startServer({
    '/p': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=koi8-r' }); res.end('<p>x</p>'); },
  });
  try {
    const { contentType } = await requestPage(stageArgs(`${srv.origin}/p`));
    assert.equal(contentType, 'text/html; charset=koi8-r');
  } finally {
    await srv.close();
  }
});
