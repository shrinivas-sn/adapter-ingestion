import { readFile, rm } from 'node:fs/promises';
import { validateAdapter, verifyAgainstFixtures } from '../src/adapter.mjs';
import { runIngest } from '../src/run.mjs';

const adapter = JSON.parse(await readFile('adapters/api.github.com.adapter.json', 'utf8'));
const fixture = JSON.parse(await readFile('fixtures/api.github.com/sample-1.json', 'utf8'));

const v = validateAdapter(adapter);
console.log('validateAdapter:', v);

const r = verifyAgainstFixtures(adapter, fixture);
console.log('verifyAgainstFixtures:', r);

if (!v.ok) process.exit(1);
if (r.ratio < 0.8) { console.error('ratio below 0.8 — refusing to emit'); process.exit(1); }

// Fixture-driven runs write to throwaway paths on purpose: the fixture is a 5-record
// sample, and letting it into runs/api.github.com would poison the real
// count_drop_ratio trailing median for this host.
const paths = {
  storeFile: 'store/scratch-api.github.com.jsonl',
  runsDir: 'runs/scratch-api.github.com',
};
const fetchImpl = async () => new Response(JSON.stringify(fixture), { status: 200 });
const now = new Date();

const healthy = await runIngest({ adapter, paths, fetchImpl, now });
console.log('healthy offline run:', JSON.stringify({ stages: healthy.report.stages, canary: healthy.canary }, null, 2));

// The source-shape regression this adapter must notice: upstream renames the id field.
const broken = structuredClone(adapter);
broken.map.source_id.path = 'ghsa_id_renamed_upstream';
const brokenRun = await runIngest({ adapter: broken, paths, fetchImpl, now });
console.log('renamed-id run:', JSON.stringify({ stages: brokenRun.report.stages, canary: brokenRun.canary }, null, 2));

await rm(paths.storeFile, { force: true });
await rm(paths.runsDir, { recursive: true, force: true });

const ok =
  healthy.canary.status === 'ok'
  && healthy.report.stages.parsed === fixture.length
  && brokenRun.canary.status === 'stale';
if (!ok) {
  console.error('FAIL: expected canary ok on the fixture run and stale on the renamed-path run');
  process.exit(1);
}
console.log('PASS');
