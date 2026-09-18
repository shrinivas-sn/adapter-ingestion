import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { IngestionError } from './errors.mjs';
export { withStoreLock } from './lock.mjs';

const CHUNK_BYTES = 64 * 1024;
const LF = 0x0a;
const CR = 0x0d;

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
    return buf[0] === LF;
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  } finally {
    await handle?.close();
  }
}

// Turns one line's accumulated byte slices into a record, or undefined if
// the line should be silently skipped (blank) or skipped with a warning
// (corrupt JSON, a JSON value that isn't a record object, or a record
// object missing the identity fields every reader depends on). Decoding to
// a string only happens here, once the complete line's bytes are known --
// never per chunk -- which is what keeps a multi-byte UTF-8 character that
// happened to straddle a chunk boundary intact.
function finalizeLine(slices, lineNumber, onWarning) {
  let buf = slices.length === 1 ? slices[0] : Buffer.concat(slices);
  if (buf.length > 0 && buf[buf.length - 1] === CR) buf = buf.subarray(0, buf.length - 1); // tolerate CRLF
  if (buf.length === 0) return undefined;

  const text = buf.toString('utf8');
  if (text.trim().length === 0) return undefined;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    onWarning?.({ code: 'W_STORE_CORRUPT_LINE', line: lineNumber });
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    onWarning?.({ code: 'W_STORE_CORRUPT_LINE', line: lineNumber });
    return undefined;
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0
      || typeof parsed.content_hash !== 'string' || parsed.content_hash.length === 0) {
    onWarning?.({ code: 'W_STORE_INVALID_RECORD', line: lineNumber });
    return undefined;
  }
  return parsed;
}

// Reads a JSONL store as a stream of records, bounded to CHUNK_BYTES of
// in-flight buffer at a time -- never the whole file. A line's bytes are
// held as an array of Buffer slices (references into copies made per read,
// not the reused read buffer itself) and concatenated exactly once, when
// the line actually completes; nothing here repeatedly concatenates on
// every incoming chunk, which is what would make a very long line quadratic.
export async function* iterateRecords(filePath, { maxLineBytes = 64_000_000, onWarning } = {}) {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return; // missing file yields no rows
    throw new IngestionError('E_STORE_READ', `failed to open store file: ${err.message}`, { cause: err });
  }

  const readBuf = Buffer.allocUnsafe(CHUNK_BYTES);
  let position = 0;
  let pending = [];
  let pendingBytes = 0;
  let lineNumber = 0;

  const append = (slice, forLineNumber) => {
    pending.push(slice);
    pendingBytes += slice.length;
    // Checked immediately on every append (whether it completes a line or
    // is just this chunk's leftover) so an oversized line is caught at the
    // earliest possible point, not after however much more of it exists.
    if (pendingBytes > maxLineBytes) {
      throw new IngestionError('E_STORE_LINE_LIMIT',
        `store line ${forLineNumber} exceeds maxLineBytes (${maxLineBytes})`,
        { details: { line: forLineNumber } });
    }
  };

  try {
    for (;;) {
      let bytesRead;
      try {
        ({ bytesRead } = await handle.read(readBuf, 0, CHUNK_BYTES, position));
      } catch (err) {
        throw new IngestionError('E_STORE_READ', `failed to read store file: ${err.message}`, { cause: err });
      }
      if (bytesRead === 0) break;
      position += bytesRead;

      let start = 0;
      for (let i = 0; i < bytesRead; i++) {
        if (readBuf[i] !== LF) continue;
        lineNumber++;
        append(Buffer.from(readBuf.subarray(start, i)), lineNumber);
        const record = finalizeLine(pending, lineNumber, onWarning);
        if (record !== undefined) yield record;
        pending = [];
        pendingBytes = 0;
        start = i + 1;
      }
      if (start < bytesRead) {
        append(Buffer.from(readBuf.subarray(start, bytesRead)), lineNumber + 1);
      }
    }
    // A final line with no trailing LF (a clean EOF, or a prior crash's
    // truncated tail) still gets processed, not silently dropped.
    if (pendingBytes > 0) {
      lineNumber++;
      const record = finalizeLine(pending, lineNumber, onWarning);
      if (record !== undefined) yield record;
    }
  } finally {
    // Runs on normal completion, on a thrown error (E_STORE_LINE_LIMIT/
    // E_STORE_READ above), and on a consumer stopping early (`break` out of
    // a `for await` loop invokes this generator's `return()`, which resumes
    // at the last `yield` and unwinds through this `finally` before the
    // generator actually completes) -- the handle is never leaked on any exit path.
    await handle.close();
  }
}

export async function readRecords(filePath, options = {}) {
  const out = [];
  for await (const record of iterateRecords(filePath, options)) out.push(record);
  return out;
}

// The store is append-only: an edited upstream record produces a second
// line with the same id, and readRecords (above) returns both versions on
// purpose -- it's the raw log. Anything that renders records to a user
// wants this instead: last-line-wins per id, so an edited listing appears
// once, not once per revision. Reduces directly over the iterator -- it
// never materializes the full history array readRecords does.
export async function readLatestRecords(filePath, options = {}) {
  const byId = new Map();
  for await (const record of iterateRecords(filePath, options)) byId.set(record.id, record);
  return [...byId.values()];
}

// Same direct-reduction shape as readLatestRecords, but keeps only the id
// and hash a caller needs to classify a new batch as fresh/changed/unchanged
// -- O(unique ids), never O(history length) and never a second full pass
// over the records readLatestRecords would have built.
export async function readIndex(filePath, options = {}) {
  const idx = new Map();
  for await (const record of iterateRecords(filePath, options)) idx.set(record.id, record.content_hash);
  return idx;
}

export async function appendRecords(filePath, records, { maxLineBytes = 64_000_000 } = {}) {
  if (!records.length) return 0;

  // Preflight the entire batch -- validate shape, serialize, and check size
  // for every record -- before any file is touched. A later invalid record
  // must never leave a partially-written file behind. Records are
  // serialized one at a time into an array of already-JSON-encoded lines,
  // never joined into one second full-batch string just to validate it.
  const lines = [];
  for (const record of records) {
    if (typeof record?.id !== 'string' || record.id.length === 0) {
      throw new IngestionError('E_STORE_WRITE', 'a record is missing a nonempty string id');
    }
    if (typeof record?.content_hash !== 'string' || record.content_hash.length === 0) {
      throw new IngestionError('E_STORE_WRITE', 'a record is missing a nonempty string content_hash');
    }
    let json;
    try {
      json = JSON.stringify(record);
    } catch (err) {
      throw new IngestionError('E_STORE_WRITE', 'a record could not be serialized to JSON', { cause: err });
    }
    if (Buffer.byteLength(json, 'utf8') > maxLineBytes) {
      throw new IngestionError('E_STORE_LINE_LIMIT', `a record's serialized line exceeds maxLineBytes (${maxLineBytes})`);
    }
    lines.push(json);
  }

  try {
    await mkdir(dirname(filePath), { recursive: true });
    const needsRepair = !(await endsWithNewlineOrEmpty(filePath));

    let handle;
    try {
      handle = await open(filePath, 'a');
      if (needsRepair) await handle.write('\n');
      for (const line of lines) await handle.write(line + '\n');
      await handle.sync();
    } finally {
      await handle?.close();
    }
  } catch (err) {
    throw new IngestionError('E_STORE_WRITE', `failed to write to store file: ${err.message}`, { cause: err });
  }

  return records.length;
}
