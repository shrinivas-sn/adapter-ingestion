# Project status

As of 2026-10-01. **`@shrinivas-sn/adapter-ingestion@0.2.0` is published and live on npm**
(released from `main` at `face358`). Release cycle 0.2.0 closed. Full suite 281 tests:
279 pass, 2 documented platform-limitation skips.

## Next up (start here)

1. Brainstorm v0.3.0 scope from [`RFC-0.3.md`](RFC-0.3.md): dictionary-shaped
   `records_path` (Gap A) and `template` URL building in `map` (Gap B). Draft only; nothing
   implemented, nothing decided.
2. Work is on branch `feat/github-advisories-adapter` (not pushed). Merge or PR it when ready.

## Current state

- New adapter `adapters/api.github.com.adapter.json` (GitHub Security Advisories feed),
  with fixture `fixtures/api.github.com/sample-1.json`. `node
  scripts/verify-github-advisories-adapter.mjs` prints PASS: 5/5 against fixtures, canary
  ok on the healthy run, and canary catches a renamed id field.
- Deferred scope (HTML/RSS/other source kinds) still governed by `plan.md` §11; each item
  names the evidence needed before it becomes a plan.
- Standing authorizations: implementation work yes; pushing, merging and publishing only on
  an explicit user request immediately before it.

## Pending

Nothing blocking.

Release spec: `plan.md`. Scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
