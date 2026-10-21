import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runBin, disposableCwd, assertNoLeakage, VALID_ADAPTER } from './helpers/bin.mjs';
import { startServer } from './helpers/http-server.mjs';

test('bin: no command is a usage error (exit 2)', async () => {
  const { code, stderr } = await runBin([]);
  assert.equal(code, 2);
  assert.match(stderr, /usage: adapter-ingestion/);
});

test('bin: --help prints usage and exits 0', async () => {
  const { code, stdout } = await runBin(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /usage: adapter-ingestion/);
});

test('bin --version prints the package version', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const text = await runBin(['--version']);
  assert.equal(text.code, 0);
  assert.equal(text.stdout.trim(), version);
  const json = await runBin(['--version', '--json']);
  assert.equal(json.code, 0);
  assert.equal(json.stdout.trim(), JSON.stringify({ version }));
});

test('bin: an unknown command exits 2, as JSON with --json', async () => {
  const text = await runBin(['frobnicate']);
  assert.equal(text.code, 2);
  assert.match(text.stderr, /unknown command: frobnicate/);
  const json = await runBin(['frobnicate', '--json']);
  assert.equal(json.code, 2);
  assert.deepEqual(JSON.parse(json.stdout), { error: { code: 'E_OPTIONS', message: 'unknown command: frobnicate' } });
});

test('bin: an unknown flag exits 2', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runBin(['validate', 'a.json', '--bogus'], { cwd });
  assert.equal(code, 2);
  assertNoLeakage(stderr);
});

test('bin validate: a valid adapter exits 0 (text and --json)', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify(VALID_ADAPTER));
  const text = await runBin(['validate', 'a.json'], { cwd });
  assert.equal(text.code, 0);
  assert.match(text.stdout, /^valid: a\.json/);
  const json = await runBin(['validate', 'a.json', '--json'], { cwd });
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), { ok: true, errors: [] });
});

test('bin validate: an invalid adapter exits 2 and lists every error', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify({ ...VALID_ADAPTER, version: 2, map: {} }));
  const json = await runBin(['validate', 'a.json', '--json'], { cwd });
  assert.equal(json.code, 2);
  const out = JSON.parse(json.stdout);
  assert.equal(out.ok, false);
  assert.ok(out.errors.includes('version must be 1'));
  assert.ok(out.errors.length >= 2);
  const text = await runBin(['validate', 'a.json'], { cwd });
  assert.match(text.stdout, /^invalid: a\.json\n {2}- version must be 1/);
});

test('bin validate: a missing file or bad JSON exits 2 with no stack trace or file content', async (t) => {
  const cwd = await disposableCwd(t);
  const missing = await runBin(['validate', 'nope.json', '--json'], { cwd });
  assert.equal(missing.code, 2);
  assert.deepEqual(JSON.parse(missing.stdout), { error: { code: 'E_OPTIONS', message: 'failed to load adapter "nope.json": file not found' } });
  await writeFile(join(cwd, 'bad.json'), '{ "secret-token-123": ');
  const bad = await runBin(['validate', 'bad.json'], { cwd });
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /not valid JSON/);
  assert.ok(!bad.stderr.includes('secret-token-123'));
  assertNoLeakage(bad.stderr);
});

test('bin validate: a missing path or an extra argument is a usage error', async () => {
  assert.equal((await runBin(['validate'])).code, 2);
  assert.equal((await runBin(['validate', 'a.json', 'b.json'])).code, 2);
});

test('bin explain: a known code prints meaning, cause and fix', async () => {
  const json = await runBin(['explain', 'E_FETCH', '--json']);
  assert.equal(json.code, 0);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(out), ['code', 'kind', 'meaning', 'cause', 'fix']);
  assert.equal(out.code, 'E_FETCH');
  const advice = await runBin(['explain', 'A_CANARY_NO_HISTORY']);
  assert.equal(advice.code, 0);
  assert.match(advice.stdout, /^A_CANARY_NO_HISTORY \(advice\)\nmeaning: /);
});

test('bin explain: a W_* code is explained', async () => {
  const json = await runBin(['explain', 'W_PAGE_LIMIT', '--json']);
  assert.equal(json.code, 0);
  const out = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(out), ['code', 'kind', 'meaning', 'cause', 'fix']);
  assert.equal(out.kind, 'warning');
});

test('bin explain: an unknown code exits 2', async () => {
  const { code, stdout } = await runBin(['explain', 'NOPE', '--json']);
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).error.code, 'E_OPTIONS');
  assert.equal((await runBin(['explain', 'constructor'])).code, 2);
});

// --- run ---

