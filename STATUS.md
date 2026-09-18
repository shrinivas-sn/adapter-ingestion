# Project status

As of 2026-09-18. Committed baseline: Task 5 (pagination completeness), this commit.
Execution branch: `release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–5 are complete.** Read [plan.md](plan.md) Task 6, then execute it: implement
retries/pacing in `src/fetch.mjs` (section 4.2 — retry only GET connection failures,
per-attempt timeouts, and HTTP 408/429/500/502/503/504; full-jitter backoff with
`max_delay_ms` ceiling; `Retry-After` seconds/HTTP-date parsing with `E_RETRY_DEFERRED` when
it exceeds budget; `delay_ms` pacing between successful pages; abortable waits). Retries are
currently still disabled (one attempt per page) — Task 4/5 deliberately left this for Task 6.
Start with the 503→200 two-attempt regression test in plan.md Task 6. Work sequentially
through Tasks 6–12, one commit per completed task on `release/0.2.0-reliability`.

## Current state

- 6 commits ahead of `main` (`179e5f4`): Task 0 (baseline/ledger), Task 1 (config validation +
  record identity), Task 2 (normalizer rewrite + extraction diagnostics), Task 3 (filter
  validation), Task 4 (transport hardening — real HTTP server tests, byte caps, timeouts,
  redirects, safe error messages; fixed a real mid-body-stall classification bug), Task 5
  (pagination completeness — `diagnostics.complete`/`stop_reason`, `allow_truncation`,
  `E_PAGINATION_REPEAT` exact-repeat detection). Full per-task detail is in
  `VERIFICATION.md`, not repeated here.
- Proved: V01–V04, N01, N02, X01, F01, H01–H04, P01–P03 (see `TEST-MATRIX.md`).
- Both real adapters (earthquake.usgs.gov, www.karnatakacareers.org) still validate and
  extract 5/5 and 6/6 against fixtures as of the last check. Karnataka Careers' adapter now
  has `allow_truncation: true` (its `max_pages: 5` window is intentionally bounded).
- Full suite: 180/180 pass, Windows / Node v22.15.0.
- Standing authorizations from this session: work on `release/0.2.0-reliability` (not
  `main`), one commit per task, execute inline without subagent delegation. Still in effect.
- package-lock.json root metadata (`0.0.0`) vs package.json (`0.1.0`) mismatch: Task 11
  reconciles this; don't touch it now.

## Pending

- Tasks 6 through 12 remain. Task 12 ends in an actual npm publish, which needs explicit
  authorization in that session — separate from the general go-ahead already given.
- H02's cumulative-across-*retries* evidence and H03's retry-specific pacing are deferred to
  Task 6 (noted in the Task 4 VERIFICATION.md entry).
- CI is currently Ubuntu/Node 24 only; the planned matrix is Linux+Windows × Node
  22.15.0/22/24 (Task 11).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command-level evidence:
`VERIFICATION.md`.
