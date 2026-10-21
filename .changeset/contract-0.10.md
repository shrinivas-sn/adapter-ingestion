---
"@shrinivas-sn/adapter-ingestion": minor
---

Public contract audit before 1.0: every part is now documented, typed and pinned.

- `doctor` now checks the optional `cheerio` package for `feed` adapters too, and exits 2
  when it is missing (before, `doctor` passed and `run` failed with `E_KIND_DEPENDENCY`).
- `adapter-ingestion --version` prints the installed version.
- `explain` knows the four `W_*` warning codes.
- An upper-case `host` now says "host must be lower case".
- The JSON Schema matches the engine on URL scheme case, host case, numbers above 2^53 and
  `records_path` for `csv`, `feed` and html `select` adapters.
- Precise TypeScript types for adapter sections, the `limits` a kind receives, and report
  values.
- README has full adapter key and run report references.
- Nothing changes for valid adapters, records, stores or reports.
