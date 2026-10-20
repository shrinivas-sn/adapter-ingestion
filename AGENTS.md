# AGENTS.md: working with @shrinivas-sn/adapter-ingestion

For coding agents that have only the installed package. Paths below are relative to
`node_modules/@shrinivas-sn/adapter-ingestion/`.

This package runs a scheduled ingestion job: it fetches a JSON API or a server-rendered HTML
page, turns it into records, stores new and changed records in a local JSONL file, and
writes a run report with a canary that flags a source that changed shape or went quiet.
Each source is described by an **adapter**: a JSON file, not code.

## Files in this package

| File | Use it for |
|---|---|
| `README.md` | The full guide: API, adapter keys, source kinds, reports, gotchas |
| `schema/adapter.schema.json` | JSON Schema for adapters (also `@shrinivas-sn/adapter-ingestion/adapter.schema.json`) |
| `types/*.d.mts` | TypeScript types for every subpath |
| `VERSIONING.md` | What each release may change; the deprecation policy |
| `UPGRADING.md` | What each minor version adds, and what to change |
| `src/cli.mjs` | The `adapter-ingestion` command (`npx adapter-ingestion --help`) |

## Rules that save time

- Check every adapter with `npx adapter-ingestion validate <adapter.json> --json` before
  running it. `validateAdapter` is the authority; the schema only helps while writing.
- Unknown keys **inside** a section (`access`, `fetch`, `map.*`, `canary`, `html`, ...) are
  errors, not ignored. If one is rejected, check the README and `UPGRADING.md`: it may need
  a newer version. Unknown **top-level** keys are allowed (`$schema`, and your own
  metadata), so a misspelled top-level key like `record_path` is ignored. Since 0.5,
  `doctor` and run reports flag a near-miss of `fetch`, `records_path`, `required` or
  `canary` with `A_TOP_LEVEL_KEY_TYPO`. Start your own metadata keys with `_` so they are
  never flagged.
- Set `host` to the exact hostname in `access.url` (keep a leading `www.` if the URL has
  it). It names the store file (`store/<host>.jsonl`), the runs directory and every record
  id (`<host>:<source_id>`), so changing it later starts a new store.
- `records_path` defaults to `"$"` (the parsed body itself is the array of records).
- Use `"normalize": "iso-datetime"` (since 0.7) to keep the time of day; `iso-date` keeps
  only the day. A time with no zone gives `null` unless the rule has `"assume_zone": "Z"`;
  add that only when the source documents its times as UTC.
- `access.url` must be on `host` (or a subdomain of it).
- `map.source_id` and `map.url` are always required.
- Never put an API key or token in adapter JSON. Use
  `"fetch": { "headers": { "Authorization": { "env": "API_TOKEN" } } }` (since 0.6) and set
  the variable where the run happens. Unset → `E_HEADER_ENV`, exit 2; add
  `"optional": true` to send no header instead.
- `outcome: "stale"` means the run completed but the canary tripped. It needs a look, not a
  retry.
- Never change an adapter to make a canary pass without checking the source itself.

## Recipe: add a JSON API source

1. Fetch one real response and find the array of records (`records_path`, `"$"` for a
   top-level array).
2. Write the adapter:

   ```json
   {
     "$schema": "./node_modules/@shrinivas-sn/adapter-ingestion/schema/adapter.schema.json",
     "version": 1,
     "host": "api.example.org",
     "access": { "tier": 0, "kind": "json-api", "url": "https://api.example.org/v1/items" },
     "records_path": "results",
     "map": {
       "source_id": { "path": "id" },
       "url": { "path": "link" },
       "title": { "path": "name", "normalize": "text" },
       "published": { "path": "date", "normalize": "iso-date" }
     },
     "required": ["source_id", "url", "title"],
     "canary": { "min_records": 1, "median_window": 5, "count_drop_ratio": 0.4, "required_field_ratio": 0.9 }
   }
   ```

