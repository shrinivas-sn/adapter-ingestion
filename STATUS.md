# Project status

As of 2026-10-01. **`@shrinivas-sn/adapter-ingestion@0.2.0` is live on npm** (released from
`main` at `face358`). Full suite 281 tests: 279 pass, 2 documented platform skips. The GitHub
repo is **public** since 01/10/2026; gitleaks 8.30.1 found 0 leaks across all 45 commits.

## Current state

- Branch `feat/github-advisories-adapter` (not pushed) holds:
  - the GitHub Security Advisories adapter (`node scripts/verify-github-advisories-adapter.mjs`
    → PASS 5/5, canary catches a renamed id field);
  - `RFC-0.3.md`;
  - the first validation report and the README refresh (live badges, honest JSON-over-GET
    scope, alternatives, canary-history gotcha, status/roadmap and contributing sections).
  - The public `main` README stays old until this branch is merged.
- validation 2026-10-01: KEEP AS PERSONAL TOOL — validation/validation-2026-10-01.md
- **Goal conflict, decided by the owner after the run:** the goal is a **product for other
  devs** via `npm install`, not only a personal tool. That makes the report's "Gaps blocking
  the goal" thinking the roadmap input.
- Gaps still open:
  - canary `count_drop_ratio` never fires on a fresh CI checkout, because history is read only
    from `runsDir` (worked around in `govt-job-platform/ingestion/src/canary-baseline.mjs`);
  - non-JSON input (CSV) only works through a caller `fetchImpl` (`model-bench`);
  - no TypeScript types (`package.json` has no `types` field) and no CLI `bin`;
  - `generate-adapter` is a private skill, so outside devs hand-write adapter JSON;
  - `package.json` `description`/keywords still say "sites with no API" / `web-scraping`.
- Already in 0.2.0, despite the report's first draft: retry with backoff
  (`src/fetch.mjs:46-68`) and the `W_PAGE_LIMIT` truncation signal.
- `govt-job-platform` is still on `^0.1.0`. `model-bench` is on `^0.2.0`.
- Deferred scope (HTML/RSS/other source kinds) is governed by `plan.md` §11: two real sources
  are needed before anything is planned.
- Standing authorizations: implementation work yes. Push, merge and publish only on an
  explicit user request immediately before it.

## Next up (start here)

1. Brainstorm verdict logged 2026-10-01: `brainstorm/brainstorm-2026-10-01-product-roadmap.md`
   (foundation-first: 0.3.0 self-describing + upgrade-safe -> 0.4.0 extension points ->
   0.5.0 ecosystem -> 1.0.0). The owner answers its 4 "Open decisions" one at a time, then:
   design sections for 0.3.0 -> written spec -> `create-plan`. No implementation before that.
   - RFC-0.3 Gap A (object_values) parked, 0 real sources; Gap B (template) parked, 1 of 2.
   - Answered: 0.2.0 rejects unknown adapter keys (`src/config.mjs:41`).
2. Merge or PR `feat/github-advisories-adapter` when the owner asks.

## Pending

Nothing blocking. Release spec: `plan.md`. Scenario ledger: `TEST-MATRIX.md`. Command
evidence: `VERIFICATION.md`.
