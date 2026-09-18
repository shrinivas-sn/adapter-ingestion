# Project status

As of 2026-09-18. Committed baseline: Task 10 (real consumer/failure/replay proof),
committing next on `release/0.2.0-reliability`. Prior commit: `7433297` (Task 9).

## Next up (start here)

Read plan.md Task 11 — document the real API and verify the installed artifact on
supported platforms. Files: `README.md`, new `MIGRATION-0.2.md`, `package.json`,
`package-lock.json`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, new
`scripts/verify-package.mjs`; update `TEST-MATRIX.md`/`VERIFICATION.md`/`STATUS.md`.

1. Rewrite README around actual JSON/GET support and package imports — one copyable
   complete example (adapter + runIngest + readLatestRecords + applyFilter) using a local
   fixture Response, no repository-only paths.
2. Document recovery/incremental limits, strict config/defaults, bounded windows,
   low-level locking responsibility, raw HTML escaping, diagnostic sensitivity.
3. Add MIGRATION-0.2.md to the npm files allowlist; keep dev-only paths out of package.
4. Set engines.node >=22.15.0; reconcile package-lock metadata (no dependency version
   changes) — record the before/after diff.
5. Implement scripts/verify-package.mjs: npm pack into a temp dir, install the exact
   tarball into a temp consumer (`--ignore-scripts --omit=dev --package-lock=false`), run
   a consumer .mjs using only package imports (native-Response fixture flow), confirm no
   import-side CLI effect, then clean up.
6. Harden CLI argv parsing (one adapter path + optional --since, exit 2 on bad usage),
   SIGINT/SIGTERM → AbortController, never install process handlers on library import.
7. CI matrix: ubuntu-latest/windows-latest × Node 22.15.0/22/24, each running npm ci + npm
   test + verify-package.mjs; release workflow gated on the same CI, not just Ubuntu unit
   tests — look up exact reusable-workflow (workflow_call) syntax before editing.
8. Preserve verified Changesets v2.1.0 inputs; pin an exact verified npm 11 version for
   trusted publishing — record the chosen version/source, never guess from memory.

One commit per task on `release/0.2.0-reliability`.

## Current state

- Tasks 0–10 complete (baseline/ledger through real consumer/failure/replay proof). Full
  per-task detail: `VERIFICATION.md`.
- Task 10 needed **zero production code changes** — every new test passed against the
  existing Task 1–9 implementation on the first real run.
- Proved: V01–V04, N01–N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04, L01 (both the
  withStoreLock boundary and, since Task 10, the full runIngest-orchestration boundary
  via two real child processes + a gated loopback endpoint)/L02, O01–O03, C01–C02,
  E01–E04 — see `TEST-MATRIX.md`.
- Both real adapters (earthquake.usgs.gov 5/5, www.karnatakacareers.org 6/6) proved via
  real end-to-end `runIngest` replay (E01: fresh/identical-replay/edited-field/broken-
  mapping, native `Response`, deterministic fixture-derived `now`), not just
  validate/extract. `scripts/run-earthquake-{offline,broken}.mjs` executed for real this
  session (gitignored `store/`/`runs/` paths) — both ran cleanly; `offline` correctly
  reports a stale canary against real wall-clock `now` (fixture is ~3 weeks old), `broken`
  correctly exits 1.
- Full suite: 269/269 (268 pass, 1 documented skip — Windows symlink privilege); +16 vs.
  Task 9's 253. `node scripts/verify-store-scale.mjs`: PASS (100 unique IDs under a 96 MiB
  V8 heap against a 256 MiB history).
- Standing authorizations: work on `release/0.2.0-reliability`, one commit/task, execute
  inline without delegation. Still in effect.
- package-lock.json root metadata mismatch: Task 11 reconciles this; don't touch now.

## Pending

- Tasks 11–12 remain. Task 12's actual npm publish needs separate explicit authorization.
- CI matrix (Linux+Windows × Node 22.15/22/24) is Task 11's job; currently Ubuntu/Node 24 only.

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
