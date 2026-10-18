---
"@shrinivas-sn/adapter-ingestion": minor
---

Source kinds: ingest HTML pages and your own formats, not only JSON.

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
