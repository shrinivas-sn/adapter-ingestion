# Project status

As of 2026-09-18. Current code baseline: `179e5f4` (docs commit). Execution branch:
`release/0.2.0-reliability`.

## Next up (start here)

**Task 0 is complete.** Read [plan.md](plan.md) Task 1, then execute it: `src/config.mjs`,
`src/errors.mjs` (new); modify `src/adapter.mjs`, `src/contract.mjs`, `src/extract.mjs`.
Start with the malformed-input table tests and the unconditional-identity regression in
plan.md Task 1. Work sequentially through Tasks 1–12, one commit per completed task on
`release/0.2.0-reliability`.

## Current state

- Local package version: **0.1.0**. Planned next release: **0.2.0** — confirmed unused on
  the registry (`npm view` returned `latest: 0.1.0`), pending final reconciliation in Task 12.
- Final release specification and step-by-step Claude Sonnet 5 execution instructions are in plan.md.
- Baseline: **66/66 tests passed** on Windows / Node **v22.15.0**, 2026-09-18. Re-confirmed
  after the Task 0 test-script change (`node --test "test/*.test.mjs"`); discovery unchanged.
- Recorded fixtures: USGS **5/5**, Karnataka Careers **6/6** extracted successfully. These are historical offline fixtures, not current live-source proof.
- Workspace owner verified: `SSN-INSPIRON-35\Dell`.
- Task 0 changes: `package.json` test script; new `test/helpers/fixtures.mjs`,
  `TEST-MATRIX.md` (38 rows, all unproven), `VERIFICATION.md`. No other production/test code
  changed.

## Pending

- Implementation tasks **1–12** and all 38 scenario proofs remain pending (unproven in TEST-MATRIX.md).
- Key defects: pagination cutoff, mandatory identity, actual response limits, invalid entities/dates/config/filters, whole-file store reads, missing run exclusion, and incomplete saved reports.
- package-lock.json root metadata is **0.0.0**, while package.json is **0.1.0**. Task 11 reconciles metadata; do not mass-update dependencies.
- Current CI only tests Ubuntu / Node 24. Planned support proof covers Linux and Windows with Node 22.15.0, 22, and 24.
- Publication (Q02) remains pending until real workflow/registry/install evidence exists in Task 12; that also needs explicit publish authorization in the executing session.

## Execution boundaries

- Harden the current JSON/GET engine first. No RSS/HTML/browser/GraphQL, automatic cursors, or unrelated framework expansion in this release.
- Create TEST-MATRIX.md and VERIFICATION.md in Task 0; all new scenario rows start unproven.
- Record the active task, exact next action, failures, and evidence here after each task. Keep detailed results in VERIFICATION.md.
- Implementation verified and package published are separate states. Do not mark release complete from local tests alone.
