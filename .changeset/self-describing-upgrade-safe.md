---
"@shrinivas-sn/adapter-ingestion": minor
---

Self-describing and upgrade-safe: types, an adapter schema, a CLI, run-report notices, canary
history that survives CI, and a written versioning policy. Everything is additive.

No changes needed:
- Every run report has a new `notices` array: advice (`A_*`) and deprecations (`D_*`) for
  your adapter. Notices never change `outcome` or an exit code. `report_version` stays `2`.
  First code: `A_CANARY_NO_HISTORY` (`count_drop_ratio` had no past runs to compare with).
- TypeScript types for every subpath (`.d.mts`, generated from JSDoc), plus type exports
  (`RunIngestOptions`, `Report`, `Notice`, ...) from the root module.
- Shipped docs: `AGENTS.md`, `llms.txt`, `VERSIONING.md` (what each release may change, and
  the deprecation policy) and `UPGRADING.md`.

Opt in:
- `paths.historyFile` (CLI `--history`): a small run-history file you commit with the store,
  so the canary's `count_drop_ratio` works on CI jobs that start from a fresh checkout.
- The `adapter-ingestion` command: `validate`, `run`, `explain`, `doctor`, each with
  `--json`; `doctor --check-updates` reports a newer version.
- `"$schema"` in an adapter, pointing at `schema/adapter.schema.json` (also exported as
  `@shrinivas-sn/adapter-ingestion/adapter.schema.json`), for editor autocomplete.

Action needed:
- None.

Contract-freeze additions: report key `notices`; a new notice-code list
(`A_CANARY_NO_HISTORY`); the `./adapter.schema.json` subpath; `types` conditions on every
subpath; the CLI surface. No error code, export name or record key changed.
