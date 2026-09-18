// A child process driven by IPC messages, used to prove withStoreLock's
// exclusion actually holds across real separate processes -- not just
// concurrent promises inside one. Commands:
//   { cmd: 'acquire-and-hold', storeFile, runId } -- acquires the lock,
//     replies { event: 'locked' }, then waits for an explicit
//     { cmd: 'release' } message before letting the callback return
//     (replies { event: 'released' } once withStoreLock itself resolves,
//     then this process exits on its own). The parent may instead kill this
//     process at any point before that -- e.g. right after 'locked' -- to
//     simulate a crash while the lock is held.
//   { cmd: 'acquire-once', storeFile, runId } -- a one-shot acquisition,
//     replies { event: 'acquired' } or { event: 'error', code, message },
//     then exits.
//   { cmd: 'run-ingest', adapter, paths, now } -- runs the real, full
//     runIngest orchestration (not just withStoreLock directly) in this
//     process; replies { event: 'run-done', report, canary } or
//     { event: 'run-error', code, message, report }, then exits. Used to
//     prove lock/HTTP ordering at the runIngest boundary, not just lock.mjs.
//   { cmd: 'hold-lock-partial-write', storeFile, runId, validLine,
//     partialLine } -- acquires the lock directly (bypassing runIngest) and
//     writes one complete, synced line followed by a deliberately
//     unterminated partial line, then replies { event: 'partial_written' }
//     and hangs forever -- the parent kills this process to simulate a
//     crash mid-append while the lock is still held.
import { open } from 'node:fs/promises';
import { withStoreLock } from '../../src/lock.mjs';

// send() is asynchronous -- calling process.exit() right after it, without
// waiting for its own callback, risks the process dying before the message
// actually reaches the parent. sendAndExit always waits for that
// confirmation first.
function sendAndExit(message) {
  process.send(message, () => process.exit(0));
}

// A forked child's IPC channel otherwise keeps its event loop alive for as
// long as a 'message' listener stays registered, whether or not there's any
// more work coming -- this worker is one-shot per process, so it must
// explicitly end itself once its job is done rather than relying on a
// natural exit that would otherwise never happen.
process.on('message', async (msg) => {
  if (msg.cmd === 'acquire-and-hold') {
    try {
      await withStoreLock(msg.storeFile, { runId: msg.runId }, async () => {
        process.send({ event: 'locked' });
        await new Promise((resolve) => {
          function onRelease(m) {
            if (m.cmd === 'release') {
              process.off('message', onRelease);
              resolve();
            }
          }
          process.on('message', onRelease);
        });
      });
      sendAndExit({ event: 'released' });
    } catch (err) {
      sendAndExit({ event: 'error', code: err.code, message: err.message });
    }
    return;
  }

  if (msg.cmd === 'acquire-once') {
    try {
      await withStoreLock(msg.storeFile, { runId: msg.runId }, async () => 'ok');
      sendAndExit({ event: 'acquired' });
    } catch (err) {
      sendAndExit({ event: 'error', code: err.code, message: err.message });
    }
    return;
  }

  if (msg.cmd === 'run-ingest') {
    try {
      const { runIngest } = await import('../../src/run.mjs');
      const { report, canary } = await runIngest({
        adapter: msg.adapter, paths: msg.paths, fetchImpl: fetch, now: new Date(msg.now),
      });
      sendAndExit({ event: 'run-done', report, canary });
    } catch (err) {
      sendAndExit({ event: 'run-error', code: err.code, message: err.message, report: err.report ?? null });
    }
    return;
  }

  if (msg.cmd === 'hold-lock-partial-write') {
    try {
      await withStoreLock(msg.storeFile, { runId: msg.runId }, async (canonicalStoreFile) => {
        const handle = await open(canonicalStoreFile, 'a');
        await handle.write(msg.validLine + '\n');
        await handle.write(msg.partialLine); // deliberately no trailing newline
        await handle.sync();
        await handle.close();
        process.send({ event: 'partial_written' });
        await new Promise(() => {}); // hang -- the parent kills this process from here
      });
    } catch { /* unreachable in practice: the process is killed before this settles */ }
  }
});

process.send({ event: 'ready' });
