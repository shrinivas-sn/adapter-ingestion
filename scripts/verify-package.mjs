// Verifies the ACTUAL installed package artifact, not the repo's src/ tree:
// packs the real tarball, installs it into a disposable consumer package
// with the exact flags a real downstream install would use, then runs a
// consumer script that imports ONLY the installed package's public
// subpaths (never a relative src/ path, never NODE_PATH) and drives a full
// native-Response first/replay/edit/stale fixture flow against it.
// See plan.md Task 11.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const KEEP = process.argv.includes('--keep');

// Windows refuses to spawn a .cmd/.bat file at all without a shell (Node
// deliberately throws EINVAL post CVE-2024-27980 -- verified empirically
// against this exact environment); shell:true is required there. An
// *array* of arguments (never a concatenated string) stays safe under
// shell:true -- Node quotes each element individually for cmd.exe, verified
// empirically against a payload containing `"`, `&`, and `>` redirection.
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const USE_SHELL = process.platform === 'win32';

function run(cmd, args, cwd, extraOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...extraOptions });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

const npm = (args, cwd) => run(NPM_CMD, args, cwd, { shell: USE_SHELL });
const node = (args, cwd) => run(process.execPath, args, cwd);

function fail(message, detail) {
  const err = new Error(message);
  err.detail = detail;
  throw err;
}

// Everything npm always includes regardless of "files" (package.json,
// LICENSE, README) plus this package's own declared allowlist. Anything
// else in the packed tarball is a real leak (adapters/, fixtures/, scripts/,
// test/, plan.md, local store/run data, ...) and must fail loudly.
const EXPECTED_TOP_LEVEL = new Set(['package.json', 'LICENSE', 'README.md', 'NOTES-generalization.md', 'MIGRATION-0.2.md']);
const isExpectedPackedPath = (path) => path.split('/')[0] === 'src' || EXPECTED_TOP_LEVEL.has(path);

