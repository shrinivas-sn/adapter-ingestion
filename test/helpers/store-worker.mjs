// A child process driven by IPC messages, used to prove withStoreLock's
// exclusion actually holds across real separate processes -- not just
// concurrent promises inside one. Two commands:
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
  }
});

process.send({ event: 'ready' });
