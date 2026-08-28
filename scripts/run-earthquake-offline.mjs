import { readFile } from 'node:fs/promises';
import { runIngest } from '../src/run.mjs';

const adapter = JSON.parse(await readFile('adapters/earthquake.usgs.gov.adapter.json', 'utf8'));
const fixture = JSON.parse(await readFile('fixtures/earthquake.usgs.gov/sample-1.json', 'utf8'));
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => fixture });

const { report, canary } = await runIngest({
  adapter,
  paths: { storeFile: 'store/earthquake.usgs.gov.jsonl', runsDir: 'runs/earthquake.usgs.gov' },
  fetchImpl,
});
console.log(JSON.stringify({ report: report.stages, canary }, null, 2));
