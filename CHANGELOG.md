# @shrinivas-sn/adapter-ingestion

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
