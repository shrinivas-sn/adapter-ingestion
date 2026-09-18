import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, realpath, symlink } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { withStoreLock, __testHooks } from '../src/lock.mjs';
import { tempPaths } from './helpers/fixtures.mjs';

const workerPath = fileURLToPath(new URL('./helpers/store-worker.mjs', import.meta.url));

function waitForMessage(child, predicate) {
  return new Promise((resolve) => {
    function onMessage(m) {
      if (predicate(m)) {
        child.off('message', onMessage);
        resolve(m);
      }
    }
    child.on('message', onMessage);
  });
}

// --- Promise-level ownership, options validation, canonical path ---

test('contender cannot enter or remove the owner lock', async (t) => {
  const p = await tempPaths(t);
  await withStoreLock(p.storeFile, { runId: 'owner' }, async () => {
    let entered = false;
    await assert.rejects(withStoreLock(p.storeFile, { runId: 'contender' }, async () => {
      entered = true;
    }), (e) => e.code === 'E_STORE_LOCKED');
    assert.equal(entered, false);
    assert.equal(JSON.parse(await readFile(p.storeFile + '.lock', 'utf8')).run_id, 'owner');
  });
  await assert.rejects(readFile(p.storeFile + '.lock'), { code: 'ENOENT' });
});

test('withStoreLock returns the callback result unchanged', async (t) => {
  const p = await tempPaths(t);
  const result = await withStoreLock(p.storeFile, { runId: 'owner' }, async () => ({ ok: true, n: 42 }));
  assert.deepEqual(result, { ok: true, n: 42 });
});

test('a callback that throws still releases the lock, and the original error propagates', async (t) => {
  const p = await tempPaths(t);
  await assert.rejects(
    withStoreLock(p.storeFile, { runId: 'owner' }, async () => { throw new Error('boom'); }),
    (err) => err.message === 'boom');
  await assert.rejects(readFile(p.storeFile + '.lock'), { code: 'ENOENT' }, 'the lock must not survive a thrown callback');
  // And a fresh acquisition must succeed -- proves it was actually released, not merely absent.
  await withStoreLock(p.storeFile, { runId: 'next' }, async () => {});
});

test('an empty store path or runId is rejected as E_OPTIONS before any filesystem work', async () => {
  await assert.rejects(withStoreLock('', { runId: 'x' }, async () => {}), (err) => err.code === 'E_OPTIONS');
  await assert.rejects(withStoreLock('/some/path.jsonl', { runId: '' }, async () => {}), (err) => err.code === 'E_OPTIONS');
});

test('a missing parent directory is created, not treated as a failure', async (t) => {
  const p = await tempPaths(t);
  const nested = join(p.dir, 'a', 'b', 'c', 'store.jsonl');
  const result = await withStoreLock(nested, { runId: 'owner' }, async (canonicalStoreFile) => canonicalStoreFile);
  assert.equal(await realpath(dirname(result)), await realpath(dirname(nested)));
});

test('the callback receives the realpath-resolved canonical store file path', async (t) => {
  const p = await tempPaths(t);
  const received = await withStoreLock(p.storeFile, { runId: 'owner' }, async (canonicalStoreFile) => canonicalStoreFile);
  assert.equal(received, await realpath(p.storeFile).catch(() => received));
  // The file need not exist yet (withStoreLock never creates the store file
  // itself) -- what must hold is that the parent is the real, canonical
  // parent directory.
  assert.equal(dirname(received), await realpath(p.dir));
});

// --- Failure paths: initialization, symlink rejection, ownership mismatch, release failure ---

test('a metadata initialization failure cleans up only the lock this invocation just created', async (t) => {
  const p = await tempPaths(t);
  __testHooks.afterCreateBeforeMetadata = async (handle) => { await handle.close(); };
  t.after(() => { __testHooks.afterCreateBeforeMetadata = null; });

  await assert.rejects(withStoreLock(p.storeFile, { runId: 'owner' }, async () => {}),
    (err) => err.code === 'E_STORE_WRITE');
  await assert.rejects(readFile(p.storeFile + '.lock'), { code: 'ENOENT' },
    'the failed lock must be removed, not left behind for the next run to trip over');

  __testHooks.afterCreateBeforeMetadata = null;
  // A fresh acquisition must succeed -- proves cleanup actually ran.
  await withStoreLock(p.storeFile, { runId: 'next' }, async () => {});
});

