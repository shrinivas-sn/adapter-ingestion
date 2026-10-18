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
const EXPECTED_TOP_LEVEL = new Set(['package.json', 'LICENSE', 'README.md', 'NOTES-generalization.md', 'MIGRATION-0.2.md', 'VERSIONING.md', 'UPGRADING.md', 'AGENTS.md', 'llms.txt']);
const EXPECTED_DIRS = new Set(['src', 'schema', 'types']);
const isExpectedPackedPath = (path) => EXPECTED_DIRS.has(path.split('/')[0]) || EXPECTED_TOP_LEVEL.has(path);

// Shared by both consumer scripts: one html page, one row, one relative link.
const HTML_FIXTURE = String.raw`
const HTML_ADAPTER = {
  version: 1, host: 'example.test',
  access: { tier: 2, kind: 'html', url: 'https://example.test/list/' },
  html: { mode: 'select', rows: 'table tr', fields: {
    title: { selector: 'a' }, link: { selector: 'a', attr: 'href', resolve_url: true } } },
  map: { source_id: { path: 'link' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
};
const HTML_PATHS = { storeFile: 'store-html.jsonl', runsDir: 'runs' };
const htmlImpl = async () => new Response('<table><tr><td><a href="/a">A</a></td></tr></table>',
  { headers: { 'content-type': 'text/html; charset=utf-8' } });
`;

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
${HTML_FIXTURE}

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

// cheerio is an optional peer: the install above must not have pulled it in,
// json-api must already have worked without it (it did, above), and an html
// adapter must fail with the clear install hint rather than a raw import error.
await assert.rejects(import('cheerio'), (err) => err.code === 'ERR_MODULE_NOT_FOUND');
await assert.rejects(
  runIngest({ adapter: HTML_ADAPTER, paths: HTML_PATHS, fetchImpl: htmlImpl, now: new Date() }),
  (err) => err.code === 'E_KIND_DEPENDENCY' && /npm install cheerio/.test(err.message),
);

console.log(JSON.stringify({
  ok: true,
  checks: ['imports-resolve-from-installed-package', 'first', 'replay', 'edit', 'broken-mapping-stale', 'filter', 'html-without-peer'],
}));
`;

// Run after cheerio is installed next to the package, the way a consumer opts in.
const CONSUMER_HTML_SCRIPT = String.raw`
import assert from 'node:assert/strict';
import { runIngest } from '@shrinivas-sn/adapter-ingestion';
import { readRecords } from '@shrinivas-sn/adapter-ingestion/store';
` + HTML_FIXTURE + String.raw`
const { report } = await runIngest({ adapter: HTML_ADAPTER, paths: HTML_PATHS, fetchImpl: htmlImpl, now: new Date() });
assert.equal(report.outcome, 'ok');
const records = await readRecords(HTML_PATHS.storeFile);
assert.equal(records.length, 1);
assert.equal(records[0].source_url, 'https://example.test/a');
assert.equal(records[0].fields.title, 'A');
console.log(JSON.stringify({ ok: true, checks: ['html-with-peer'] }));
`;

const CONSUMER_TYPES_SCRIPT = String.raw`
import { runIngest, type RunIngestOptions, type Report } from '@shrinivas-sn/adapter-ingestion';
import { validateAdapter } from '@shrinivas-sn/adapter-ingestion/adapter';
import { buildReport } from '@shrinivas-sn/adapter-ingestion/report';

const checked: { ok: boolean, errors: string[] } = validateAdapter({});
const report: Report = buildReport({});
const version: 2 = report.report_version;
const codes: string[] = report.notices.map((n) => n.code);

const options: RunIngestOptions = {
  adapter: {
    version: 1, host: 'example.test',
    access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
    map: { source_id: { path: 'id' }, url: { path: 'link' } },
  },
  paths: { storeFile: 'store.jsonl', runsDir: 'runs', historyFile: 'history.jsonl' },
};

