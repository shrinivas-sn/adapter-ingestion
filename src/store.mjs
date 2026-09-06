import { appendFile, readFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// A prior run killed mid-write (OOM, SIGKILL, a cancelled Actions job) can
// leave the store's last line truncated with no trailing newline. Appending
// straight onto that fuses a new, well-formed line onto the tail of a
// corrupt one -- the new record is unreadable and silently lost, not just
// the old one. Checking the file's actual last byte (not assuming the
// previous run always finished cleanly) is what makes append idempotent
// against that failure mode.
async function endsWithNewlineOrEmpty(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const { size } = await handle.stat();
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    await handle.read(buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  } finally {
    await handle?.close();
  }
}

export async function appendRecords(filePath, records) {
  if (!records.length) return 0;
  await mkdir(dirname(filePath), { recursive: true });
  const needsRepair = !(await endsWithNewlineOrEmpty(filePath));
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await appendFile(filePath, (needsRepair ? '\n' : '') + body, 'utf8');
  return records.length;
}

export async function readRecords(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed;
    // A single corrupt line must not make the whole store unreadable.
    try { parsed = JSON.parse(line); } catch { continue; }
    // JSON-valid but not a record object (a bare number/string/array/null)
    // must be skipped the same way -- readIndex below reads `.id` off every
    // entry this returns, which throws on anything that isn't an object.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    out.push(parsed);
  }
  return out;
}

// The store is append-only: an edited upstream record produces a second
// line with the same id, and readRecords (above) returns both versions on
// purpose -- it's the raw log. Anything that renders records to a user
// wants this instead: last-line-wins per id, so an edited listing appears
// once, not once per revision.
export async function readLatestRecords(filePath) {
  const byId = new Map();
  for (const r of await readRecords(filePath)) {
    if (r.id === undefined || r.id === null) continue;
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

export async function readIndex(filePath) {
  const idx = new Map();
  for (const r of await readRecords(filePath)) idx.set(r.id, r.content_hash);
  return idx;
}
