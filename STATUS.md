# Project status

As of 2026-09-18. Committed baseline: Task 11 (API docs + installed-artifact verification),
committing next on `release/0.2.0-reliability`. Prior commit: `28a80de` (Task 10).

## Next up (start here)

**Before Task 12: push this branch / open a PR to actually trigger CI on the new matrix.**
Everything in Task 11 that can be verified locally has been (YAML validity, job wiring,
action-version currency, `verify-package.mjs`, full test suite) — but K03 (the real
ubuntu-latest/windows-latest × Node 22.15.0/22/24 CI run) needs an actual GitHub Actions
run, which needs a push/PR. That's a visible, shared-state action — do it once the user
confirms, not automatically.

Then read plan.md Task 12 — review, version, and publish only the verified candidate.
Files: new `.changeset/reliability-release.md`; `package.json`/`package-lock.json`/
`CHANGELOG.md` via Changesets; `VERIFICATION.md`/`TEST-MATRIX.md`/`STATUS.md`.

1. Review the final diff against plan.md's full scope, section 8 matrix, and the
   no-new-runtime-dependency rule. Independent review pass (delegated or inline).
2. Require every scenario owned by Tasks 1–11 passed with no unexplained failures/skips;
   K03 needs actual CI evidence (see above) before this gate is real.
3. Add the reliability-release changeset (minor bump) — preserve the existing
   `fix-text-normalizer-entities` changeset so Changesets incorporates both.
4. Recheck npm registry dist-tags; confirm 0.2.0 is still unused.
5. Use the normal Changesets version-PR flow once pushing is authorized — do not manually
   bump version. Verify `npm run version` doesn't collide with a conflicting lifecycle hook.
6. Run tests/matrix/package verification on the actual version commit; pack and record the
   candidate's version/file-list/integrity/hash. Q01 passes only now.
7. **Publish only when the user explicitly authorizes release** — trusted publishing
   through `release.yml`, not manual `npm publish`/token workarounds unless that documented
   failure mode actually recurs.
8. After publication: query the registry, install the exact published version into a fresh
   consumer, repeat the smoke flow, record Q02.

One commit per task on `release/0.2.0-reliability`. Task 12's actual publish step needs
separate explicit authorization — the general standing authorization below covers
implementation work, not a real npm release.

## Current state

- Tasks 0–11 complete (baseline/ledger through API docs + installed-artifact verification).
  Full per-task detail: `VERIFICATION.md`.
- **Task 11's CLI hardening found one genuine pre-existing defect**: the old CLI never
  wrapped its adapter file-read/JSON-parse in a try/catch at all — a missing/malformed
  adapter file escaped as an uncaught top-level-await rejection (raw stack trace to stderr,
  wrong exit code). Fixed as part of this task's documented argv/exit-code contract.
- `README.md` rewritten around a self-contained, **proven** Quick Start (extracted verbatim
  from the doc and run twice against the real installed tarball, in a disposable directory
  outside this repo — matched the documented output exactly both times, including the
  replay claim). New `MIGRATION-0.2.md` covers every compatibility change plan.md §3.2
  names. New `scripts/verify-package.mjs`: real `npm pack` → disposable consumer install
  (`--ignore-scripts --omit=dev`) → consumer script importing only installed-package
  subpaths (`import.meta.resolve` confirms `node_modules`, not a relative fallback) → real
  PASS.
- `package.json`/`package-lock.json` reconciled: `engines.node` → `>=22.15.0`,
  `MIGRATION-0.2.md` added to `files`, lockfile root metadata fixed via real `npm install`
  — **zero dependency version changes**, diffed explicitly (added/removed/version-changed
  all `[]`).
- `.github/workflows/ci.yml` now runs the full matrix (`{ubuntu-latest,windows-latest} ×
  {22.15.0,22,24}`, `npm ci`+`npm test`+`verify-package.mjs` every cell, scale proof once
  per OS on Node 24) and is `workflow_call`-callable. `release.yml` gates `release` on a
  new `validate` job (`uses: ./.github/workflows/ci.yml`) and pins npm to an exact verified
  `11.19.1` (registry-checked — npm's own `latest` dist-tag has since moved to 12.x) instead
  of floating `npm@latest`. Verified locally as far as a local session can: YAML parses,
  job wiring correct, every action version (`checkout@v7`, `setup-node@v7`,
  `upload-artifact@v7`) confirmed current via the GitHub API — **not yet run on actual
  GitHub Actions** (needs a push/PR; see "Next up").
- Full suite: 281/281 (279 pass, 2 documented skips — Task 8's Windows symlink-privilege
  skip, plus a new Windows-signal skip in `test/cli.test.mjs`: `child.kill('SIGINT')`
  force-terminates a Windows Node child without ever invoking its handler, verified
  empirically, a Node/Windows platform limitation, not a gap in this CLI). +12 vs. Task
  10's 269.
- Proved: V01–V04, N01–N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04, L01 (both
  boundaries)/L02, O01–O03, C01–C02, E01–E04, K01–K02 — see `TEST-MATRIX.md`. K03 is
  `blocked`, not `unproven` or `pass` — the workflow exists and is locally validated;
  what's missing is a real CI run.
- Standing authorizations: work on `release/0.2.0-reliability`, one commit/task, execute
  inline without delegation. Still in effect for implementation work — does **not** cover
  pushing to GitHub, opening a PR, or publishing, all of which need explicit confirmation.

## Pending

- Task 12 remains; its actual npm publish needs separate explicit authorization (already
  noted above and in plan.md).
- K03 needs an actual GitHub Actions run — blocked on push/PR authorization, not on any
  further local work.

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
