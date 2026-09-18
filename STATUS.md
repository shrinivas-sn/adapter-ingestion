# Project status

As of 2026-09-18. Current code baseline: `179e5f4` (docs commit). Execution branch:
`release/0.2.0-reliability`.

## Next up (start here)

**Tasks 0–1 are complete.** Read [plan.md](plan.md) Task 2, then execute it: rewrite
`src/normalize.mjs`'s numeric-entity/date grammar (section 4.4) and extend
`extractAll`/`verifyAgainstFixtures` with `errorCount`/`fieldFailures` diagnostics
(section 6.1 interfaces) in `src/extract.mjs`/`src/adapter.mjs`. Start with the bad
numeric-entity/impossible-date regression test in plan.md Task 2. Work sequentially
through Tasks 2–12, one commit per completed task on `release/0.2.0-reliability`.

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
  own-property-only; `src/normalize.mjs` gained `isValidDateOnly`. 109/109 full suite passes
  (66 baseline + 43 new). V01–V04 proved in TEST-MATRIX.md.

## Pending

- Implementation tasks **2–12** and 34 of 38 scenario proofs remain pending (V01–V04 proved;
  see TEST-MATRIX.md).
- Key defects: pagination cutoff, mandatory identity, actual response limits, invalid entities/dates/config/filters, whole-file store reads, missing run exclusion, and incomplete saved reports.
- package-lock.json root metadata is **0.0.0**, while package.json is **0.1.0**. Task 11 reconciles metadata; do not mass-update dependencies.
- Current CI only tests Ubuntu / Node 24. Planned support proof covers Linux and Windows with Node 22.15.0, 22, and 24.
- Publication (Q02) remains pending until real workflow/registry/install evidence exists in Task 12; that also needs explicit publish authorization in the executing session.

## Execution boundaries

- Harden the current JSON/GET engine first. No RSS/HTML/browser/GraphQL, automatic cursors, or unrelated framework expansion in this release.
- Create TEST-MATRIX.md and VERIFICATION.md in Task 0; all new scenario rows start unproven.
- Record the active task, exact next action, failures, and evidence here after each task. Keep detailed results in VERIFICATION.md.
- Implementation verified and package published are separate states. Do not mark release complete from local tests alone.
