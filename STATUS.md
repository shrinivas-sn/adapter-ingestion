# Project status

As of 2026-09-18. Committed baseline: Task 11 + real CI proof, commit `5fef967` on
`release/0.2.0-reliability`, open as PR #3 against `main`
(https://github.com/shrinivas-sn/adapter-ingestion/pull/3). Prior commit: `28a80de` (Task 10).

## Next up (start here)

PR #3's CI is **green on all 6 matrix cells** (real GitHub Actions run
35374076499 — see VERIFICATION.md's Task 11 addendum). K03 is genuinely `pass`, not
locally-inferred. The PR itself has not been merged — that's the user's call, not
something to do automatically.

Once the user decides to merge, read plan.md Task 12 — review, version, and publish only
the verified candidate. Files: new `.changeset/reliability-release.md`;
`package.json`/`package-lock.json`/`CHANGELOG.md` via Changesets;
`VERIFICATION.md`/`TEST-MATRIX.md`/`STATUS.md`.

1. Review the final diff against plan.md's full scope, section 8 matrix, and the
   no-new-runtime-dependency rule. Independent review pass (delegated or inline).
2. Require every scenario owned by Tasks 1–11 passed with no unexplained failures/skips —
   now all real (K01–K03 all `pass`, real CI evidence recorded).
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
implementation work, not a real npm release or merge.

## Current state

- Tasks 0–11 complete (baseline/ledger through API docs + installed-artifact verification),
  **plus real CI evidence obtained via PR #3**. Full per-task detail: `VERIFICATION.md`.
- **The real CI run caught a genuine bug on its first try — in this session's own test, not
  in production code.** `test/cli.test.mjs`'s SIGINT test asserted the whole `store/`
  *directory* never gets created on an aborted run; `withStoreLock` legitimately creates
  that directory while *acquiring* the lock (already-proven Task 8 behavior, unrelated to
  this task), before the fetch that gets aborted ever runs. Root cause confirmed
  independently with a standalone probe script (not inferred from the failure alone) before
  touching the assertion. Fixed by checking the specific store *file* (never written) and
  the lock file (cleanly released) instead of the directory — a stricter, more accurate
  check, not a loosened one. Full diagnosis and evidence: VERIFICATION.md's Task 11
  addendum. This was one root cause manifesting identically across all 3 failing Linux
  matrix cells, not several unrelated problems — confirmed by pulling each job's raw log
  directly, not trusting the checks summary alone.
- **Task 11's CLI hardening also found one genuine pre-existing defect** (separate from the
  above, found before the PR was opened): the old CLI never wrapped its adapter
  file-read/JSON-parse in a try/catch at all — a missing/malformed adapter file escaped as
  an uncaught top-level-await rejection (raw stack trace to stderr, wrong exit code). Fixed
  as part of this task's documented argv/exit-code contract.
- `README.md` rewritten around a self-contained, **proven** Quick Start (extracted verbatim
  from the doc and run twice against the real installed tarball, in a disposable directory
  outside this repo — matched the documented output exactly both times, including the
  replay claim). New `MIGRATION-0.2.md` covers every compatibility change plan.md §3.2
  names. New `scripts/verify-package.mjs`: real `npm pack` → disposable consumer install
  (`--ignore-scripts --omit=dev`) → consumer script importing only installed-package
  subpaths (`import.meta.resolve` confirms `node_modules`, not a relative fallback) → real
  PASS, both locally and in CI.
- `package.json`/`package-lock.json` reconciled: `engines.node` → `>=22.15.0`,
  `MIGRATION-0.2.md` added to `files`, lockfile root metadata fixed via real `npm install`
  — **zero dependency version changes**, diffed explicitly (added/removed/version-changed
  all `[]`).
- `.github/workflows/ci.yml`/`release.yml`: full matrix (`{ubuntu-latest,windows-latest} ×
  {22.15.0,22,24}`), `workflow_call`-callable, `release` gated on a `validate` job, npm
  pinned to a registry-verified exact `11.19.1`. **Confirmed on real GitHub Actions, not
  just locally**: all 6 cells green, every step (including the Node-24-only scale proof)
  confirmed to have actually executed via the GitHub API's per-step conclusions, not just
  the overall pass/fail.
- Full suite: 281/281 (279 pass, 2 documented skips — Task 8's Windows symlink-privilege
  skip, plus a Windows-signal skip in `test/cli.test.mjs`: `child.kill('SIGINT')`
  force-terminates a Windows Node child without ever invoking its handler, verified
  empirically both locally and confirmed by the passing Windows CI cells). +12 vs. Task
  10's 269.
- Proved: V01–V04, N01–N02, X01, F01, H01–H04, P01–P03, R01–R03, S01–S04, L01 (both
  boundaries)/L02, O01–O03, C01–C02, E01–E04, K01–K03 (all `pass`, K03 on real CI evidence)
  — see `TEST-MATRIX.md`.
- Standing authorizations: work on `release/0.2.0-reliability`, one commit/task, execute
  inline without delegation. Extended this session to cover pushing/opening a PR (explicit
  user request) — does **not** extend to merging the PR or publishing, which still need
  their own explicit confirmation.

## Pending

- PR #3 is open and green; merging it is the user's call.
- Task 12 remains; its actual npm publish needs separate explicit authorization (already
  noted above and in plan.md).

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
