# Project status

As of 2026-09-18. Current code baseline: `179e5f4` (docs commit). Execution branch:
`release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–3 are complete.** Read [plan.md](plan.md) Task 4, then execute it: create
`src/http.mjs` and `test/helpers/http-server.mjs` (real loopback HTTP server); modify
`src/fetch.mjs` to enforce actual byte/timeout/deadline limits via native Fetch, and convert
existing Response test doubles to native `Response`. Start with the "actual bytes are
limited without Content-Length" regression test in plan.md Task 4. This is the first task
touching real network I/O — heavier than Tasks 0-3. Work sequentially through Tasks 4–12,
one commit per completed task on `release/0.2.0-reliability`.

## Current state

- Local package version: **0.1.0**. Planned next release: **0.2.0** — confirmed unused on
  the registry (`npm view` returned `latest: 0.1.0`), pending final reconciliation in Task 12.
- Final release specification and step-by-step Claude Sonnet 5 execution instructions are in plan.md.
- Baseline: **66/66 tests passed** on Windows / Node **v22.15.0**, 2026-09-18. Re-confirmed
  after the Task 0 test-script change (`node --test "test/*.test.mjs"`); discovery unchanged.
- Recorded fixtures: USGS **5/5**, Karnataka Careers **6/6** extracted successfully. These are historical offline fixtures, not current live-source proof.
- Workspace owner verified: `SSN-INSPIRON-35\Dell`.
- Task 0 changes: `package.json` test script; new `test/helpers/fixtures.mjs`,
  `TEST-MATRIX.md` (38 rows, all unproven), `VERIFICATION.md`.
- Task 1 changes: new `src/config.mjs` (full section 3.4 adapter/fetch config validation),
  `src/errors.mjs` (`IngestionError`); `src/adapter.mjs` now delegates to
  `validateAdapterConfig`; `src/contract.mjs` enforces identity/URL invariants and iterative
  JSON-safety (bounded depth 100, cycle detection); `src/extract.mjs`'s `getPath` is
  own-property-only; `src/normalize.mjs` gained `isValidDateOnly`. V01–V04 proved.
- Task 2 changes: `src/normalize.mjs`'s `text`/`number`/`iso-date` rewritten per section 4.4
  (numeric entities never throw; overflow-to-Infinity caught; iso-date is a hand-validated
  grammar, no `Date` parsing, full calendar/leap-year checks, offset timestamps retain the
  written date); `src/extract.mjs`'s `extractAll` now returns `errorCount`/`fieldFailures`
  over all rejected records with `errors` capped at 20 safe/bounded samples split into
  `missing` vs `invalid`; `src/adapter.mjs`'s `verifyAgainstFixtures` reads the full
  counters. 132/132 full suite passes (109 + 23 new). N01/N02/X01 proved.
- Task 3 changes: `src/filter.mjs` gained `validateFilter` (section 3.5) — `applyFilter`
  validates once up front (even for a zero-record call) and throws `E_FILTER_INVALID`;
  `evaluateRule` validates its own rule when called directly; both reject an invalid `now`
  as `E_OPTIONS`. Matching semantics (10 operators, array-intersection, missing-field
  pass/fail table) unchanged. 153/153 full suite passes (132 + 21 new). F01 proved.

## Pending

- Implementation tasks **4–12** and 30 of 38 scenario proofs remain pending (V01–V04, N01,
  N02, X01, F01 proved; see TEST-MATRIX.md).
- Key defects: pagination cutoff, mandatory identity, actual response limits, invalid entities/dates/config/filters, whole-file store reads, missing run exclusion, and incomplete saved reports.
- package-lock.json root metadata is **0.0.0**, while package.json is **0.1.0**. Task 11 reconciles metadata; do not mass-update dependencies.
- Current CI only tests Ubuntu / Node 24. Planned support proof covers Linux and Windows with Node 22.15.0, 22, and 24.
- Publication (Q02) remains pending until real workflow/registry/install evidence exists in Task 12; that also needs explicit publish authorization in the executing session.

## Execution boundaries

- Harden the current JSON/GET engine first. No RSS/HTML/browser/GraphQL, automatic cursors, or unrelated framework expansion in this release.
- Create TEST-MATRIX.md and VERIFICATION.md in Task 0; all new scenario rows start unproven.
- Record the active task, exact next action, failures, and evidence here after each task. Keep detailed results in VERIFICATION.md.
- Implementation verified and package published are separate states. Do not mark release complete from local tests alone.
