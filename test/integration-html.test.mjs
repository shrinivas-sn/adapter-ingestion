// The html kind against real pages from seven sites on six platforms, offline:
// each repo adapter runs through runIngest against a loopback server that
// serves its recorded fixture byte-for-byte with the Content-Type the live
// site sent (see fixtures/*/page-1.html). Nothing here is site-specific code;
// the selectors live in the adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/http-server.mjs';
import { runIngest } from '../src/run.mjs';
import { fetchAll } from '../src/fetch.mjs';
import { readRecords } from '../src/store.mjs';

const ROOT = new URL('../', import.meta.url);

// host -> the Content-Type header recorded when the fixture was captured.
const RECORDED = {
  'news.ycombinator.com': 'text/html; charset=utf-8',
  'books.toscrape.com': 'text/html',
  'lib.ru': 'text/html; charset=koi8-r',
  'ksp-recruitment.in': 'text/html',
  'hassan.nic.in': 'text/html; charset=UTF-8',
  'cutshort.io': 'text/html; charset=utf-8',
  'hashnode.com': 'text/html; charset=utf-8',
};

async function loadAdapter(host) {
  return JSON.parse(await readFile(new URL(`adapters/${host}.adapter.json`, ROOT), 'utf8'));
}

// Serves the fixture at the adapter's own path, and points a copy of the
// adapter at the loopback server -- the same pattern as integration.test.mjs.
async function withFixtureServer(host, fn) {
  const adapter = await loadAdapter(host);
  const body = await readFile(new URL(`fixtures/${host}/page-1.html`, ROOT));
  const live = new URL(adapter.access.url);
  const srv = await startServer({
    [live.pathname]: (req, res) => { res.writeHead(200, { 'Content-Type': RECORDED[host] }); res.end(body); },
  });
  const dir = await mkdtemp(join(tmpdir(), 'html-int-'));
  const local = { ...adapter, host: '127.0.0.1', access: { ...adapter.access, url: `${srv.origin}${live.pathname}${live.search}` } };
  try {
    await fn({ adapter: local, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') } });
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

for (const host of Object.keys(RECORDED)) {
  test(`${host}: every row on the recorded page becomes a valid record, and a re-run is unchanged`, async () => {
    await withFixtureServer(host, async ({ adapter, paths }) => {
      const first = await runIngest({ adapter, paths });
      assert.equal(first.report.outcome, 'ok', JSON.stringify(first.report.failure ?? first.report.errors));
      assert.ok(first.report.stages.fetched > 0);
      assert.equal(first.report.stages.parsed, first.report.stages.fetched, JSON.stringify(first.report.errors));

      // Idempotent re-run: nothing new or changed. Compared with what the first
      // run kept, not with `fetched`, because a page may list the same link
      // twice (lib.ru does) and rows sharing a source_id collapse to one.
      const second = await runIngest({ adapter, paths });
      assert.equal(second.report.stages.fresh, 0);
      assert.equal(second.report.stages.changed, 0);
      assert.equal(second.report.stages.unchanged, first.report.stages.fresh);
    });
  });
}

// Spot values prove decoding and selectors, not just counts: each one covers a
// different charset declaration or markup shape.
test('decoded values are right for each encoding case', async () => {
  const titles = async (host) => {
    let out;
    await withFixtureServer(host, async ({ adapter, paths }) => {
      await runIngest({ adapter, paths });
      out = (await readRecords(paths.storeFile)).map((r) => r.fields.title);
    });
    return out;
  };
  // KOI8-R in the header only.
  assert.ok((await titles('lib.ru')).some((t) => /[А-Яа-я]{4}/.test(t)));
  // BOM + meta, no header charset.
  assert.ok((await titles('ksp-recruitment.in')).some((t) => t.startsWith('Special Reserve Police Constable')));
  // meta charset only; non-ASCII title text.
  assert.ok((await titles('books.toscrape.com')).includes('A Light in the Attic'));
  // header only; a non-ASCII en dash survives.
  assert.ok((await titles('news.ycombinator.com')).some((t) => t.includes('–')));
});

test('cutshort.io: the real __NEXT_DATA__ island parses through fetchAll', async () => {
  await withFixtureServer('cutshort.io', async ({ adapter }) => {
    const nextData = {
      ...adapter,
      html: { mode: 'script_json', script: 'script#__NEXT_DATA__' },
      records_path: 'props.pageProps.dehydratedState.queries.0.state.data.data.pageData.topJobsList',
    };
    const { items } = await fetchAll(nextData);
    assert.equal(items.length, 32);
    assert.equal(typeof items[0].slug, 'string');
  });
});
