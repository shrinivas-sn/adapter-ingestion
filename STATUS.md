# Project status

As of 2026-09-18. Committed baseline: Task 7 (streamed store history), this commit.
Execution branch: `release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–7 are complete.** Read [plan.md](plan.md) Task 8, then execute it: add owned local
locking in a new `src/lock.mjs` (section 5.2 — `withStoreLock(filePath, {runId}, callback)`
creates `<canonicalStoreFile>.lock` exclusively via `open(...,'wx')`; existing lock means
immediate `E_STORE_LOCKED`, no polling/stealing/PID probing/age-based unlock; release in
`finally`, verifying `run_id` before unlinking; a release failure must not mask the
callback's primary failure). Re-export `withStoreLock` from `src/store.mjs`. Needs a real
multi-process proof: new `test/helpers/store-worker.mjs` (IPC-controlled child, reused again
in Task 10) plus `test/lock.test.mjs` covering the nested-contender case, callback-throws,
missing parent, symlink-store rejection, lock metadata mismatch, release failure, and an
actual killed-owner-leaves-lock recovery scenario. Start with the nested contender test given
verbatim in plan.md Task 8. `runIngest` integration is explicitly Task 9's job, not this
one. Work sequentially through Tasks 8–12, one commit per completed task on
`release/0.2.0-reliability`.

## Current state

- 8 commits ahead of `main` (`179e5f4`): Task 0 (baseline/ledger), Task 1 (config validation +
  record identity), Task 2 (normalizer rewrite + extraction diagnostics), Task 3 (filter
  validation), Task 4 (transport hardening), Task 5 (pagination completeness), Task 6
  (bounded retries/pacing), Task 7 (streamed store history — `iterateRecords` bounded to
  64 KiB chunk reads, `readLatestRecords`/`readIndex` reduce directly with no intermediate
  array, `appendRecords` preflights the whole batch before any write; new
  `scripts/verify-store-scale.mjs` proved 256 MiB / 66,041 records / 100 ids reduces under a
  96 MB heap cap). Full per-task detail is in `VERIFICATION.md`, not repeated here.
- Proved: V01–V04, N01, N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04 (see
  `TEST-MATRIX.md`).
- Both real adapters (earthquake.usgs.gov, www.karnatakacareers.org) still validate and
  extract 5/5 and 6/6 against fixtures as of the last check.
- Full suite: 218/218 pass, Windows / Node v22.15.0.
- Standing authorizations from this session: work on `release/0.2.0-reliability` (not
  `main`), one commit per task, execute inline without subagent delegation. Still in effect.
- package-lock.json root metadata (`0.0.0`) vs package.json (`0.1.0`) mismatch: Task 11
  reconciles this; don't touch it now.

## Pending

- Tasks 8 through 12 remain. Task 12 ends in an actual npm publish, which needs explicit
  authorization in that session — separate from the general go-ahead already given.
- L01 (concurrent lock ownership) only reaches Promise-level proof in Task 8; the
  `runIngest`-orchestration-boundary proof (real two-process contention against a gated
  loopback endpoint) is explicitly completed in Task 10, reusing Task 8's worker helper.
- CI is currently Ubuntu/Node 24 only; the planned matrix is Linux+Windows × Node
  22.15.0/22/24 (Task 11).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command-level evidence:
`VERIFICATION.md`.
