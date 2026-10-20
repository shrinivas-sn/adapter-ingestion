// The feed kind against real feeds from four publishers, offline: a CMS
// project's news (WordPress RSS), a code host's release feed (GitHub Atom),
// a language project's blog (Python Insider RSS, served as
// application/octet-stream) and a broadcaster (BBC RSS, links on another
// host). Each fixture is the live feed cut after its third item, served
// byte-for-byte from a loopback server with the Content-Type it was served
// with. Nothing here is site-specific code; the mapping lives in adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/http-server.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';

const ROOT = new URL('../', import.meta.url);
const NOW = new Date('2026-10-20T12:00:00Z');

// Serves the fixture at the adapter's own path and points a copy of the
// adapter at the loopback server, as integration-csv.test.mjs does.
async function withFixture(adapter, fixture, contentType, fn) {
  const body = await readFile(new URL(fixture, ROOT));
  const live = new URL(adapter.access.url);
  const srv = await startServer({
    [live.pathname]: (req, res) => { res.writeHead(200, { 'Content-Type': contentType }); res.end(body); },
  });
  const dir = await mkdtemp(join(tmpdir(), 'feed-int-'));
  const local = { ...adapter, host: '127.0.0.1', access: { ...adapter.access, url: `${srv.origin}${live.pathname}${live.search}` } };
  try {
    await fn({ adapter: local, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') } });
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTwice(adapter, paths) {
  const first = await runIngest({ adapter, paths, now: NOW });
  assert.equal(first.report.outcome, 'ok', JSON.stringify(first.report.failure ?? first.report.canary ?? first.report.errors));
  const second = await runIngest({ adapter, paths, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.report.outcome, 'ok');
  assert.equal(second.report.stages.fresh, 0);
  assert.equal(second.report.stages.written, 0);
  assert.equal(second.report.stages.changed, 0);
  return { report: first.report, records: await readRecords(paths.storeFile) };
}

async function repoAdapter(name) {
  return JSON.parse(await readFile(new URL(`adapters/${name}.adapter.json`, ROOT), 'utf8'));
}

function testAdapter(host, url) {
  return {
    version: 1,
    host,
    access: { tier: 0, kind: 'feed', url },
    map: {
      source_id: { path: 'id' },
      url: { path: 'url' },
      title: { path: 'title', normalize: 'text' },
      published: { path: 'published', normalize: 'iso-datetime' },
    },
    required: ['source_id', 'url', 'title', 'published'],
  };
}

function bySourceUrl(records, url) {
  const r = records.find((x) => x.source_url === url);
  assert.ok(r, `a record for ${url}`);
  return r;
}

test('wordpress.org: the repo adapter reads WordPress RSS', async () => {
  const adapter = await repoAdapter('wordpress.org');
  await withFixture(adapter, 'fixtures/wordpress.org/news-feed.xml', 'application/rss+xml; charset=UTF-8', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 3);
    assert.equal(records.length, 3);
    const r = bySourceUrl(records, 'https://wordpress.org/news/2026/10/wordpress-7-1-3-maintenance-and-security-release/');
    assert.equal(r.fields.title, 'WordPress 7.1.3 Maintenance and Security Release');
    assert.equal(r.fields.published, '2026-10-06T17:00:00.000Z');
    assert.equal(r.fields.source_id, 'https://wordpress.org/news/?p=21753');
    assert.equal(r.fields.author, 'Jake Spurlock');
    assert.ok(Array.isArray(r.fields.categories) && r.fields.categories.length > 0);
  });
});

test('github.com: the repo adapter reads a releases Atom feed', async () => {
  const adapter = await repoAdapter('github.com');
  await withFixture(adapter, 'fixtures/github.com/node-releases.atom', 'application/atom+xml; charset=utf-8', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 3);
    assert.equal(records.length, 3);
    const r = bySourceUrl(records, 'https://github.com/nodejs/node/releases/tag/v26.12.0');
    assert.equal(r.fields.title, '2026-10-14, Version 26.12.0 (Current), @richardlau');
    assert.equal(r.fields.updated, '2026-10-14T15:22:04.000Z');
    assert.equal(r.fields.source_id, 'tag:github.com,2008:Repository/27193779/v26.12.0');
    assert.equal(r.fields.author, 'richardlau');
  });
});

test('blog.python.org: RSS served as application/octet-stream is still read', async () => {
  const adapter = testAdapter('blog.python.org', 'https://blog.python.org/feeds/posts/default');
  await withFixture(adapter, 'fixtures/blog.python.org/posts.xml', 'application/octet-stream', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 3);
    const r = bySourceUrl(records, 'https://blog.python.org/2026/10/python-3160-alpha-1-is-now-available/');
    assert.equal(r.fields.title, 'Python 3.16.0 alpha 1 is now available');
    assert.equal(r.fields.published, '2026-10-13T00:00:00.000Z');
  });
});

test('feeds.bbci.co.uk: CDATA titles, and item links on another host are kept', async () => {
  const adapter = testAdapter('feeds.bbci.co.uk', 'https://feeds.bbci.co.uk/news/technology/rss.xml');
  await withFixture(adapter, 'fixtures/feeds.bbci.co.uk/technology.xml', 'text/xml; charset=utf-8', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 3);
    const r = bySourceUrl(records, 'https://www.bbc.co.uk/news/articles/c6gel2dlyxvyo?at_medium=RSS&at_campaign=rss');
    assert.equal(r.fields.title, 'Ex-OpenAI worker accused of planting device had Saudi support, says court filing');
    assert.equal(r.fields.published, '2026-10-19T21:12:30.000Z');
    assert.ok(records.every((x) => new URL(x.source_url).host === 'www.bbc.co.uk'));
  });
});
