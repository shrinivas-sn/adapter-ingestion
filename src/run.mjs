import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateAdapter } from './adapter.mjs';
import { fetchAll } from './fetch.mjs';
import { extractAll } from './extract.mjs';
import { readIndex, appendRecords } from './store.mjs';
import { splitByIndex } from './dedupe.mjs';
import { buildReport, writeReport, readHistory } from './report.mjs';
import { checkCanary } from './canary.mjs';

function newestValueOf(records, fieldName) {
  if (!fieldName) return null;
  let best = null;
  for (const r of records) {
    const v = r.fields?.[fieldName];
    if (v === null || v === undefined) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (best === null || t > new Date(best).getTime()) best = v;
  }
  return best;
}

export async function runIngest({ adapter, paths, since, fetchImpl, now = new Date() }) {
  const { ok, errors: invalid } = validateAdapter(adapter);
  if (!ok) throw new Error(`invalid adapter: ${invalid.join('; ')}`);

  const startedAt = now.toISOString();
  const stages = { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0 };
  let errors = [];
  let newestStalenessValue = null;
  let fatalError = null;
  let report;

  // A cron that reports success while returning nothing is the failure this
  // whole framework exists to prevent (README, "Gotchas") -- so a report
  // artifact must exist for THIS run whether it succeeds or throws. Every
  // stage that can fail (network, a malformed source shape, a full disk)
  // runs inside this block; the finally always writes what got as far as
  // it could, and the error is re-thrown afterward so the caller still sees
  // it as a failure.
  try {
    const { items } = await fetchAll(adapter, { since, fetchImpl });
    stages.fetched = items.length;

    const extracted = extractAll(items, adapter, { fetchedAt: startedAt });
    errors = extracted.errors;
    stages.parsed = extracted.records.length;
    newestStalenessValue = newestValueOf(extracted.records, adapter.canary?.staleness_field);

    const index = await readIndex(paths.storeFile);
    const { fresh, changed, unchanged } = splitByIndex(extracted.records, index);
    stages.fresh = fresh.length;
    stages.changed = changed.length;
    stages.unchanged = unchanged.length;
    await appendRecords(paths.storeFile, [...fresh, ...changed]);
  } catch (err) {
    fatalError = err instanceof Error ? err.message : String(err);
  } finally {
    report = buildReport({
      host: adapter.host, startedAt, finishedAt: new Date().toISOString(),
      stages, errors, fatalError, newestStalenessValue,
    });
    await writeReport(paths.runsDir, report);
  }

  if (fatalError) {
    const err = new Error(`ingest failed for ${adapter.host}: ${fatalError}`);
    err.report = report;
    throw err;
  }

  // +1: readHistory sees this run's own report (just written above) as the
  // newest entry. Without the +1, slice(1) below still drops it correctly,
  // but the window of *past* runs actually available to checkCanary shrinks
  // to median_window - 1 -- the trailing median silently gets computed over
  // one fewer sample than the adapter's own config asked for, which can be
  // enough to hide a real, gradual source collapse behind a still-passing
  // count_drop_ratio check.
  const history = await readHistory(paths.runsDir, (adapter.canary?.median_window ?? 5) + 1);
  const canary = checkCanary(report, history.slice(1), adapter.canary ?? {});
  return { report, canary };
}

// CLI: node src/run.mjs adapters/<HOST>.adapter.json [--since YYYY-MM-DD]
// import.meta.url is always an absolute file:// URL; process.argv[1] is a
// plain path that Node does NOT absolutize, and on Windows uses backslashes
// with no leading slash -- a naive `file://${argv[1]}` comparison never
// matches there, or for any relative invocation. pathToFileURL normalizes
// both platforms and both relative/absolute forms the same way import.meta
// already does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const adapterPath = process.argv[2];
  if (!adapterPath) { console.error('usage: node src/run.mjs <adapter.json> [--since YYYY-MM-DD]'); process.exit(2); }
  const sinceIdx = process.argv.indexOf('--since');
  const adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
  try {
    const { report, canary } = await runIngest({
      adapter,
      paths: { storeFile: `store/${adapter.host}.jsonl`, runsDir: `runs/${adapter.host}` },
      since: sinceIdx > -1 ? process.argv[sinceIdx + 1] : undefined,
    });
    console.log(JSON.stringify({ report: report.stages, canary }, null, 2));
    // A stale canary must fail the process so a scheduled run goes red rather than green.
    process.exit(canary.status === 'ok' ? 0 : 1);
  } catch (err) {
    console.error(`ingest failed: ${err.message}`);
    process.exit(1);
  }
}
