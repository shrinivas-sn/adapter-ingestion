// The csv kind against real files from three sources, offline: a research
// non-profit (Our World in Data), a science agency feed (USGS) and a
// benchmark site (LiveBench). Each fixture is the first rows of the live file,
// served byte-for-byte from a loopback server. Nothing here is site-specific
// code; the columns and templates live in the adapters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './helpers/http-server.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';

const ROOT = new URL('../', import.meta.url);
const NOW = new Date('2026-10-20T12:00:00Z');

// Serves the fixture at the adapter's own path and points a copy of the
// adapter at the loopback server, as integration-html.test.mjs does.
async function withFixture(adapter, fixture, fn) {
  const body = await readFile(new URL(fixture, ROOT));
  const live = new URL(adapter.access.url);
  const srv = await startServer({
    [live.pathname]: (req, res) => { res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' }); res.end(body); },
  });
  const dir = await mkdtemp(join(tmpdir(), 'csv-int-'));
  const local = { ...adapter, host: '127.0.0.1', access: { ...adapter.access, url: `${srv.origin}${live.pathname}${live.search}` } };
  try {
    await fn({ adapter: local, paths: { storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') } });
  } finally {
    await srv.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTwice(adapter, paths) {
  const first = await runIngest({ adapter, paths, now: NOW });
  assert.equal(first.report.outcome, 'ok', JSON.stringify(first.report.failure ?? first.report.errors));
  const second = await runIngest({ adapter, paths, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.report.outcome, 'ok');
  assert.equal(second.report.stages.fresh, 0);
  assert.equal(second.report.stages.written, 0);
  assert.equal(second.report.stages.changed, 0);
  return { report: first.report, records: await readRecords(paths.storeFile) };
}

test('ourworldindata.org: the repo adapter ingests every row, regions included', async () => {
  const adapter = JSON.parse(await readFile(new URL('adapters/ourworldindata.org.adapter.json', ROOT), 'utf8'));
  await withFixture(adapter, 'fixtures/ourworldindata.org/life-expectancy.csv', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.fetched, 33);
    assert.equal(report.stages.parsed, 33);
    const region = records.find((r) => r.fields.entity === 'Less developed regions, excluding China');
    assert.ok(region, 'the quoted region rows are kept');
    assert.equal(region.fields.code, null);
    assert.equal(region.fields.source_id, `Less developed regions, excluding China:${region.fields.year}`);
    assert.equal(typeof region.fields.life_expectancy, 'number');
    assert.ok(records.every((r) => r.source_url === 'https://ourworldindata.org/grapher/life-expectancy'));
  });
});

test('earthquake.usgs.gov CSV: quoted places stay whole, urls come from the id', async () => {
  const adapter = {
    version: 1,
    host: 'earthquake.usgs.gov',
    access: { tier: 0, kind: 'csv', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv' },
    map: {
      source_id: { path: 'id' },
      url: { template: 'https://earthquake.usgs.gov/earthquakes/eventpage/{id}' },
      place: { path: 'place', normalize: 'text' },
      magnitude: { path: 'mag', normalize: 'number' },
      time: { path: 'time', normalize: 'iso-datetime' },
    },
    required: ['source_id', 'url', 'magnitude'],
  };
  await withFixture(adapter, 'fixtures/earthquake.usgs.gov/all_day.csv', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 20);
    for (const r of records) {
      assert.equal(r.source_url, `https://earthquake.usgs.gov/earthquakes/eventpage/${r.fields.source_id}`);
      assert.match(r.fields.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    assert.ok(records.some((r) => r.fields.place.includes(', ')), 'a place with a comma survived quoting');
  });
});

test('livebench.ai cost CSV: a wide file keeps every column in raw', async () => {
  const adapter = {
    version: 1,
    host: 'livebench.ai',
    access: { tier: 0, kind: 'csv', url: 'https://livebench.ai/v1/cost_2026_06_25.csv' },
    map: {
      source_id: { path: 'model' },
      url: { template: 'https://livebench.ai/' },
      amps_hard: { path: 'AMPS_Hard', normalize: 'number' },
    },
    required: ['source_id', 'amps_hard'],
  };
  await withFixture(adapter, 'fixtures/livebench.ai/cost.csv', async ({ adapter: local, paths }) => {
    const { report, records } = await runTwice(local, paths);
    assert.equal(report.stages.parsed, 5);
    assert.ok(records.every((r) => Object.keys(r.raw).length === 76));
    assert.ok(records.every((r) => typeof r.fields.amps_hard === 'number'));
  });
});
