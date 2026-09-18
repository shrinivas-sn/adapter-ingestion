import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer } from './helpers/http-server.mjs';

const runMjsPath = fileURLToPath(new URL('../src/run.mjs', import.meta.url));

// Every test gets its own disposable cwd -- the CLI's default store/runs
// paths are always relative to it, so a run here can never touch this
// repo's own real store/runs directories.
async function disposableCwd(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function spawnCli(args, cwd) {
  const child = spawn(process.execPath, [runMjsPath, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function runCli(args, cwd) {
  return spawnCli(args, cwd).done;
}

function assertNoLeakage(stderr) {
  // A raw Node stack trace always contains "at " frame lines and/or a
  // "node:internal/..." module reference -- neither should ever reach a CLI
  // user for a file/JSON/config failure.
  assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(stderr), `stderr must not contain a raw stack trace, got: ${stderr}`);
  assert.ok(!stderr.includes('node:internal'), `stderr must not reference Node internals, got: ${stderr}`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// --- Usage errors: exit 2, no runIngest ever attempted ---

test('CLI: no arguments at all is a usage error (exit 2)', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli([], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /adapter\.json path is required/);
});

test('CLI: an unknown flag is a usage error (exit 2)', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli(['a.json', '--bogus'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /unknown flag: --bogus/);
});

test('CLI: --since given twice is a usage error (exit 2)', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli(['a.json', '--since', '2026-01-01', '--since', '2026-01-02'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /--since may only be given once/);
});

test('CLI: --since with no value is a usage error (exit 2)', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli(['a.json', '--since'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /--since requires a value/);
});

test('CLI: an extra positional argument is a usage error (exit 2)', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli(['a.json', 'b.json'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /unexpected extra argument: b\.json/);
});

// --- File/JSON/config failures: exit 2, no stack or body leakage, no fabricated report location ---

test('CLI: a nonexistent adapter file is exit 2 with a concise message, no stack trace', async (t) => {
  const cwd = await disposableCwd(t);
  const { code, stderr } = await runCli(['nope.json'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /file not found/);
  assertNoLeakage(stderr);
});

test('CLI: malformed JSON is exit 2 with a concise message, no file content or stack leaked', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'bad.json'), '{SECRET_MARKER not valid json', 'utf8');
  const { code, stderr } = await runCli(['bad.json'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /not valid JSON/);
  assert.ok(!stderr.includes('SECRET_MARKER'), 'the file\'s own content must never appear in the error message');
  assertNoLeakage(stderr);
});

test('CLI: a missing/invalid host is exit 2 and never derives or creates a fabricated report location', async (t) => {
  const cwd = await disposableCwd(t);
  await writeFile(join(cwd, 'nohost.json'), JSON.stringify({ version: 1 }), 'utf8');
  const { code, stderr } = await runCli(['nohost.json'], cwd);
  assert.equal(code, 2);
  assert.match(stderr, /no usable "host"/);
  assert.equal(await pathExists(join(cwd, 'runs')), false, 'no runs/ directory of any name may be created');
  assert.equal(await pathExists(join(cwd, 'store')), false, 'no store/ directory of any name may be created');
});

// --- A real successful run against a real local server ---

test('CLI: a real successful run writes store + report artifacts under the invocation cwd, exits 0', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, link: 'https://example.test/1', title: 'One' }]));
    },
  });
  t.after(close);

  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET' },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify(adapter), 'utf8');

  const { code, stdout } = await runCli(['adapter.json'], cwd);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.report.outcome, 'ok');
  assert.equal(parsed.report.stages.fresh, 1);

  const stored = await readFile(join(cwd, 'store', '127.0.0.1.jsonl'), 'utf8');
  assert.ok(stored.includes('"id":"127.0.0.1:1"'));
  const reportFiles = (await readdir(join(cwd, 'runs', '127.0.0.1'))).filter((n) => n.startsWith('report-'));
  assert.equal(reportFiles.length, 1);
});

