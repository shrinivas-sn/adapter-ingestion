# Project status

**`@shrinivas-sn/adapter-ingestion@0.2.0` is published and live on npm**, as of
2026-09-18. `main` is at `face358`. Registry-confirmed: `dist-tags.latest: "0.2.0"`.
Full `plan.md` release (Tasks 0–12) complete and closed.

## Next up (start here)

Nothing blocking — this release cycle is closed. If picking this project back up:

1. To add a new source: `node src/run.mjs adapters/<HOST>.adapter.json`, or write an
   adapter by hand per README.md's "Writing an adapter by hand".
2. To extend scope (HTML/RSS/other source kinds, currently out of scope by design): read
   `plan.md` §11 "Deferred roadmap and future decision triggers" first — each deferred item
   names the evidence needed before it becomes a real plan. Not scheduled; no evidence yet.
3. Optional future hardening, neither urgent: revisit npm's Trusted Publisher
   staged-vs-direct-publish setting if a second collaborator ever gets write access; add
   `npm publish --provenance` if attestation becomes wanted (see VERIFICATION.md for both).

## Current state

- Published version `0.2.0`, commit `face358`. Full suite 281/281 (279 pass, 2 documented
  platform-limitation skips) on the published commit.
- Every `TEST-MATRIX.md` scenario Tasks 1–12 own is `pass`, all on real evidence (CI runs,
  registry queries, fresh installs) — not local-only success.
- Publishing needed two real fixes along the way (missing Trusted Publisher, then npm's
  staged-publish default) plus one bug found and fixed at the source (the release-branch
  lockfile now self-heals via `package.json`'s `"version"` script). Full account, including
  the security tradeoff the user explicitly decided on staged-vs-direct publish: see
  VERIFICATION.md's "Task 12 completion" entry.
- Standing authorizations: implementation work throughout; pushing/merging/publishing each
  extended only by explicit user request immediately preceding it, never assumed ahead.

## Pending

Nothing.

Release spec: `plan.md`. Full scenario ledger: `TEST-MATRIX.md`. Command evidence: `VERIFICATION.md`.
