import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/http-server.mjs';
import { resolveKind, builtinKindNames } from '../src/kinds/index.mjs';
import { runIngest } from '../src/run.mjs';

test('json-api is a built-in kind that parses bytes exactly like the old JSON path', () => {
  assert.deepEqual(resolveKind('json-api').parse({ bytes: Buffer.from('[1]') }), [1]);
  assert.equal(resolveKind('json-api').parse({ bytes: Buffer.alloc(0) }), null);
});

test('an unknown kind resolves to null', () => {
  assert.equal(resolveKind('nope'), null);
});

test('builtinKindNames is sorted', () => {
  const names = builtinKindNames();
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('json-api'));
});

// Lines of "id,link,title" -> one item each: the smallest realistic custom format.
const csvKind = {
  parse({ bytes }) {
    return bytes.toString('utf8').trim().split('\n').map((line) => {
      const [id, link, title] = line.split(',');
      return { id, link, title };
    });
  },
};

async function withCsvServer(body, fn) {
  const srv = await startServer({ '/feed.csv': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv' }); res.end(body); } });
  const dir = await mkdtemp(join(tmpdir(), 'kinds-'));
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 1, kind: 'csv', url: `${srv.origin}/feed.csv` },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
    required: ['source_id', 'url', 'title'],
  };
  try {
    await fn({ adapter, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') }, dir });
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAllText(dir) {
  let text = '';
  for (const f of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) text += await readFile(join(f.parentPath, f.name), 'utf8');
  }
  return text;
}

test('runIngest ingests a caller-registered kind end to end', async () => {
  await withCsvServer('a,https://127.0.0.1/a,First\nb,https://127.0.0.1/b,Second\n', async ({ adapter, paths }) => {
    const { report } = await runIngest({ adapter, paths, kinds: { csv: csvKind } });
    assert.equal(report.outcome, 'ok');
    assert.equal(report.stages.fresh, 2);
  });
});

test('a kind that throws becomes E_PARSE and its message never reaches the report', async () => {
  const leaky = { parse() { throw new Error('secret token abc'); } };
  await withCsvServer('x', async ({ adapter, paths }) => {
    await assert.rejects(runIngest({ adapter, paths, kinds: { csv: leaky } }), (err) => {
      assert.equal(err.code, 'E_PARSE');
      assert.equal(err.message, 'kind "csv" failed to parse the response');
      return true;
    });
    const persisted = await readAllText(paths.runsDir);
    assert.match(persisted, /E_PARSE/);
    assert.doesNotMatch(persisted, /secret token abc/);
  });
});

test('a kinds option that shadows a built-in, or is malformed, is E_OPTIONS', async () => {
  await withCsvServer('x', async ({ adapter, paths }) => {
    await assert.rejects(runIngest({ adapter, paths, kinds: { 'json-api': csvKind } }),
      { code: 'E_OPTIONS', message: 'kinds.json-api shadows a built-in kind' });
    await assert.rejects(runIngest({ adapter, paths, kinds: { csv: { parse: 'nope' } } }), { code: 'E_OPTIONS' });
    await assert.rejects(runIngest({ adapter, paths, kinds: [csvKind] }), { code: 'E_OPTIONS' });
  });
});

test('a kind returning a non-array still hits the records_path array check', async () => {
  await withCsvServer('x', async ({ adapter, paths }) => {
    await assert.rejects(runIngest({ adapter, paths, kinds: { csv: { parse: () => 'not-an-array' } } }),
      { code: 'E_RESPONSE_SHAPE' });
  });
});

test('an async kind is awaited', async () => {
  await withCsvServer('a,https://127.0.0.1/a,First\n', async ({ adapter, paths }) => {
    const asyncKind = { parse: async (input) => csvKind.parse(input) };
    const { report } = await runIngest({ adapter, paths, kinds: { csv: asyncKind } });
    assert.equal(report.stages.fresh, 1);
  });
});

test('fetchAll passes max_records to an html page, so a huge page fails before it is materialised', async () => {
  const { fetchAll } = await import('../src/fetch.mjs');
  const page = `<ul>${'<li><a href="/x">x</a></li>'.repeat(50)}</ul>`;
  const adapter = {
    version: 1, host: 'example.test',
    access: { tier: 2, kind: 'html', url: 'https://example.test/' },
    fetch: { max_records: 20 },
    html: { mode: 'select', rows: 'li', fields: { link: { selector: 'a', attr: 'href', resolve_url: true } } },
  };
  const fetchImpl = async () => new Response(page, { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchAll(adapter, { fetchImpl }), { code: 'E_RECORD_LIMIT', message: 'fetch exceeded max_records (20)' });
});

test('records a kind cannot serialise are E_PARSE, not a raw TypeError', async () => {
  await withCsvServer('x', async ({ adapter, paths }) => {
    await assert.rejects(runIngest({ adapter, paths, kinds: { csv: { parse: () => [{ id: 1n }] } } }), { code: 'E_PARSE' });
  });
});

test('even an IngestionError thrown inside a caller kind becomes a generic E_PARSE', async () => {
  const { buildRecord } = await import('../src/contract.mjs');
  // A caller kind that lets one of our own errors escape, carrying caller-chosen text.
  const leaky = { parse() { buildRecord({ host: 'h', sourceId: 'secret token abc', sourceUrl: 'nope' }); } };
  await withCsvServer('x', async ({ adapter, paths }) => {
    await assert.rejects(runIngest({ adapter, paths, kinds: { csv: leaky } }), (err) => {
      assert.equal(err.code, 'E_PARSE');
      assert.equal(err.message, 'kind "csv" failed to parse the response');
      return true;
    });
    assert.doesNotMatch(await readAllText(paths.runsDir), /secret token abc/);
  });
});

test('html has a 5 MB default byte cap (DOM memory is many times the page size); an explicit cap wins', async () => {
  const { fetchAll } = await import('../src/fetch.mjs');
  const body = '<p>' + ' '.repeat(5_000_000) + '</p>';
  const adapter = {
    version: 1, host: 'example.test',
    access: { tier: 2, kind: 'html', url: 'https://example.test/' },
    html: { mode: 'select', rows: 'li', fields: { title: {} } },
  };
  const fetchImpl = async () => new Response(body, { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchAll(adapter, { fetchImpl }), { code: 'E_RESPONSE_LIMIT', message: 'response exceeded max_response_bytes (5000000)' });
  const raised = { ...adapter, fetch: { max_response_bytes: 6_000_000 } };
  assert.deepEqual((await fetchAll(raised, { fetchImpl })).items, []);
  // json-api keeps its 20 MB default.
  const json = { ...adapter, access: { ...adapter.access, kind: 'json-api' }, html: undefined };
  const jsonImpl = async () => new Response(`[${' '.repeat(6_000_000)}]`);
  assert.deepEqual((await fetchAll(json, { fetchImpl: jsonImpl })).items, []);
});