export async function go() {
  const { report: r } = await runIngest(options);
  const outcome: 'ok' | 'stale' | 'error' | 'aborted' = r.outcome;
  // @ts-expect-error storeFile must be a string
  await runIngest({ ...options, paths: { storeFile: 1, runsDir: 'runs' } });
  return [checked, version, codes, outcome];
}
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

    // 5b. Opt in to html the way a consumer would: install the optional peer
    // next to the package, then prove the html kind runs end to end.
    const peerResult = await npm(
      ['install', 'cheerio@^1.2.0', '--no-save', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund'],
      consumerDir,
    );
    if (peerResult.code !== 0) fail('npm install of the optional cheerio peer failed', peerResult.stderr);
    await writeFile(join(consumerDir, 'consumer-html.mjs'), CONSUMER_HTML_SCRIPT);
    const htmlResult = await node([join(consumerDir, 'consumer-html.mjs')], consumerDir);
    if (htmlResult.code !== 0) {
      fail('the html consumer script (with cheerio) failed', htmlResult.stderr || htmlResult.stdout);
    }
    let htmlOutput;
    try {
      htmlOutput = JSON.parse(htmlResult.stdout.trim().split('\n').pop());
    } catch {
      fail('html consumer script produced unparseable output', htmlResult.stdout);
    }
    if (!htmlOutput.ok) fail('html consumer script reported failure', htmlResult.stdout);

    // 6. Confirm import + install alone had no CLI side effect: the only
    // files under the consumer directory are what npm install put there,
    // the consumer script itself, and what the consumer script explicitly
    // asked runIngest to write (store.jsonl/runs/).
    const allEntries = await readdir(consumerDir, { recursive: true });
    const unexpectedWrites = allEntries.filter((p) => {
      const top = p.split(/[\\/]/)[0];
      return top !== 'node_modules' && p !== 'package.json' && p !== 'consumer.mjs'
        && p !== 'consumer-html.mjs' && p !== 'store.jsonl' && p !== 'store-html.jsonl' && top !== 'runs';
    });
    if (unexpectedWrites.length > 0) fail('unexpected files written by import/install alone', unexpectedWrites.join('\n'));

    // 7. Types: a TypeScript consumer compiles against the installed
    // package's .d.mts files, and a wrong option type is rejected (the
    // @ts-expect-error line fails the build if the types were just `any`).
    // Uses this repo's own compiler; runs after step 6 so its files are not
    // counted as side effects of install/import.
    await writeFile(join(consumerDir, 'consumer-types.ts'), CONSUMER_TYPES_SCRIPT);
    await writeFile(join(consumerDir, 'tsconfig.json'), JSON.stringify({
      files: ['consumer-types.ts'],
      compilerOptions: { module: 'nodenext', target: 'es2022', strict: true, noEmit: true, skipLibCheck: true, types: [] },
    }, null, 2));
    const tscPath = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    const typesResult = await node([tscPath, '-p', join(consumerDir, 'tsconfig.json')], consumerDir);
    if (typesResult.code !== 0) fail('the TypeScript consumer did not type-check', typesResult.stdout || typesResult.stderr);

    // 8. The installed bin: through npm's own bin link (what `npx` uses),
    // and directly by path. Both must answer with the frozen --json shape.
    await writeFile(join(consumerDir, 'cli-adapter.json'), JSON.stringify({
      version: 1, host: 'example.test',
      access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
      map: { source_id: { path: 'id' }, url: { path: 'link' } },
    }));
    const viaLink = await npm(['exec', '--no', '--', 'adapter-ingestion', 'validate', 'cli-adapter.json', '--json'], consumerDir);
    if (viaLink.code !== 0) fail('the installed adapter-ingestion bin failed (npm exec)', viaLink.stderr || viaLink.stdout);
    const linkOut = JSON.parse(viaLink.stdout.trim().split('\n').pop());
    if (linkOut.ok !== true) fail('adapter-ingestion validate did not accept a valid adapter', viaLink.stdout);
    const cliPath = join(consumerDir, 'node_modules', '@shrinivas-sn', 'adapter-ingestion', 'src', 'cli.mjs');
    const direct = await node([cliPath, 'explain', 'E_FETCH', '--json'], consumerDir);
    if (direct.code !== 0 || JSON.parse(direct.stdout).code !== 'E_FETCH') fail('adapter-ingestion explain failed', direct.stderr || direct.stdout);

    const result = {
      tarball: packInfo.filename, version: packInfo.version, integrity: packInfo.integrity,
      shasum: packInfo.shasum, entryCount: packInfo.entryCount,
      files: packInfo.files.map((f) => f.path).sort(),
      consumerChecks: [...consumerOutput.checks, ...htmlOutput.checks, 'types', 'bin'],
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
