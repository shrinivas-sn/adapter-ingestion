# @shrinivas-sn/adapter-ingestion

## 0.9.0

### Minor Changes

- d590cf4: New `feed` source kind: `access.kind: "feed"` reads an RSS 2.0, RSS 1.0 or Atom feed, one
  record per item, with the same keys whatever the format: `id`, `url`, `title`, `summary`,
  `content`, `published`, `updated`, `author`, `categories`. Needs the optional `cheerio`
  package, as `html` does.
  
  - RSS dates (`Tue, 06 Oct 2026 17:00:00 +0000`) and Atom dates become ISO 8601 UTC; a date
    that cannot be read exactly is `null`.
  - The format is detected from the root element, so a feed served as
    `application/octet-stream` still works; any other document is `E_PARSE`.
  - DTD entities are never expanded and external entities are never read.
  - Like `csv`, the new built-in yields to a kind you registered as `feed`.
  - Nothing changes for existing adapters.

## 0.8.0

### Minor Changes

- 75fddc2: New `csv` source kind: `access.kind: "csv"` reads a CSV file with a header row, one record
  per row, cells as strings and empty cells as `null`. No extra package needed.
  
  - New map rule `{ "template": "..." }` in place of `path` builds a value from several
    fields (`"{entity}:{year}"`, `"https://example.org/item/{id}"`); a missing value makes the
    field `null`.
  - A built-in kind added from 0.8 on yields to a kind you registered under the same name, so
    a parser you registered as `csv` keeps being used. `json-api` and `html` stay protected.
  - No changes needed for existing adapters.

## 0.7.0

### Minor Changes

- 043c7ca: New `iso-datetime` normalizer: keeps the time of day and returns UTC
  (`2026-10-19T20:53:15+05:30` → `2026-10-19T15:23:15.000Z`). A value with no zone, no time
  or an impossible date gives `null`.
  
  - New optional map rule key `assume_zone: "Z"` (with `iso-datetime` only) reads a time
    that has no zone as UTC.
  - No changes needed for existing adapters; `iso-date` is unchanged.

## 0.6.0

### Minor Changes

- 8737ded: A `fetch.headers` value can now be `{ "env": "NAME" }`, so an API key or token comes
  from an environment variable instead of the adapter JSON. The value never appears in
  errors, run reports, the history file or CLI output.
  
  - An unset or empty variable fails the run with the new `E_HEADER_ENV` code (CLI exit 2)
    before any request. Add `"optional": true` to send no header instead.
  - No changes needed for existing adapters.

## 0.5.0

### Minor Changes

- 3516fd4: New advice notice `A_TOP_LEVEL_KEY_TYPO`: a top-level adapter key one edit away from
  `fetch`, `records_path`, `required` or `canary` (such as `record_path`) is no longer
  ignored without a word.
  
  No changes needed:
  - `doctor` and run reports of valid adapters name the misspelled key and the key it
    probably meant. Notices never change `outcome` or an exit code.
  - Top-level keys that start with `_` are reserved for your own metadata: never
    flagged, never given a meaning.

## 0.4.0

### Minor Changes

- 95e8a59: Self-describing and upgrade-safe: types, an adapter schema, a CLI, run-report notices, canary
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

## 0.3.0

### Minor Changes

- ad8d531: Source kinds: ingest HTML pages and your own formats, not only JSON.
  
  No changes needed:
  - Existing JSON adapters behave identically; `json-api` parses exactly as before.
  - The core still has no runtime dependencies.
  
  Opt in:
  - `access.kind: "html"` with an `html` block: `select` mode (CSS selectors to one record per
    row) or `script_json` mode (the JSON inside a `<script>`, such as JSON-LD or
    `__NEXT_DATA__`). Install the optional peer first: `npm install cheerio`. Page encoding is
    detected from the BOM, the `Content-Type` charset and `<meta charset>`, with UTF-8 as the
    fallback. html responses default to a 5 MB cap (JSON keeps 20 MB), and a page with more
    rows than `max_records` fails before any record is built.
  - The `kinds` option on `runIngest`, `fetchAll` and `validateAdapter` registers a custom
    parser (CSV, XML, ...) that gets every transport guarantee: timeouts, byte caps, retries,
    pagination checks and the canary.
  
  New error codes: `E_PARSE`, `E_PARSE_NO_MATCH`, `E_KIND_DEPENDENCY`. The unknown-kind and
  unknown-key validation messages now say the adapter may need a newer engine version.

## 0.2.0

### Minor Changes

- 55db8d0: Harden JSON ingestion with strict adapter and record validation, bounded fetches,
  retries, explicit pagination completeness, local store locking, streaming history
  reads, and final run reports. Require Node 22.15.0 or newer. See MIGRATION-0.2.md
  for stricter configuration, fetch injection, pagination, and recovery behavior.

### Patch Changes

- 4997013: Fix the `text` normalizer deleting numeric HTML character references
  (`&#8211;`, `&#038;`, `&#x...;`) instead of decoding them -- found
  integrating a real WordPress source, where every title containing an en
  dash or an ampersand was silently mangled.

## 0.1.0

### Minor Changes

- c9b813a: Initial release: generic fetch -> extract -> dedupe -> store pipeline for adapter-driven
  ingestion from sites with no API, a declarative read-time relevance filter, and a canary
  that flags a stale adapter when a source changes shape. The published package ships only
  the engine (src/); this repo also carries the earthquake.usgs.gov and
  www.karnatakacareers.org adapters as worked examples, not part of the npm package itself.
