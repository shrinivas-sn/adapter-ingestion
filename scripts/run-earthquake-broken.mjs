import { readFile } from 'node:fs/promises';
import { runIngest } from '../src/run.mjs';

const adapter = JSON.parse(await readFile('adapters/earthquake.usgs.gov.adapter.json', 'utf8'));
// Simulate USGS renaming properties.mag -> properties.magnitude.
const broken = { ...adapter, map: { ...adapter.map, magnitude: { path: 'properties.magnitude', normalize: 'number' } } };
const fixture = JSON.parse(await readFile('fixtures/earthquake.usgs.gov/sample-1.json', 'utf8'));
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => fixture });

const { report, canary } = await runIngest({
  adapter: broken,
  paths: { storeFile: 'store/earthquake.usgs.gov.broken.jsonl', runsDir: 'runs/earthquake.usgs.gov.broken' },
  fetchImpl,
});
console.log(JSON.stringify({ report: report.stages, canary }, null, 2));
process.exit(canary.status === 'ok' ? 0 : 1);
