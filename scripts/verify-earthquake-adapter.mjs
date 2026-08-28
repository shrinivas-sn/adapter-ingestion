import { readFile } from 'node:fs/promises';
import { validateAdapter, verifyAgainstFixtures } from '../src/adapter.mjs';

const adapter = JSON.parse(await readFile('adapters/earthquake.usgs.gov.adapter.json', 'utf8'));
const fixture = JSON.parse(await readFile('fixtures/earthquake.usgs.gov/sample-1.json', 'utf8'));

const v = validateAdapter(adapter);
console.log('validateAdapter:', v);

const r = verifyAgainstFixtures(adapter, fixture.features);
console.log('verifyAgainstFixtures:', r);

if (!v.ok) process.exit(1);
if (r.ratio < 0.8) { console.error('ratio below 0.8 — refusing to emit'); process.exit(1); }
console.log('PASS');