async function loopbackAdapter(t, cwd, { status = 200, body = [{ id: 1, link: 'https://example.test/1', title: 'One' }] } = {}) {
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });
  t.after(close);
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { retry: { max_attempts: 1 } },
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify(adapter));
  return adapter;
}

test('bin run: an ok run exits 0; --json has exactly the frozen keys', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  const { code, stdout } = await runBin(['run', 'adapter.json', '--json'], { cwd });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(Object.keys(out), ['outcome', 'stages', 'canary', 'notices', 'failure']);
  assert.equal(out.outcome, 'ok');
  assert.equal(out.failure, null);
  assert.equal(out.stages.written, 1);
  assert.ok((await readFile(join(cwd, 'store', '127.0.0.1.jsonl'), 'utf8')).includes('"id":"127.0.0.1:1"'));
});

test('bin run: notices go to stderr in text mode; the summary to stdout', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  const { code, stdout, stderr } = await runBin(['run', 'adapter.json'], { cwd });
  assert.equal(code, 0);
  assert.match(stdout, /^outcome: ok \(fetched 1, parsed 1, fresh 1, changed 0, unchanged 0, written 1\)/);
  assert.match(stderr, /notice A_CANARY_NO_HISTORY: /);
});

test('bin run: --history and --store/--runs are honoured', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  const { code, stdout } = await runBin(
    ['run', 'adapter.json', '--store', 'data/s.jsonl', '--runs', 'reports', '--history', 'data/h.jsonl', '--json'], { cwd });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).notices, []);
  assert.equal((await readFile(join(cwd, 'data', 'h.jsonl'), 'utf8')).trim().split('\n').length, 1);
  assert.ok((await readdir(join(cwd, 'reports'))).some((n) => n.startsWith('report-')));
  assert.ok((await readFile(join(cwd, 'data', 's.jsonl'), 'utf8')).length > 0);
});

test('bin run: an HTTP failure exits 1 with failure.code', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd, { status: 500, body: {} });
  const { code, stdout } = await runBin(['run', 'adapter.json', '--json'], { cwd });
  assert.equal(code, 1);
  const out = JSON.parse(stdout);
  assert.equal(out.outcome, 'error');
  assert.equal(out.failure.code, 'E_HTTP_STATUS');
});

test('bin run: an invalid adapter exits 2', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify({ ...VALID_ADAPTER, version: 2 }));
  const { code, stdout } = await runBin(['run', 'adapter.json', '--json'], { cwd });
  assert.equal(code, 2);
  assert.equal(JSON.parse(stdout).failure.code, 'E_ADAPTER_INVALID');
});

test('bin run: --history equal to --store is a config error (exit 2) with no stack trace', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  const { code, stdout, stderr } = await runBin(['run', 'adapter.json', '--store', 'x.jsonl', '--history', 'x.jsonl'], { cwd });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /paths.historyFile must differ from paths.storeFile/);
  assertNoLeakage(stderr);
});

test('bin run: an adapter with no host is refused before any path is derived', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify({ ...VALID_ADAPTER, host: undefined }));
  const { code, stderr } = await runBin(['run', 'adapter.json'], { cwd });
  assert.equal(code, 2);
  assert.match(stderr, /no usable "host"/);
  assert.deepEqual((await readdir(cwd)).sort(), ['adapter.json']);
});

// --- doctor ---

test('bin doctor: a valid adapter with no history exits 0 with A_CANARY_NO_HISTORY; --json keys are frozen', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify(VALID_ADAPTER));
  const { code, stdout } = await runBin(['doctor', 'a.json', '--json'], { cwd });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(Object.keys(out), ['ok', 'errors', 'notices', 'environment']);
  assert.equal(out.ok, true);
  assert.deepEqual(out.notices.map((n) => n.code), ['A_CANARY_NO_HISTORY']);
  assert.deepEqual(Object.keys(out.environment), ['node', 'node_ok', 'cheerio']);
  assert.equal(out.environment.node_ok, true);
  assert.equal(out.environment.cheerio, null);
});

test('bin doctor: a history file with one eligible run clears the advice', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  assert.equal((await runBin(['run', 'adapter.json', '--history', 'h.jsonl'], { cwd })).code, 0);
  const { code, stdout } = await runBin(['doctor', 'adapter.json', '--history', 'h.jsonl', '--json'], { cwd });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).notices, []);
});

test('bin doctor: past reports in the runs directory count as history too', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  assert.equal((await runBin(['run', 'adapter.json'], { cwd })).code, 0);
  const { stdout } = await runBin(['doctor', 'adapter.json', '--json'], { cwd });
  assert.deepEqual(JSON.parse(stdout).notices, []);
});

