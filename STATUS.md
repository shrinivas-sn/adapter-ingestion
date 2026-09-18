# Project status

As of 2026-09-18. Committed baseline: Task 9 (final lifecycle/reports/canary), this commit.
Execution branch: `release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–9 are complete.** Read [plan.md](plan.md) Task 10, then execute it — real
consumer/failure/replay proof, no new production behavior except fixing genuine defects
against requirements already specified. Files: `test/integration.test.mjs`,
`test/helpers/store-worker.mjs`, `test/helpers/http-server.mjs`, `test/run.test.mjs`.
1. E01: for each real adapter (earthquake.usgs.gov, www.karnatakacareers.org), drive its
   recorded fixture through a real `Response` and `runIngest`: first run's fresh count,
   identical replay writes 0, one edited mapped field produces exactly 1 changed, the latest
   view has one row per ID, a broken required-field mapping reports stale. Pick an explicit
   logical `now` (newest mapped staleness value + 12h) so historical fixtures stay
   deterministic — never disable freshness checks to force green.
2. E02: a real two-page loopback endpoint, page 1 valid then page 2 exhausts retries on 503 —
   seed the store first and assert it is byte-identical afterward; the report shows page-1
   progress plus the error, never a successful partial ingestion.
3. E03: `runsDir` pointed at a regular file forces `E_REPORT_WRITE` after a successful
   append (Task 9 already proved this at the unit level in `run.test.mjs` — Task 10 extends
   it into a full replay: catch it, confirm `storage` shows committed, restore a valid
   `runsDir`, replay the same payload, assert `written: 0` and the store file unchanged).
4. L01 completion: two real child processes running actual `runIngest` against the same
   store and a gated loopback endpoint — owner waits inside `fetch` after acquiring the lock;
   contender must fail before issuing any HTTP request; release via IPC; a later replay adds
   zero duplicates. Reuses Task 8's `test/helpers/store-worker.mjs`.
5. E04: extend the worker to simulate a crash mid-append at a precisely IPC-signaled point
   (one valid line + a known partial next line, no trailing newline) — kill it, confirm the
   lock remains, perform explicit test-only recovery, replay the full source: the earlier
   record survives, the missing one reappears exactly once, the corrupt tail warns, and no
   report is fabricated for the killed invocation.
6. Overlapping-ID-across-pages-is-valid and cancellation (canceled fetch / canceled wait
   produce no store mutation; cancellation *after* append preserves committed status) get
   their own focused tests.

Run `node --test test/integration.test.mjs`, then full suite, then the scale script; record
OS/process topology and exact commands. Work sequentially through Tasks 10–12, one commit
per completed task on `release/0.2.0-reliability`.

## Current state

- 10 commits ahead of `main` (`179e5f4`): Task 0 (baseline/ledger), Task 1 (config validation +
  record identity), Task 2 (normalizer rewrite + extraction diagnostics), Task 3 (filter
  validation), Task 4 (transport hardening), Task 5 (pagination completeness), Task 6
  (bounded retries/pacing), Task 7 (streamed store history), Task 8 (owned local locking),
  Task 9 (final lifecycle/reports/canary — `runIngest` rewritten in the exact section 6.2
  order, wired to Task 8's `withStoreLock`; report schema v2 with `outcome`/`failure`/
  `secondary_errors`/eligible-history-scanned canary baseline; found and fixed a real bug
  where `report.mjs`'s `writeReport` let a raw `mkdir` failure escape unwrapped, misclassified
  as `E_FETCH` by `safeFailure`'s fallback). Full per-task detail is in `VERIFICATION.md`.
- Proved: V01–V04, N01, N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04, L01 (Promise-level),
  L02, O01–O03, C01–C02 (see `TEST-MATRIX.md`). L01's `runIngest`-orchestration-boundary proof
  (real two-process contention over a gated loopback endpoint, not just direct
  `withStoreLock` calls) is Task 10's job.
- Both real adapters (earthquake.usgs.gov, www.karnatakacareers.org) still validate and
  extract 5/5 and 6/6 against fixtures as of the last check (verified via the read-only
  `scripts/verify-earthquake-adapter.mjs`, which touches no store/runs paths).
  `scripts/run-earthquake-{offline,broken}.mjs` remain syntax-checked only, not executed —
  both write into this workspace's real `store/`/`runs/` directories; Task 10 is where real
  fixture execution finally happens, in isolated temp paths.
- Full suite: 253/253 (252 pass, 1 documented skip — a symlink-rejection test that needs a
  privilege this dev machine doesn't have), Windows / Node v22.15.0.
- Standing authorizations from this session: work on `release/0.2.0-reliability` (not
  `main`), one commit per task, execute inline without subagent delegation. Still in effect.
- package-lock.json root metadata (`0.0.0`) vs package.json (`0.1.0`) mismatch: Task 11
  reconciles this; don't touch it now.

## Pending

- Tasks 10 through 12 remain. Task 12 ends in an actual npm publish, which needs explicit
  authorization in that session — separate from the general go-ahead already given.
- CI is currently Ubuntu/Node 24 only; the planned matrix is Linux+Windows × Node
  22.15.0/22/24 (Task 11).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command-level evidence:
`VERIFICATION.md`.