test('a symlinked store file is rejected, not silently followed', async (t) => {
  const p = await tempPaths(t);
  const real = p.storeFile + '.real';
  await writeFile(real, '');
  try {
    await symlink(real, p.storeFile, 'file');
  } catch (err) {
    if (err.code === 'EPERM') {
      // Creating a file symlink needs elevated privileges or Developer Mode
      // on Windows; this environment has neither. The rejection logic
      // itself is exercised on any platform/account that does allow it.
      t.skip('symlink creation is not permitted on this platform/account (EPERM)');
      return;
    }
    throw err;
  }
  await assert.rejects(withStoreLock(p.storeFile, { runId: 'owner' }, async () => {}),
    (err) => err.code === 'E_OPTIONS');
});

test('a lock file whose metadata no longer matches this run is never deleted on release', async (t) => {
  const p = await tempPaths(t);
  await assert.rejects(
    withStoreLock(p.storeFile, { runId: 'owner' }, async () => {
      // Simulates an anomalous on-disk state (never produced by normal
      // cooperative use) rather than injecting a fake internal failure --
      // some other run_id now owns what this file claims to be the lock.
      await writeFile(p.storeFile + '.lock', JSON.stringify({ version: 1, run_id: 'someone-else' }));
    }),
    (err) => err.code === 'E_LOCK_RELEASE');
  // Refused to remove it -- a real cleanup here would have deleted
  // "someone else's" lock out from under them.
  await assert.doesNotReject(readFile(p.storeFile + '.lock', 'utf8'));
});

test('a lock file removed out from under a running callback surfaces E_LOCK_RELEASE, not a silent success', async (t) => {
  const p = await tempPaths(t);
  await assert.rejects(
    withStoreLock(p.storeFile, { runId: 'owner' }, async () => {
      await unlink(p.storeFile + '.lock');
    }),
    (err) => err.code === 'E_LOCK_RELEASE');
});

test('a release failure does not mask the callback\'s own thrown error', async (t) => {
  const p = await tempPaths(t);
  await assert.rejects(
    withStoreLock(p.storeFile, { runId: 'owner' }, async () => {
      await unlink(p.storeFile + '.lock');
      throw new Error('the real failure');
    }),
    (err) => err.message === 'the real failure');
});

// --- L01/L02: real cross-process ownership, contention, crash recovery ---

test('L01: a real second process cannot enter while the first holds the lock; release lets a third in', async (t) => {
  const p = await tempPaths(t);
  const owner = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  t.after(() => { if (owner.exitCode === null && !owner.killed) owner.kill(); });

  await waitForMessage(owner, (m) => m.event === 'ready');
  owner.send({ cmd: 'acquire-and-hold', storeFile: p.storeFile, runId: 'owner' });
  await waitForMessage(owner, (m) => m.event === 'locked');

  // The contender attempt happens in this (parent) process -- still a
  // genuinely separate OS process from the owner above.
  let contenderEntered = false;
  await assert.rejects(
    withStoreLock(p.storeFile, { runId: 'contender' }, async () => { contenderEntered = true; }),
    (err) => err.code === 'E_STORE_LOCKED');
  assert.equal(contenderEntered, false, 'the contender callback must never run');

  owner.send({ cmd: 'release' });
  await waitForMessage(owner, (m) => m.event === 'released');
  await new Promise((resolve) => owner.once('exit', resolve));

  const result = await withStoreLock(p.storeFile, { runId: 'third' }, async () => 'ok');
  assert.equal(result, 'ok', 'a third acquisition after the owner released must succeed');
});

test('L02: killing the owner leaves the lock behind; only explicit recovery permits replay', async (t) => {
  const p = await tempPaths(t);
  const owner = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  await waitForMessage(owner, (m) => m.event === 'ready');
  owner.send({ cmd: 'acquire-and-hold', storeFile: p.storeFile, runId: 'crashed-owner' });
  await waitForMessage(owner, (m) => m.event === 'locked');

  owner.kill(); // no graceful shutdown -- the lock's release code never runs
  await new Promise((resolve) => owner.once('exit', resolve));

  // The crash left the lock in place.
  const metadata = JSON.parse(await readFile(p.storeFile + '.lock', 'utf8'));
  assert.equal(metadata.run_id, 'crashed-owner');

  // A normal acquisition attempt still correctly refuses to touch it.
  await assert.rejects(withStoreLock(p.storeFile, { runId: 'replay' }, async () => {}),
    (err) => err.code === 'E_STORE_LOCKED');

  // Only an explicit, out-of-band operator action (never automated by this
  // package) removes a lock left by a confirmed-dead process.
  await unlink(p.storeFile + '.lock');

  const result = await withStoreLock(p.storeFile, { runId: 'replay' }, async () => 'ok');
  assert.equal(result, 'ok');
});
