# Project status

As of 2026-09-18. Committed baseline: Task 8 (owned local locking), this commit.
Execution branch: `release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–8 are complete.** Read [plan.md](plan.md) Task 9, then execute it — the big
integration task. Files: `src/run.mjs`, `src/report.mjs`, `src/canary.mjs`, `src/errors.mjs`;
`test/run.test.mjs`, `test/report.test.mjs`, `test/canary.test.mjs`, `test/integration.test.mjs`.
Order matters:
1. Report schema/build tests first, independent of `runIngest` — safe bounded collectors,
   unique filenames under identical `startedAt`, exclusive temp publication, legacy reads,
   non-masked filesystem errors (an ignored crash-left temp sibling, a malformed JSON file
   history skips, report_version/shape validation).
2. Refactor `runIngest` in the *exact* section 6.2 lifecycle order — pre-lock validation gets
   its own report; owned-lock work (fetch → extract → read-index → classify → append →
   history → canary → publish) runs inside `withStoreLock` (from Task 8); one internal
   finalize path for both success/failure, not a generic workflow engine.
3. Feed real `fetchAll` diagnostics, full `errorCount`, capped warning samples, storage
   result, and adapter fingerprint into the report.
4. Eligible-history scanning (skip stale/error/legacy/incremental/future/mismatched-fingerprint
   reports when building the canary's median baseline) before current-report publication.
5. One logical `now` threaded through canary evaluation; empty-delta/incremental skip-reason
   tests; update old report-history fixtures to valid v2 shape where eligibility now needs it.
6. Primary-vs-secondary error precedence: report-write failure after a successful append,
   lock-release failure, and the Task-4 injected-secret must never leak into a report/CLI.

Start with the saved-canary regression given verbatim in plan.md Task 9. Run the four listed
test files, then full suite; record O01–O03/C01/C02. Work sequentially through Tasks 9–12,
one commit per completed task on `release/0.2.0-reliability`.

## Current state

- 9 commits ahead of `main` (`179e5f4`): Task 0 (baseline/ledger), Task 1 (config validation +
  record identity), Task 2 (normalizer rewrite + extraction diagnostics), Task 3 (filter
  validation), Task 4 (transport hardening), Task 5 (pagination completeness), Task 6
  (bounded retries/pacing), Task 7 (streamed store history), Task 8 (owned local locking —
  `src/lock.mjs`'s `withStoreLock`, exclusive `.lock` creation, real cross-process proof via
  a forked IPC worker; crash-leaves-lock / explicit-recovery-only proved). Full per-task
  detail is in `VERIFICATION.md`, not repeated here.
- Proved: V01–V04, N01, N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04, L01, L02 (see
  `TEST-MATRIX.md`). `runIngest` does not yet call `withStoreLock` — that wiring is Task 9's job.
- Both real adapters (earthquake.usgs.gov, www.karnatakacareers.org) still validate and
  extract 5/5 and 6/6 against fixtures as of the last check.
- Full suite: 231/231 (230 pass, 1 documented skip — a symlink-rejection test that needs a
  privilege this dev machine doesn't have), Windows / Node v22.15.0.
- Standing authorizations from this session: work on `release/0.2.0-reliability` (not
  `main`), one commit per task, execute inline without subagent delegation. Still in effect.
- package-lock.json root metadata (`0.0.0`) vs package.json (`0.1.0`) mismatch: Task 11
  reconciles this; don't touch it now.

## Pending

- Tasks 9 through 12 remain. Task 12 ends in an actual npm publish, which needs explicit
  authorization in that session — separate from the general go-ahead already given.
- Task 9 is the largest remaining task before the end-to-end proof in Task 10 — budget
  accordingly; it touches `src/run.mjs`'s entire lifecycle, not an incremental add.
- CI is currently Ubuntu/Node 24 only; the planned matrix is Linux+Windows × Node
  22.15.0/22/24 (Task 11).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command-level evidence:
`VERIFICATION.md`.
