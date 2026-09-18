# Project status

As of 2026-09-18. Committed baseline: Task 6 (retries/pacing), this commit.
Execution branch: `release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–6 are complete.** Read [plan.md](plan.md) Task 7, then execute it: stream store
history with bounded line buffering in `src/store.mjs` (section 5.1 — `iterateRecords` splits
on LF, tolerates CRLF, preserves split UTF-8, enforces `maxLineBytes` before collecting an
oversized line; `readIndex`/`readLatestRecords` reduce directly without materializing a
historical array; `appendRecords` preflights the whole batch, repairs a truncated last line,
awaits sync/close). Also write `scripts/verify-store-scale.mjs` (256 MiB synthetic JSONL
history, child process capped at `--max-old-space-size=96`, proves bounded-memory reduction —
generate the fixture incrementally, never in memory as one string). Start with the
corrupt-line/latest-hash regression test in plan.md Task 7. Work sequentially through
Tasks 7–12, one commit per completed task on `release/0.2.0-reliability`.

## Current state

- 7 commits ahead of `main` (`179e5f4`): Task 0 (baseline/ledger), Task 1 (config validation +
  record identity), Task 2 (normalizer rewrite + extraction diagnostics), Task 3 (filter
  validation), Task 4 (transport hardening), Task 5 (pagination completeness), Task 6
  (bounded retries/pacing — full-jitter exponential backoff, `Retry-After` honored as a floor
  with `E_RETRY_DEFERRED` when it can't fit the budget, `delay_ms` page pacing,
  `diagnostics.attempts`/`retries`, cumulative byte accounting across retried attempts). Full
  per-task detail is in `VERIFICATION.md`, not repeated here.
- Proved: V01–V04, N01, N02, X01, F01, H01–H04, P01–P03, R01–R03 (see `TEST-MATRIX.md`).
- Both real adapters (earthquake.usgs.gov, www.karnatakacareers.org) still validate and
  extract 5/5 and 6/6 against fixtures as of the last check. Neither adapter configures
  `fetch.retry` explicitly, so both now get the section-3.4 defaults (max_attempts 3,
  backoff_ms 500, max_delay_ms 10000) on their next live fetch — not yet re-verified against
  the live sources (fixtures only).
- Full suite: 200/200 pass, Windows / Node v22.15.0.
- Standing authorizations from this session: work on `release/0.2.0-reliability` (not
  `main`), one commit per task, execute inline without subagent delegation. Still in effect.
- package-lock.json root metadata (`0.0.0`) vs package.json (`0.1.0`) mismatch: Task 11
  reconciles this; don't touch it now.

## Pending

- Tasks 7 through 12 remain. Task 12 ends in an actual npm publish, which needs explicit
  authorization in that session — separate from the general go-ahead already given.
- CI is currently Ubuntu/Node 24 only; the planned matrix is Linux+Windows × Node
  22.15.0/22/24 (Task 11).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command-level evidence:
`VERIFICATION.md`.