const CONSUMER_SCRIPT = String.raw`
import assert from 'node:assert/strict';
import { runIngest } from '@shrinivas-sn/adapter-ingestion';
import { validateAdapter, verifyAgainstFixtures } from '@shrinivas-sn/adapter-ingestion/adapter';
import { checkCanary } from '@shrinivas-sn/adapter-ingestion/canary';
import { canonicalize, contentHash, buildRecord, isValidSourceId, isValidSourceUrl } from '@shrinivas-sn/adapter-ingestion/contract';
import { splitByIndex } from '@shrinivas-sn/adapter-ingestion/dedupe';
import { extractAll, getPath } from '@shrinivas-sn/adapter-ingestion/extract';
import { fetchAll } from '@shrinivas-sn/adapter-ingestion/fetch';
import { validateFilter, applyFilter } from '@shrinivas-sn/adapter-ingestion/filter';
import { applyNormalizer, isValidDateOnly } from '@shrinivas-sn/adapter-ingestion/normalize';
import { buildReport, writeReport, readHistory } from '@shrinivas-sn/adapter-ingestion/report';
import { readRecords, readLatestRecords, readIndex, appendRecords, withStoreLock } from '@shrinivas-sn/adapter-ingestion/store';

// Confirms every import above actually came from the installed package
// under node_modules -- not a relative src/ fallback or NODE_PATH, which
// could otherwise let a broken "exports" map appear to work by accident.
for (const spec of [
  '@shrinivas-sn/adapter-ingestion', '@shrinivas-sn/adapter-ingestion/adapter',
  '@shrinivas-sn/adapter-ingestion/canary', '@shrinivas-sn/adapter-ingestion/contract',
  '@shrinivas-sn/adapter-ingestion/dedupe', '@shrinivas-sn/adapter-ingestion/extract',
  '@shrinivas-sn/adapter-ingestion/fetch', '@shrinivas-sn/adapter-ingestion/filter',
  '@shrinivas-sn/adapter-ingestion/normalize', '@shrinivas-sn/adapter-ingestion/report',
  '@shrinivas-sn/adapter-ingestion/store',
]) {
  const resolved = import.meta.resolve(spec);
  assert.ok(resolved.includes('node_modules'), spec + ' resolved outside node_modules: ' + resolved);
}

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9 },
};
assert.equal(validateAdapter(adapter).ok, true);

const items = [
  { id: 1, link: 'https://example.test/1', title: 'One' },
  { id: 2, link: 'https://example.test/2', title: 'Two' },
];
assert.equal(verifyAgainstFixtures(adapter, items).ratio, 1);

const impl = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
const paths = { storeFile: 'store.jsonl', runsDir: 'runs' };

const first = await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date() });
assert.equal(first.report.stages.fresh, 2, 'first run: every fixture record is fresh');
assert.equal(first.canary.status, 'ok');

const replay = await runIngest({ adapter, paths, fetchImpl: impl(items), now: new Date() });
assert.equal(replay.report.stages.written, 0, 'identical replay writes nothing new');

const edited = items.map((it) => (it.id === 1 ? { ...it, title: 'One (edited)' } : it));
const editRun = await runIngest({ adapter, paths, fetchImpl: impl(edited), now: new Date() });
assert.equal(editRun.report.stages.changed, 1, 'one edited mapped field changes exactly 1 record');
const latest = await readLatestRecords(paths.storeFile);
assert.equal(latest.length, 2, 'the latest view has one row per ID, not one per revision');

const broken = { ...adapter, map: { ...adapter.map, title: { path: 'nonexistent', normalize: 'text' } } };
const staleRun = await runIngest({ adapter: broken, paths, fetchImpl: impl(items), now: new Date() });
assert.equal(staleRun.canary.status, 'stale', 'a broken required mapping reports stale, not a silent success');

const stored = await readRecords(paths.storeFile);
assert.equal(stored.length, 3, '2 initial records + 1 edited revision, raw history');
const history = await readHistory(paths.runsDir, 5);
assert.ok(history.length >= 1, 'a real report artifact exists on disk');

const filterDef = { mode: 'all', rules: [{ field: 'fields.title', op: 'includes_any', value: ['One'] }] };
assert.equal(validateFilter(filterDef).ok, true);
const { kept } = applyFilter(latest, filterDef, new Date());
assert.ok(kept.length >= 1, 'the declarative filter runs against real stored records');

console.log(JSON.stringify({
  ok: true,
  checks: ['imports-resolve-from-installed-package', 'first', 'replay', 'edit', 'broken-mapping-stale', 'filter'],
}));
`;

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'verify-package-'));
  try {
    // 1. Pack the real tarball -- the exact artifact `npm publish` would upload.
    const packResult = await npm(['pack', '--json', '--pack-destination', tempRoot], repoRoot);
    if (packResult.code !== 0) fail('npm pack failed', packResult.stderr);
    let packInfo;
    try {
      [packInfo] = JSON.parse(packResult.stdout);
    } catch {
      fail('npm pack --json produced unparseable output', packResult.stdout);
    }

    // 2. Inspect the manifest: version and file allowlist.
    const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
    if (packInfo.version !== pkg.version) {
      fail(`packed version "${packInfo.version}" does not match package.json version "${pkg.version}"`);
    }
    const unexpected = packInfo.files.map((f) => f.path).filter((p) => !isExpectedPackedPath(p));
    if (unexpected.length > 0) fail('unexpected files in the packed tarball', unexpected.join('\n'));

    // 3. A disposable consumer package -- its own directory, its own
    // package.json, no relation to this repo's own package.json/lockfile.
    const consumerDir = join(tempRoot, 'consumer');
    await mkdir(consumerDir, { recursive: true });
    await writeFile(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'verify-package-consumer', version: '0.0.0', private: true, type: 'module',
    }, null, 2));

    // 4. Install the exact local tarball the way a real downstream install
    // would: no lifecycle scripts, no dev deps, no shared/updated lockfile.
    const tarballPath = join(tempRoot, packInfo.filename);
    const installResult = await npm(
      ['install', tarballPath, '--ignore-scripts', '--omit=dev', '--package-lock=false', '--no-audit', '--no-fund'],
      consumerDir,
    );
    if (installResult.code !== 0) fail('npm install of the packed tarball failed', installResult.stderr);

    // 5. A consumer script using ONLY the installed package's public exports.
    await writeFile(join(consumerDir, 'consumer.mjs'), CONSUMER_SCRIPT);
    const consumerResult = await node([join(consumerDir, 'consumer.mjs')], consumerDir);
    if (consumerResult.code !== 0) {
      fail('the installed-package consumer script failed', consumerResult.stderr || consumerResult.stdout);
    }
    let consumerOutput;
    try {
      consumerOutput = JSON.parse(consumerResult.stdout.trim().split('\n').pop());
    } catch {
      fail('consumer script produced unparseable output', consumerResult.stdout);
    }
    if (!consumerOutput.ok) fail('consumer script reported failure', consumerResult.stdout);

    // 6. Confirm import + install alone had no CLI side effect: the only
    // files under the consumer directory are what npm install put there,
    // the consumer script itself, and what the consumer script explicitly
    // asked runIngest to write (store.jsonl/runs/).
    const allEntries = await readdir(consumerDir, { recursive: true });
    const unexpectedWrites = allEntries.filter((p) => {
      const top = p.split(/[\\/]/)[0];
      return top !== 'node_modules' && p !== 'package.json' && p !== 'consumer.mjs'
        && p !== 'store.jsonl' && top !== 'runs';
    });
    if (unexpectedWrites.length > 0) fail('unexpected files written by import/install alone', unexpectedWrites.join('\n'));

    const result = {
      tarball: packInfo.filename, version: packInfo.version, integrity: packInfo.integrity,
      shasum: packInfo.shasum, entryCount: packInfo.entryCount,
      files: packInfo.files.map((f) => f.path).sort(),
      consumerChecks: consumerOutput.checks,
      platform: process.platform, nodeVersion: process.version,
    };
    console.log('verify-package: PASS');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (KEEP) console.error(`verify-package: candidate retained at ${tempRoot} (--keep)`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(`verify-package: FAIL -- ${err.message}`);
  if (err.detail) console.error(err.detail);
  process.exitCode = 1;
}
