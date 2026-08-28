import { readFile } from 'node:fs/promises';
import { validateAdapter } from './adapter.mjs';
import { fetchAll } from './fetch.mjs';
import { extractAll } from './extract.mjs';
import { readIndex, appendRecords } from './store.mjs';
import { splitByIndex } from './dedupe.mjs';
import { buildReport, writeReport, readHistory } from './report.mjs';
import { checkCanary } from './canary.mjs';

export async function runIngest({ adapter, paths, since, fetchImpl, now = new Date() }) {
  const { ok, errors: invalid } = validateAdapter(adapter);
  if (!ok) throw new Error(`invalid adapter: ${invalid.join('; ')}`);

  const startedAt = now.toISOString();
  const { items } = await fetchAll(adapter, { since, fetchImpl });
  const { records, errors } = extractAll(items, adapter, { fetchedAt: startedAt });

  const index = await readIndex(paths.storeFile);
  const { fresh, changed, unchanged } = splitByIndex(records, index);
  await appendRecords(paths.storeFile, [...fresh, ...changed]);

  const report = buildReport({
    host: adapter.host, startedAt, finishedAt: new Date().toISOString(),
    stages: { fetched: items.length, parsed: records.length,
              fresh: fresh.length, changed: changed.length, unchanged: unchanged.length },
    errors,
  });
  await writeReport(paths.runsDir, report);

  const history = await readHistory(paths.runsDir, adapter.canary?.median_window ?? 5);
  const canary = checkCanary(report, history.slice(1), adapter.canary ?? {});
  return { report, canary };
}

// CLI: node src/run.mjs adapters/<HOST>.adapter.json [--since YYYY-MM-DD]
if (import.meta.url === `file://${process.argv[1]}`) {
  const adapterPath = process.argv[2];
  if (!adapterPath) { console.error('usage: node src/run.mjs <adapter.json> [--since YYYY-MM-DD]'); process.exit(2); }
  const sinceIdx = process.argv.indexOf('--since');
  const adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
  const { report, canary } = await runIngest({
    adapter,
    paths: { storeFile: `store/${adapter.host}.jsonl`, runsDir: `runs/${adapter.host}` },
    since: sinceIdx > -1 ? process.argv[sinceIdx + 1] : undefined,
  });
  console.log(JSON.stringify({ report: report.stages, canary }, null, 2));
  // A stale canary must fail the process so a scheduled run goes red rather than green.
  process.exit(canary.status === 'ok' ? 0 : 1);
}