3. `npx adapter-ingestion validate adapter.json --json` → `{"ok":true,"errors":[]}`.
4. `npx adapter-ingestion doctor adapter.json --json` → `"ok": true`. Before any run it
   also lists `A_CANARY_NO_HISTORY`: expected, since there is no past run yet. An
   `A_TOP_LEVEL_KEY_TYPO` notice means a top-level key is misspelled: fix it before the
   first run.
5. `npx adapter-ingestion run adapter.json --json` → check `outcome` and `stages.parsed`.

Pagination, retries, byte caps, headers and incremental fetching are under `fetch`; see the
README section "Writing an adapter by hand" and the schema's descriptions.

## Recipe: add an HTML page source

1. `npm install cheerio` (the optional peer; without it html adapters fail with
   `E_KIND_DEPENDENCY`).
2. Confirm the data is in the server's first response (view source, not the live DOM):
   pages filled in by JavaScript are not supported.
3. Use `access.kind: "html"` and an `html` block:
   - `select` mode: `rows` (a CSS selector, one record per match) and `fields` (each
     `{ selector?, attr?, resolve_url? }`); `records_path` must be `"$"`.
   - `script_json` mode: `script` (a CSS selector for a `<script>` holding JSON, such as
     JSON-LD or `__NEXT_DATA__`); then `records_path` and `map` work as for JSON.
4. Validate, doctor and run as above.

## Recipe: run on a schedule (CI)

A CI job usually starts from a fresh checkout, so `runs/` is gone and `count_drop_ratio`
never has history (every report then carries `A_CANARY_NO_HISTORY`). Keep history in a
file committed next to the store:

```sh
npx adapter-ingestion run adapters/api.example.org.adapter.json \
  --store store/api.example.org.jsonl \
  --runs runs/api.example.org \
  --history store/api.example.org.history.jsonl
```

Commit `store/` after the run. Exit code `0` is ok, `1` is stale or an operational error,
`2` is a configuration problem. In code: `runIngest({ adapter, paths: { storeFile, runsDir,
historyFile } })`.

## Recipe: debug a stale canary

1. Read the newest `runs/<host>/report-*.json` (or the `run --json` output).
2. `canary.breaches` names the check:
   - `min_records` or `required_field_ratio`: a field was probably renamed. Compare a
     fresh response with the `map` paths; `errors` holds sample rejected records.
   - `count_drop_ratio`: far fewer records than the trailing median. Check whether the
     source really shrank before changing anything.
   - `staleness`: the newest `staleness_field` value is too old: the source stopped
     updating, or the date field moved.
3. `failure.code` (when `outcome` is `error`): run `npx adapter-ingestion explain <CODE>`.

## Recipe: upgrade between minor versions

On 0.x, `^0.3.0` never moves to 0.4.0 by itself.

1. Read the version's section in `UPGRADING.md` ("Free with no changes", "Opt in",
   "Action needed").
2. Bump the range in `package.json` and install.
3. Run `npx adapter-ingestion doctor <adapter.json>` for each adapter, then one real run,
   and read `notices`: advice (`A_*`) about what the new version offers this adapter, and
   deprecations (`D_*`) with `removed_in`.
4. `npx adapter-ingestion doctor <adapter.json> --check-updates` says whether an even newer
   version exists.

## Codes

Every `E_*` error, `A_*` advice and `D_*` deprecation code. For details:
`npx adapter-ingestion explain <CODE>`.

