import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const baseAdapter = {
  version: 1, host: 'example.test',
  access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' },
    title: { path: 'title', normalize: 'text' } },
  required: ['title'],
};

export const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), { status: 200, ...init });

export async function tempPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'adapter-ingestion-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
}