test('CLI: --since is honored for an adapter that configures incremental fetch', async (t) => {
  const cwd = await disposableCwd(t);
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      const since = new URL(req.url, 'http://x').searchParams.get('since');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(since ? [{ id: 1, link: 'https://example.test/1', title: 'One' }] : []));
    },
  });
  t.after(close);

  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', incremental: { param: 'since', type: 'iso-date' } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify(adapter), 'utf8');

  const { code, stdout } = await runCli(['adapter.json', '--since', '2026-01-01'], cwd);
  assert.notEqual(code, 2, `expected --since to be accepted, got usage-error exit 2: ${stdout}`);
  const reportFiles = await readdir(join(cwd, 'runs', '127.0.0.1'));
  const report = JSON.parse(await readFile(join(cwd, 'runs', '127.0.0.1', reportFiles[0]), 'utf8'));
  assert.equal(report.mode, 'incremental', 'the report must reflect that --since actually switched the run to incremental mode');
});

// --- Importing as a library must never trigger CLI side effects ---

test('CLI: importing run.mjs as a library (not executing it directly) writes nothing and never exits the process', async (t) => {
  const cwd = await disposableCwd(t);
  const probe = `
    import '${pathToFileURL(runMjsPath).href}';
    console.log('IMPORTED_OK');
  `;
  await writeFile(join(cwd, 'probe.mjs'), probe, 'utf8');
  const child = spawn(process.execPath, [join(cwd, 'probe.mjs')], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const result = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
  assert.equal(result, 0);
  assert.match(out, /IMPORTED_OK/);
  assert.equal(await pathExists(join(cwd, 'store')), false, 'a library import must never write a store file');
  assert.equal(await pathExists(join(cwd, 'runs')), false, 'a library import must never write a report');
});

// --- SIGINT: graceful abort, no partial/corrupt store write ---
// Windows cannot deliver a real POSIX signal to a spawned child process --
// child.kill('SIGINT')/('SIGTERM') there forcefully terminates immediately
// without ever invoking the child's own signal handler (verified empirically
// against this exact CLI: the handler's console output never appears, and
// the child's exit code is always `null` with the raw signal name attached,
// which is Windows-level force-termination, not the graceful E_ABORTED path
// this test exists to prove). This is a Node/Windows platform limitation,
// not a gap in this CLI -- real interactive Ctrl+C on Windows, and any
// signal on Linux/macOS (including this same child.kill() call, which CI's
// ubuntu-latest matrix cell actually exercises), both work correctly.
test('CLI: SIGINT aborts gracefully mid-fetch -- exit 1 (not 0/2), no store mutation', { skip: process.platform === 'win32' ? 'Windows cannot deliver a real signal to a spawned child process (see comment above)' : false }, async (t) => {
  let resolveRequestReceived;
  const requestReceived = new Promise((resolve) => { resolveRequestReceived = resolve; });
  const { origin, close } = await startServer({
    '/data': (req, res) => {
      resolveRequestReceived();
      // Never responds -- the CLI's fetch stays genuinely in-flight until
      // the signal below aborts it.
    },
  });
  t.after(close);

  const cwd = await disposableCwd(t);
  const adapter = {
    version: 1, host: '127.0.0.1',
    access: { tier: 0, kind: 'json-api', url: `${origin}/data` },
    fetch: { method: 'GET', timeout_ms: 30_000, retry: { max_attempts: 1 } },
    records_path: '$',
    map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
    required: ['source_id', 'url', 'title'],
  };
  await writeFile(join(cwd, 'adapter.json'), JSON.stringify(adapter), 'utf8');

  const { child, done } = spawnCli(['adapter.json'], cwd);
  await requestReceived;
  child.kill('SIGINT');
  const result = await done;

  assert.equal(result.code, 1, 'an aborted run is exit 1 (operational), not 0 or 2');
  assert.match(result.stderr, /ingest failed/);
  assert.equal(await pathExists(join(cwd, 'store')), false, 'an abort mid-fetch must never mutate the store');
});
