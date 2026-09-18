import { mkdir, open, unlink, readFile, lstat, realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { hostname } from 'node:os';
import { IngestionError, safeFailure, addSecondaryError } from './errors.mjs';

// Test-only injection point: lets a test force a failure in the narrow
// window between the lock file's exclusive creation and its metadata write
// finishing -- a real portable OS-level error can't be arranged there
// without touching ACLs, so this is the "internal filesystem seam" the
// plan allows for exactly this case. Never read from adapter JSON or any
// public option; only a test importing this module directly can set it.
export const __testHooks = {
  afterCreateBeforeMetadata: null,
};

// realpath-ing the parent (after creating it if missing) means two
// different paths that happen to reach the same physical directory --
// through a symlinked parent, a relative vs. absolute path, whatever --
// resolve to the identical canonical lock target, which is what "same
// canonical local path used by all writers" actually requires. The store
// file itself must not be a symlink: this package treats the lock and the
// file it protects as one physical thing, and following a symlinked store
// file would let two different-looking paths silently share (or fail to
// share) a lock in a way a caller can't see.
async function resolveCanonicalStoreFile(filePath) {
  const parent = dirname(filePath);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await realpath(parent);
  const canonicalStoreFile = join(canonicalParent, basename(filePath));

  let stat;
  try {
    stat = await lstat(canonicalStoreFile);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    stat = null;
  }
  if (stat?.isSymbolicLink()) {
    throw new IngestionError('E_OPTIONS', 'store file must not be a symlink');
  }
  return canonicalStoreFile;
}

// Verifies this invocation still owns the lock before touching it -- a
// contender must never remove another run's lock, so an unreadable,
// unparseable, or run_id-mismatched lock file is refused, not deleted.
async function releaseLock(lockPath, runId) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (err) {
    throw new IngestionError('E_LOCK_RELEASE',
      'could not verify lock ownership before release', { cause: err });
  }
  if (metadata.run_id !== runId) {
    throw new IngestionError('E_LOCK_RELEASE',
      'the lock file no longer matches this run; refusing to remove a lock that may belong to another run');
  }
  try {
    await unlink(lockPath);
  } catch (err) {
    throw new IngestionError('E_LOCK_RELEASE', 'failed to remove the lock file', { cause: err });
  }
}

// Whole-run cooperative exclusion (section 5.2): only one runIngest-style
// caller may hold a given store's lock at a time, on this local platform.
// No polling, no stealing, no PID/age-based takeover -- an existing lock is
// always an immediate E_STORE_LOCKED, and only an operator's explicit,
// out-of-band recovery (removing the .lock file after confirming the owner
// is really gone) can ever clear one left behind by a crash.
export async function withStoreLock(filePath, { runId } = {}, callback) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new IngestionError('E_OPTIONS', 'withStoreLock requires a nonempty store file path');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new IngestionError('E_OPTIONS', 'withStoreLock requires a nonempty runId');
  }

  const canonicalStoreFile = await resolveCanonicalStoreFile(filePath);
  const lockPath = `${canonicalStoreFile}.lock`;

  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new IngestionError('E_STORE_LOCKED', `store is already locked: ${lockPath}`);
    }
    throw new IngestionError('E_STORE_WRITE', `failed to create lock file: ${err.message}`, { cause: err });
  }

  try {
    const metadata = { version: 1, run_id: runId, pid: process.pid, hostname: hostname(), started_at: new Date().toISOString() };
    if (__testHooks.afterCreateBeforeMetadata) await __testHooks.afterCreateBeforeMetadata(handle);
    await handle.write(JSON.stringify(metadata));
    await handle.close();
  } catch (err) {
    // The exclusive create itself succeeded, but initialization didn't --
    // clean up only the lock this invocation just created, never a lock
    // that might belong to someone else.
    try { await handle.close(); } catch { /* already closed */ }
    try { await unlink(lockPath); } catch { /* best-effort; nothing else to do */ }
    throw new IngestionError('E_STORE_WRITE', `failed to initialize lock metadata: ${err.message}`, { cause: err });
  }

  let result;
  let callbackError;
  try {
    result = await callback(canonicalStoreFile);
  } catch (err) {
    callbackError = err;
  }

  try {
    await releaseLock(lockPath, runId);
  } catch (releaseErr) {
    if (callbackError) {
      // The primary failure is what the caller needs to see and act on;
      // the release failure rides along as a safe, bounded secondary detail
      // rather than replacing it.
      throw addSecondaryError(callbackError, safeFailure(releaseErr, 'lock_release'));
    }
    // Cleanup alone failed: a lock the caller believes is free is actually
    // still sitting on disk, which is itself a reportable failure, not a
    // silent success.
    throw releaseErr;
  }

  if (callbackError) throw callbackError;
  return result;
}