<!-- codes:start -->
| Code | Kind | Meaning | Fix |
|---|---|---|---|
| `A_CANARY_NO_HISTORY` | advice | count_drop_ratio could not run: no comparable past runs were found. | Set paths.historyFile (CLI: --history) to a file you commit with the store. |
| `A_TOP_LEVEL_KEY_TYPO` | advice | A top-level key is one edit away from fetch, records_path, required or canary, so that setting is probably misspelled and is being ignored. | Rename it to the suggested key. If it is your own metadata, start its name with _ so it is never flagged. |
| `E_ABORTED` | error | The run was cancelled through its AbortSignal. | Nothing is wrong with the source. Run again; nothing was appended to the store after the abort. |
| `E_ADAPTER_INVALID` | error | The adapter failed validation, so nothing was fetched. | Run `adapter-ingestion validate <adapter.json>`; it lists every error. If a key is unknown, check whether it needs a newer engine version. |
| `E_FETCH` | error | The request failed before a response arrived. | Check the URL and network access. Connection failures are retried when fetch.retry allows it. |
| `E_FETCH_DEADLINE` | error | The whole fetch took longer than fetch.max_duration_ms. | Raise fetch.max_duration_ms, lower max_pages, or reduce retry delays. |
| `E_FILTER_INVALID` | error | A filter definition failed validation. | Fix the filter JSON; the message lists each problem. |
| `E_HEADER_ENV` | error | A fetch header reads an environment variable that is unset, empty, or not a valid header value. | Set the variable where the run happens (in CI, as a secret). Mark the header "optional": true to send no header when it is unset. |
| `E_HTTP_STATUS` | error | The server answered with a status that is not a success. | Open the URL by hand. 429 and 5xx are retried when fetch.retry allows it; other statuses need an adapter change. |
| `E_KIND_DEPENDENCY` | error | A source kind needs an optional package that is not installed. | Install it next to this package: `npm install cheerio`. |
| `E_LOCK_RELEASE` | error | The run finished but its store lock file could not be removed. | Check the store directory, then remove the leftover `.lock` file once no run is active. |
| `E_OPTIONS` | error | An option passed to the API or CLI is invalid. | Fix the named option. No report is written when the paths themselves are invalid. |
| `E_PAGE_LIMIT` | error | Pagination reached max_pages while pages were still full. | Raise fetch.pagination.max_pages, or set allow_truncation: true to accept a bounded window. |
| `E_PAGINATION_REPEAT` | error | A page was an exact repeat of the previous one. | Check fetch.pagination.param against the API docs. |
| `E_PARSE` | error | A source kind could not turn the response into records. | Debug the kind's parse function against the saved response. |
| `E_PARSE_NO_MATCH` | error | An html selector that must match found nothing. | Re-check the selector against the current page and update the adapter. |
| `E_RECORD_INVALID` | error | A record could not be built in the store contract shape. | Check the map rules for source_id and url. |
| `E_RECORD_LIMIT` | error | The fetch produced more records than fetch.max_records. | Raise fetch.max_records if the growth is real. |
| `E_REDIRECT` | error | The server answered with a redirect, which is never followed. | Put the final URL in the adapter. |
| `E_REPORT_READ` | error | Past run reports or the history file could not be read. | Check that the path is readable. |
| `E_REPORT_WRITE` | error | The run report or history file could not be written. | Check that the path is writable. The in-memory report is still attached to the error. |
| `E_RESPONSE_JSON` | error | The response body is not valid JSON. | Open the URL by hand; if it is an HTML page, use access.kind "html". |
| `E_RESPONSE_LIMIT` | error | One response was larger than fetch.max_response_bytes. | Raise fetch.max_response_bytes if the size is expected. |
| `E_RESPONSE_SHAPE` | error | records_path did not resolve to an array. | Compare records_path with a current response. |
| `E_RETRY_DEFERRED` | error | The server asked for a retry delay longer than the configured budget. | Run later, or raise fetch.retry.max_delay_ms and fetch.max_duration_ms. |
| `E_STORE_LINE_LIMIT` | error | One record is larger than the store line limit. | Map fewer fields, or raise the store max_line_bytes option. |
| `E_STORE_LOCKED` | error | Another run holds this store's lock. | Let the other run finish. Remove the `.lock` file only after confirming no run is active. |
| `E_STORE_READ` | error | The store file could not be read. | Check that the path is readable. |
| `E_STORE_WRITE` | error | Records could not be appended to the store. | Check the store directory. The report's storage.status says whether the batch may have partly landed. |
| `E_TIMEOUT` | error | One request took longer than fetch.timeout_ms. | Raise fetch.timeout_ms. Timeouts are retried when fetch.retry allows it. |
| `E_TOTAL_BYTES_LIMIT` | error | All responses together exceeded fetch.max_total_bytes. | Raise fetch.max_total_bytes, or lower max_pages. |
<!-- codes:end -->