test('bin doctor: an invalid adapter exits 2 with its errors', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify({ ...VALID_ADAPTER, version: 2 }));
  const { code, stdout } = await runBin(['doctor', 'a.json', '--json'], { cwd });
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.ok(out.errors.includes('version must be 1'));
  assert.deepEqual(out.notices, []);
});

test('bin doctor: an html adapter reports whether cheerio resolves', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify({
    ...VALID_ADAPTER, access: { tier: 2, kind: 'html', url: 'https://example.test/list' },
    html: { mode: 'select', rows: 'tr', fields: { id: { attr: 'id' }, link: { selector: 'a', attr: 'href' }, title: { selector: 'a' } } },
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title' } },
  }));
  const { stdout } = await runBin(['doctor', 'a.json', '--json'], { cwd });
  // This repo has cheerio as a devDependency, so it resolves here.
  assert.equal(JSON.parse(stdout).environment.cheerio, true);
});

test('bin doctor: a feed adapter reports whether cheerio resolves', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify({
    version: 1,
    host: 'wordpress.org',
    access: { tier: 0, kind: 'feed', url: 'https://wordpress.org/news/feed/' },
    fetch: { headers: { 'User-Agent': 'adapter-ingestion-recipe/1.0' } },
    map: {
      source_id: { path: 'id' },
      url: { path: 'url' },
      title: { path: 'title', normalize: 'text' },
      summary: { path: 'summary', normalize: 'text' },
      author: { path: 'author', normalize: 'text' },
      categories: { path: 'categories' },
      published: { path: 'published', normalize: 'iso-datetime' },
    },
    required: ['source_id', 'url', 'title', 'published'],
    canary: {
      min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9,
      max_staleness_days: 60, staleness_field: 'published',
    },
  }));
  const { stdout } = await runBin(['doctor', 'a.json', '--json'], { cwd });
  // This repo has cheerio as a devDependency, so it resolves here.
  assert.equal(JSON.parse(stdout).environment.cheerio, true);
});

test('bin doctor --check-updates: a newer registry version is "available"', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify(VALID_ADAPTER));
  const { origin, close } = await startServer({
    default: (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9' }));
    },
  });
  t.after(close);
  const { code, stdout } = await runBin(['doctor', 'a.json', '--json', '--check-updates'],
    { cwd, env: { ADAPTER_INGESTION_REGISTRY: origin } });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.deepEqual(Object.keys(out), ['ok', 'errors', 'notices', 'environment', 'update']);
  assert.equal(out.update.status, 'available');
  assert.equal(out.update.latest, '9.9.9');
});

test('bin doctor --check-updates: an unreachable registry is "unavailable", exit code unchanged', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'a.json'), JSON.stringify(VALID_ADAPTER));
  const { origin, close } = await startServer({});
  await close();
  const { code, stdout } = await runBin(['doctor', 'a.json', '--json', '--check-updates'],
    { cwd, env: { ADAPTER_INGESTION_REGISTRY: origin } });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout).update, { status: 'unavailable', current: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version, latest: null });
});

async function editAdapter(cwd, edit) {
  const file = join(cwd, 'adapter.json');
  const adapter = JSON.parse(await readFile(file, 'utf8'));
  edit(adapter);
  await writeFile(file, JSON.stringify(adapter));
}

test('bin doctor: a misspelled canary is advised; ok and exit code unchanged', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  await editAdapter(cwd, (a) => { a.canry = { min_records: 1 }; });
  const { code, stdout } = await runBin(['doctor', 'adapter.json', '--json'], { cwd });
  assert.equal(code, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.notices.map((n) => n.code), ['A_CANARY_NO_HISTORY', 'A_TOP_LEVEL_KEY_TYPO']);
});

test('bin run: the typo notice prints on stderr; exit code unchanged', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  await editAdapter(cwd, (a) => { a.canry = { min_records: 1 }; });
  const { code, stderr } = await runBin(['run', 'adapter.json'], { cwd });
  assert.equal(code, 0);
  assert.ok(stderr.includes('notice A_TOP_LEVEL_KEY_TYPO: "canry" is not an adapter key'), stderr);
});

test('bin doctor: an invalid adapter with a typo still has empty notices', async (t) => {
  const cwd = await disposableCwd(t);
  await loopbackAdapter(t, cwd);
  await editAdapter(cwd, (a) => { a.record_path = 'x'; delete a.map; });
  const { code, stdout } = await runBin(['doctor', 'adapter.json', '--json'], { cwd });
  assert.equal(code, 2);
  const out = JSON.parse(stdout);
  assert.equal(out.ok, false);
  assert.deepEqual(out.notices, []);
});
