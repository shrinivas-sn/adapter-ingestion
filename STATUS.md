# Project status

**`@shrinivas-sn/adapter-ingestion@0.2.0` is published and live on npm**, as of
2026-09-18. `main` is at `face358` (PR #2 merge — the real version-bump commit).
Registry-confirmed: `dist-tags.latest: "0.2.0"`. Full plan.md release (Tasks 0–12) complete.

## Next up (start here)

Nothing blocking. The 0.2.0 release is done, published, and verified against the real
registry-installed package (not just local success). Natural next steps, none urgent:

- If the repo ever gains a second collaborator with write access, revisit npm's
  "staged-publish-only" option for the Trusted Publisher (currently set to allow direct
  publish, an explicit, informed choice while this repo is single-maintainer — see
  VERIFICATION.md's Task 12 completion entry for the tradeoff as discussed).
- Provenance attestation isn't attached to this release (trusted publishing via OIDC alone
  doesn't add it automatically; would need `npm publish --provenance` wired into the
  release script). Optional future hardening, not a gap in what shipped.
- plan.md's deferred-roadmap table (§11) has real future decision triggers (RSS/XML, URL
  templates, cursor pagination, POST/GraphQL/auth) — none scheduled, no evidence yet to act on.

## Current state

- **Published version:** `0.2.0`. **Commit:** `face358` on `main`.
  **Verification:** `VERIFICATION.md`'s "Task 12 completion" entry — registry metadata
  queried directly (not CLI-cached), fresh install from the real registry into a new
  disposable consumer, full smoke flow (first/replay/edit/broken-mapping/filter) passed
  against the actual published package, not `npm pack` or this repo's `src/`.
- **The publish needed two real troubleshooting rounds**, both from actual logs/docs, both
  resolved by the user's own explicit npm-account decisions: (1) no Trusted Publisher was
  configured at all (404) — user added one with the exact fields verified against npm's own
  docs; (2) npm defaults a new Trusted Publisher to staged-publish-only (403) — user
  explicitly weighed the tradeoff (matters once there's a second collaborator with write
  access; doesn't yet) and enabled direct publish. Full account in VERIFICATION.md.
- **Found and fixed a second real bug during this process** (same class as the CI-caught
  one in Task 11, found the same way — by actually running the real automation, not
  assuming it): `changesets/action` regenerates (force-pushes) the release PR branch from
  scratch on *every* push to `main`, not just changeset changes — silently discarding a
  manual `package-lock.json` fix pushed there directly. Fixed at the source
  (`package.json`'s `"version"` script now also runs `npm install --package-lock-only`, so
  every future release self-heals the lockfile automatically), not re-patched by hand.
- Tasks 0–12 all complete. Full per-task detail: `VERIFICATION.md`. Every TEST-MATRIX.md
  scenario Tasks 1–12 own is `pass` (K01–K03, Q01–Q02 included, all on real evidence — CI
  runs, registry queries, fresh installs — not local-only success).
- Full suite: 281/281 (279 pass, 2 documented platform-limitation skips) on the published
  commit.
- Standing authorizations: implementation work — in effect throughout. Extended this
  session, by explicit user request at each step, to cover: opening PR #3, merging PR #3,
  merging PR #2, and the actual `npm publish`. Nothing was pushed, merged, or published
  without that explicit request immediately preceding it.

## Pending

Nothing. This release cycle is closed.

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
