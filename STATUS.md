# Project status

As of 2026-10-01. **`@shrinivas-sn/adapter-ingestion@0.2.0` is published and live on npm**
(released from `main` at `face358`). Release cycle 0.2.0 closed. Full suite 281 tests:
279 pass, 2 documented platform-limitation skips.

## Next up (start here)

1. Run `/validate` on this project (the new global skill, first real-project test). Tell it
   the owner uses this package for most of their personal work. Expect a report at
   `validation/validation-YYYY-MM-DD.md` and one line appended here. Check: the verdict
   weighs own use, every template section is filled, no code is touched.
2. Only then brainstorm v0.3.0 from [`RFC-0.3.md`](RFC-0.3.md), scoped by the verdict. Draft
   ideas to test: prove each gap with 2 real APIs first (`plan.md` §11 evidence rule);
   explicit `records_shape: "object_values"` (not `items.*`, no `.flat()`, option to keep the
   object key as a field); `template` returns null when a var is missing; check whether 0.2.0
   rejects unknown adapter fields before choosing adapter `version`.
3. Work is on branch `feat/github-advisories-adapter` (not pushed). Merge or PR it when ready.

## Current state

- New adapter `adapters/api.github.com.adapter.json` (GitHub Security Advisories feed),
  with fixture `fixtures/api.github.com/sample-1.json`. `node
  scripts/verify-github-advisories-adapter.mjs` prints PASS: 5/5 against fixtures, canary
  ok on the healthy run, and canary catches a renamed id field.
- Deferred scope (HTML/RSS/other source kinds) still governed by `plan.md` §11; each item
  names the evidence needed before it becomes a plan.
- Standing authorizations: implementation work yes; pushing, merging and publishing only on
  an explicit user request immediately before it.

- A no-skill baseline research run (01/10/2026, not a real verdict) found heavy overlap with
  dlt's REST API source, Airbyte/Singer and Spidermon. It also found the README's "sites with no
  API" claim is wider than the code, which only ingests JSON over HTTP GET.

## Pending

Nothing blocking.

Release spec: `plan.md`. Scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
