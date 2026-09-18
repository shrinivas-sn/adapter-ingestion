// Proves S04: readIndex/readLatestRecords reduce a large JSONL history under
// a small, fixed V8 heap -- because they stream (src/store.mjs's
// iterateRecords), not because there happens to be enough RAM on this
// machine. Not part of `npm test`; run manually with `node
// scripts/verify-store-scale.mjs`. Worker mode is guarded by an explicit
// `--worker` argv flag so `node --test` never picks this file up as a test.
import { open, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readIndex, readLatestRecords } from '../src/store.mjs';

const WORKER_FLAG = '--worker';
const TARGET_BYTES = 256 * 1024 * 1024;
const ID_COUNT = 100;
const PAD_CHARS = 4000; // ~4 KiB serialized line including JSON overhead
const BATCH_LINES = 200; // bounds in-memory batch to a few hundred KB, never the whole fixture
const HEAP_LIMIT_MB = 96;

// Writes the fixture as bounded batches, one open handle, tracking only the
// 100 ids' latest hashes (not the records themselves) as ground truth for
// the worker's assertions -- the full 256 MiB body is never held in memory.
async function generateFixture(filePath) {
  const pad = 'x'.repeat(PAD_CHARS);
  const expected = new Map();
  const handle = await open(filePath, 'w');
  try {
    let written = 0;
    let counter = 0;
    let batch = [];
    while (written < TARGET_BYTES) {
      const id = `scale:${counter % ID_COUNT}`;
      const contentHash = `rev-${counter}`;
      expected.set(id, contentHash);
      const line = JSON.stringify({ id, content_hash: contentHash, fields: { pad } }) + '\n';
      batch.push(line);
      written += Buffer.byteLength(line, 'utf8');
      counter++;
      if (batch.length >= BATCH_LINES) {
        await handle.write(batch.join(''));
        batch = [];
      }
    }
    if (batch.length) await handle.write(batch.join(''));
    await handle.sync();
    return { totalBytes: written, totalRecords: counter, expected };
  } finally {
    await handle.close();
  }
}

async function runWorker(storeFile, expectedFile) {
  const expected = JSON.parse(await readFile(expectedFile, 'utf8'));
  const expectedIds = Object.keys(expected);

  const t0 = process.hrtime.bigint();
  const idx = await readIndex(storeFile);
  const t1 = process.hrtime.bigint();
  const latest = await readLatestRecords(storeFile);
  const t2 = process.hrtime.bigint();

  const mem = process.memoryUsage();
  const failures = [];

  if (idx.size !== expectedIds.length) {
    failures.push(`readIndex: expected ${expectedIds.length} unique ids, got ${idx.size}`);
  }
  for (const id of expectedIds) {
    if (idx.get(id) !== expected[id]) failures.push(`readIndex: ${id} expected ${expected[id]}, got ${idx.get(id)}`);
  }

  if (latest.length !== expectedIds.length) {
    failures.push(`readLatestRecords: expected ${expectedIds.length} records, got ${latest.length}`);
  }
  const latestById = new Map(latest.map((r) => [r.id, r.content_hash]));
  for (const id of expectedIds) {
    if (latestById.get(id) !== expected[id]) {
      failures.push(`readLatestRecords: ${id} expected ${expected[id]}, got ${latestById.get(id)}`);
    }
  }

  console.log(JSON.stringify({
    heapLimitMb: HEAP_LIMIT_MB,
    uniqueIds: idx.size,
    readIndexMs: Number(t1 - t0) / 1e6,
    readLatestRecordsMs: Number(t2 - t1) / 1e6,
    heapUsedMb: mem.heapUsed / (1024 * 1024),
    rssMb: mem.rss / (1024 * 1024),
  }, null, 2));

  if (failures.length) {
    console.error('S04 FAILURES:\n' + failures.join('\n'));
    process.exitCode = 1;
  }
}

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'store-scale-'));
  const storeFile = join(dir, 'scale.jsonl');
  const expectedFile = join(dir, 'expected.json');
  try {
    console.log(`Generating a disposable ${(TARGET_BYTES / (1024 * 1024)).toFixed(0)} MiB fixture at ${storeFile} ...`);
    const genStart = Date.now();
    const { totalBytes, totalRecords, expected } = await generateFixture(storeFile);
    console.log(`Generated ${totalRecords} records / ${(totalBytes / (1024 * 1024)).toFixed(1)} MiB in ${Date.now() - genStart}ms.`);
    await writeFile(expectedFile, JSON.stringify(Object.fromEntries(expected)));

    const scriptPath = fileURLToPath(import.meta.url);
    console.log(`Spawning worker with --max-old-space-size=${HEAP_LIMIT_MB} ...`);
    const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_LIMIT_MB}`, scriptPath, WORKER_FLAG, storeFile, expectedFile],
      { stdio: 'inherit' });
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code));
    });

    if (exitCode !== 0) {
      console.error(`verify-store-scale: FAIL (worker exit code ${exitCode})`);
      process.exitCode = 1;
    } else {
      console.log('verify-store-scale: PASS');
    }
  } finally {
    // Only this run's own resolved temp directory -- never a real store/runs path.
    await rm(dir, { recursive: true, force: true });
  }
}

const argv = process.argv.slice(2);
if (argv[0] === WORKER_FLAG) {
  await runWorker(argv[1], argv[2]);
} else {
  await main();
}
