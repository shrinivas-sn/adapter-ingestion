# Project status

As of 2026-09-18. `main` is at `55db8d0` (PR #3 merged, reliability-release changeset
added). The real 0.2.0 candidate is verified on PR #2
(https://github.com/shrinivas-sn/adapter-ingestion/pull/2, `changeset-release/main` @
`70c8e8d`) — CI green, package verified — but **not published**.

## Next up (start here)

**Publishing 0.2.0 needs the user's own explicit authorization, separate from everything
done so far.** Merging PR #2 is the action that triggers the real `npm publish` (via
`changesets/action` → trusted publishing, no token). Nothing in this session's standing
authorization covers that — do not merge PR #2 without being asked.

Once authorized:
1. Merge PR #2. `release.yml` re-runs `validate` (full matrix) then `release`; with no
   pending changesets left, `changeset publish` actually runs this time.
2. Investigate any publish failure from real logs — don't fall back to manual
   `npm login`/`npm publish` unless the documented OIDC-404 failure mode (README's
   "Publishing" section) actually recurs.
3. After success: query `npm view @shrinivas-sn/adapter-ingestion version dist-tags --json`,
   inspect published metadata/provenance, install the exact published version into a fresh
   disposable consumer, repeat the smoke flow, compare files/version/integrity against the
   candidate recorded in VERIFICATION.md. Record Q02.
4. Update STATUS.md with the published version/commit/verification links only after that
   succeeds.

## Current state

- **PR #3** (Tasks 0–11, `release/0.2.0-reliability` → `main`) merged by explicit user
  request (`36f6123`). First real push of this branch — confirmed via `git ls-remote`
  beforehand that neither `main` nor any other remote branch had any of this work yet.
- The merge triggered `release.yml` for real: `validate` (full CI matrix) passed, `release`
  installed the pinned `npm@11.19.1` and ran `changesets/action`, which correctly updated
  the pre-existing "Version Packages" PR without publishing (a changeset was still
  pending) — exactly as designed.
- **Task 12 (in progress, review/version/candidate steps only):** added
  `.changeset/reliability-release.md` (plan.md's exact minor-bump text), verified via an
  isolated `git clone` dry run first (computes `0.2.0` correctly, no npm lifecycle-hook
  collision, deleted after inspection) before touching the real repo. Pushed to `main`
  (`55db8d0`); PR #2 now correctly shows `0.2.0`, combining this and the pre-existing patch
  changeset.
- **Found and fixed the same lockfile-reconciliation gap Task 11 already fixed once**:
  `changeset version` doesn't touch `package-lock.json`, so PR #2's branch had
  `package.json` at 0.2.0 but the lockfile root still at 0.1.0. Fixed directly on PR #2's
  branch (`70c8e8d`) via a real `npm install`, dependency diff confirmed empty
  (`added/removed/changed: []`).
- **Q01 evidence real and recorded**: `scripts/verify-package.mjs` run against the actual
  0.2.0 candidate commit — PASS, tarball `shrinivas-sn-adapter-ingestion-0.2.0.tgz`, 20
  entries, integrity/shasum recorded in VERIFICATION.md. Full suite 281/281 on the same
  commit. PR #2's own CI: 6/6 green.
- **Not done, deliberately**: verifying actual npmjs.com Trusted Publishing settings
  (blocked — no programmatic access to that UI from this session, not inferred from YAML);
  the actual publish (blocked on explicit authorization, see "Next up").
- Registry check: `npm view @shrinivas-sn/adapter-ingestion` still shows `0.1.0` as latest
  — `0.2.0` confirmed unused, nothing published yet.
- Full suite: 281/281 (279 pass, 2 documented platform-limitation skips), unchanged since
  Task 11 — no source code changed in Task 12's work so far, only `.changeset/`/
  `package.json`/`package-lock.json`/`CHANGELOG.md` (all Changesets-owned) plus this
  session's own lockfile fix.
- Standing authorizations: implementation work on `release/0.2.0-reliability`/`main`, one
  commit/task, execute inline without delegation — still in effect. Extended this session,
  by explicit request, to cover opening PR #3 and merging it. **Does not extend to merging
  PR #2 or any real publish action** — those need their own explicit go-ahead.

## Pending

- PR #2 (`Version Packages`, → `0.2.0`) is open, green, verified, and ready — merging it
  is what actually publishes. Waiting on explicit authorization.
- After publish: post-publish registry/provenance verification (Q02) and final STATUS.md
  update with the real published version/commit.

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
