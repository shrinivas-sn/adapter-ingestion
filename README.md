# adapter-ingestion

[![npm](https://img.shields.io/npm/v/@shrinivas-sn/adapter-ingestion)](https://www.npmjs.com/package/@shrinivas-sn/adapter-ingestion)
[![CI](https://github.com/shrinivas-sn/adapter-ingestion/actions/workflows/ci.yml/badge.svg)](https://github.com/shrinivas-sn/adapter-ingestion/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@shrinivas-sn/adapter-ingestion)](package.json)
[![license](https://img.shields.io/npm/l/@shrinivas-sn/adapter-ingestion)](LICENSE)

Keeps a Node app supplied with fresh records from JSON APIs, CSV files, RSS and Atom feeds,
and server-rendered HTML pages on a schedule. That covers official APIs, the JSON endpoints
many sites expose without advertising them as an API, published CSV data files, blog, news
and release feeds, and plain HTML listings read with CSS selectors.
An adapter is a small JSON config written once per source, and a plain-rules runner applies
it on every cron at zero LLM cost. A relevance filter is a read-time view over stored
records, never a write-time gate. A canary flags a stale adapter, loudly, when a source
changes shape or quietly stops returning data.

Published to npm as [`@shrinivas-sn/adapter-ingestion`](https://www.npmjs.com/package/@shrinivas-sn/adapter-ingestion).
Requires **Node 22.15.0 or newer**. Upgrading from 0.1.x? See [MIGRATION-0.2.md](MIGRATION-0.2.md).

## Is this for you?

**Use it if** you are in Node and want scheduled JSON, CSV, feed or HTML pulls into a plain file store
with no database. You also get change detection (fresh / changed / unchanged) and an alarm when
a source goes quiet or changes shape.

**Look elsewhere if:**

- You are in Python or want a warehouse or database destination. Use
  [dlt](https://github.com/dlt-hub/dlt)'s REST API source.
- You want no-code "watch this and notify me" agents. Use
  [Huginn](https://github.com/huginn/huginn).
- You need POST, GraphQL, OAuth, or pages that only render in a browser. This package does
  not do them (see [Non-goals](#non-goals)).

**What it ingests today** (HTTP GET, see [Source kinds](#source-kinds)):
- JSON (`json-api`).
- CSV files with a header row (`csv`, since 0.8).
- RSS 2.0, RSS 1.0 and Atom feeds (`feed`, since 0.9). Needs the optional `cheerio` package.
- HTML pages (`html`): rows picked by CSS selectors, or the JSON inside a `<script>` such
  as JSON-LD or `__NEXT_DATA__`. Needs the optional `cheerio` package.
- Any other format (other XML, ...) through a `kinds` parser you register.

```
  generator (once, per source)  ->  adapter file
                                        |
  fetch -> extract -> dedupe -> store  (this package)
                                        |
                                   RECORD CONTRACT   <-- the framework stops here
                                        |
                            filter (a read-time view)
                                        |
                                  ( consuming app )   store/analyze/recalculate/notify
```

The framework never decides what the data is for. Storing into an app's domain model,
analytics, recalculation, and notification are the consuming app's job.

## Install

```
npm install @shrinivas-sn/adapter-ingestion
```

**The published package ships only the generic engine**: `src/`, `types/` (TypeScript
types), `schema/` (the adapter JSON Schema), this README, `AGENTS.md`, `llms.txt`,
`VERSIONING.md`, `UPGRADING.md`, `CHANGELOG.md`, `MIGRATION-0.2.md` and
`NOTES-generalization.md`. No adapters, fixtures or scripts. You bring your own adapter JSON
and run it with `runIngest` from your own code, or with the `adapter-ingestion` command.

The core has no runtime dependencies. For `access.kind: "html"` or `"feed"`, also install the optional
peer once: `npm install cheerio`. JSON and CSV users never need it.

## Quick start

This is a complete, runnable example — no repository adapter files, no live network call.
Save it as `example.mjs` and run `node example.mjs`:

```js
import { runIngest } from '@shrinivas-sn/adapter-ingestion';
import { readLatestRecords } from '@shrinivas-sn/adapter-ingestion/store';
import { applyFilter } from '@shrinivas-sn/adapter-ingestion/filter';

// A minimal adapter for a JSON API that returns an array of posts.
const adapter = {
  version: 1,
  host: 'example.test', // must match access.url's hostname (or a subdomain of it)
  access: { tier: 0, kind: 'json-api', url: 'https://example.test/api/posts' },
  fetch: { method: 'GET', timeout_ms: 10_000 },
  records_path: '$', // "$" = the whole response body is the array; otherwise a dot path, e.g. "results"
  map: {
    source_id: { path: 'id' },
    url: { path: 'link' },
    title: { path: 'title', normalize: 'text' },
    posted_at: { path: 'published', normalize: 'iso-date' },
  },
  required: ['source_id', 'url', 'title'],
  canary: { min_records: 1, median_window: 5, count_drop_ratio: 0.4, required_field_ratio: 0.9 },
};

// In production, fetchImpl defaults to the real global fetch -- omit it entirely
// and runIngest will make a real HTTP request. Here, a local fixture stands in
// for the network call so this example runs offline and deterministically; the
// package requires a genuine Response either way (a hand-rolled `{json: ...}`
// double is not accepted -- see MIGRATION-0.2.md).
const fixture = [
  { id: 1, link: 'https://example.test/posts/1', title: 'Hello world', published: '2026-09-01T00:00:00Z' },
  { id: 2, link: 'https://example.test/posts/2', title: 'Second post', published: '2026-09-05T00:00:00Z' },
];
const fetchImpl = async () => new Response(JSON.stringify(fixture), { status: 200 });

const paths = {
  storeFile: 'store/example.test.jsonl', // append-only JSONL history for this host
  runsDir: 'runs/example.test',          // one report-*.json written per invocation
};

try {
  const { report, canary } = await runIngest({
    adapter,
    paths,
    fetchImpl,
    // now defaults to `new Date()` -- pass it explicitly for a deterministic/
    // testable clock, or when computing canary staleness against a fixed point in time.
    now: new Date(),
  });

  // A stale canary is a normal (resolved, not thrown) outcome -- it means the
  // adapter or source needs attention, not that this run crashed.
  if (canary.status === 'stale') {
    console.warn('canary stale:', canary.breaches);
  }
  console.log(report.outcome, report.stages); // { fetched, parsed, fresh, changed, unchanged, written }

  // readLatestRecords collapses the append-only history to last-write-wins per
  // ID -- what you almost always want for display (readRecords instead
  // returns every historical revision, on purpose).
  const latest = await readLatestRecords(paths.storeFile);
  const { kept } = applyFilter(latest, {
    mode: 'all',
    rules: [{ field: 'fields.title', op: 'includes_any', value: ['world'] }],
  }, new Date());
  console.log(kept.map((r) => r.fields.title));
} catch (err) {
  // A thrown error is a genuine failure: bad config, network/transport
  // failure, storage failure, or the store already being locked by another
  // concurrent run. err.code names it (e.g. E_ADAPTER_INVALID, E_FETCH,
  // E_STORE_WRITE, E_STORE_LOCKED); err.report, if present, is the same
  // report shape that would have been returned on success, already
  // persisted to disk under paths.runsDir.
  console.error(`ingest failed: ${err.code} - ${err.message}`);
  process.exitCode = 1;
}
```

Run it twice — the second run reports `fresh: 0` and `unchanged: 2`; nothing new gets
appended to `store/example.test.jsonl`.

## Command line

The package installs an `adapter-ingestion` command (since 0.4). Run it with `npx`:

| Command | What it does | Network |
|---|---|---|
| `adapter-ingestion validate <adapter.json>` | Checks an adapter offline and lists every error | none |
| `adapter-ingestion run <adapter.json> [--since DATE] [--store FILE] [--runs DIR] [--history FILE]` | Runs one ingestion. Defaults: `store/<host>.jsonl`, `runs/<host>` | the adapter's source only |
| `adapter-ingestion explain <CODE>` | Meaning, likely cause and fix for any `E_*`, `W_*`, `A_*` or `D_*` code | none |
| `adapter-ingestion doctor <adapter.json> [--runs DIR] [--history FILE] [--check-updates]` | Validates, checks Node and the optional `cheerio` peer, and lists notices. `--check-updates` asks the npm registry for the latest version | none, unless `--check-updates` |
| `adapter-ingestion --version` | Prints the installed version (since 0.10) | none |

Every command takes `--json` and then prints exactly one JSON object on stdout:

- `validate`: `{ ok, errors }`
- `run`: `{ outcome, stages, canary, notices, failure }`
- `explain`: `{ code, kind, meaning, cause, fix }`
- `doctor`: `{ ok, errors, notices, environment: { node, node_ok, cheerio } }`, plus
  `update: { status, current, latest }` with `--check-updates`
- a usage or load error: `{ error: { code, message } }`

Exit codes: `0` ok; `1` a stale run, an operational error or an abort; `2` a usage or
configuration problem (bad arguments, an invalid adapter, an unsupported Node version, an
html or feed adapter without `cheerio`, or an unset `fetch.headers` environment variable). Without `--json`, `run` prints a summary on stdout and
notices and failures on stderr. These commands, flags, keys and exit codes are part of the
public surface ([VERSIONING.md](VERSIONING.md)). The older `node src/run.mjs <adapter.json>`
entry point still works unchanged.

## API

Every function below has a stable input/output/error contract. A thrown error is an
`IngestionError` whose `code` is an `E_*` code; `npx adapter-ingestion explain E_FETCH`
explains any code.

TypeScript types ship with the package (since 0.4): each subpath resolves its own `.d.mts`
through `exports`, generated from the source's JSDoc, so editors and agents see real
signatures instead of `any`. The root module also exports the main shapes as types:
`import type { RunIngestOptions, RunResult, Report, Notice, Adapter, StoreRecord, Kind } from '@shrinivas-sn/adapter-ingestion'`.
The package itself is still plain JavaScript with no runtime dependencies.

**Root (`@shrinivas-sn/adapter-ingestion`)**
- `runIngest({ adapter, paths, since, fetchImpl, signal, kinds, now = new Date(), store })` →
  `Promise<{ report, canary }>` on success (including a `stale` canary — that's not a
  failure). Rejects with an `IngestionError` (`err.code`, `err.message`, `err.report`) on a
  config, transport, storage, lock, cancellation, or reporting failure. `paths.storeFile`/
  `paths.runsDir` are required nonempty strings. `since` (a `YYYY-MM-DD` string, or an ISO date-time when
  `fetch.incremental.type` is `"iso-datetime"`) switches to incremental mode and requires `adapter.fetch.incremental` to be configured. `signal` (an
  `AbortSignal`) cancels an in-flight fetch/wait; a cancellation that lands after the store
  append already committed does not roll back that commit. `kinds` registers your own
  formats (see [Source kinds](#source-kinds)); a malformed one is `E_OPTIONS`.
  `paths.historyFile` (optional) keeps the canary's run history in one small file you can
  commit (see [Canary history on CI](#canary-history-on-ci)); it must differ from
  `paths.storeFile`. `report.notices` lists advice and deprecations for this adapter (see
  [Reading a run report](#reading-a-run-report)).
- Parse errors: `E_RESPONSE_JSON` (invalid JSON), `E_PARSE` (a `csv` or `feed` body that
  cannot be read, or a registered kind threw), `E_PARSE_NO_MATCH` (`html.script` matched
  nothing), `E_KIND_DEPENDENCY` (`html` or `feed` without `cheerio` installed).

**`/adapter`**
- `validateAdapter(adapter, { kinds }?)` → `{ ok: boolean, errors: string[] }`. Never
  throws. Pass the same `kinds` you give `runIngest` so a custom kind validates.
- `verifyAgainstFixtures(adapter, fixtureItems)` → `{ total, parsed, ratio, fieldFailures }`
  — run this against real fetched samples before trusting a generated adapter.

**`/store`**
- `readRecords(filePath, { maxLineBytes, onWarning }?)` → `Promise<Record[]>` — every
  historical revision, in file order. A missing file resolves to `[]`, never throws.
- `iterateRecords(filePath, { maxLineBytes, onWarning }?)` → `AsyncGenerator<Record>` — every
  revision, in file order, one at a time: for stores too big for `readRecords`.
- `readLatestRecords(filePath, options?)` → `Promise<Record[]>` — last-write-wins per ID.
- `readIndex(filePath, options?)` → `Promise<Map<id, content_hash>>`.
- `appendRecords(filePath, records, { maxLineBytes }?)` → `Promise<number>` (count
  written). Throws `E_STORE_WRITE`/`E_STORE_LINE_LIMIT` before writing anything on an
  invalid batch — never a partial write on a validation failure.
- `withStoreLock(filePath, { runId }, async (canonicalStoreFile) => result)` → the
  callback's own return value. Throws `E_STORE_LOCKED` if another run already holds the
  lock — this package does not queue, retry, or steal a lock; see MIGRATION-0.2.md.

**`/filter`**
- `validateFilter(filterDef)` → `{ ok, errors }`.
- `applyFilter(records, filterDef, now = new Date())` → `{ kept, dropped }`. Throws
  `E_FILTER_INVALID` on an invalid filter — validate once with `validateFilter` if you want
  to fail before this point instead.
- `evaluateRule(record, rule, now = new Date())` → `boolean` for one rule. Throws
  `E_FILTER_INVALID` on an invalid rule.

**`/fetch`**
- `fetchAll(adapter, { since, fetchImpl = fetch, signal, kinds }?)` → `Promise<{ items,
  pages, statuses, diagnostics }>`. `fetchImpl` must resolve with a real `Response`.
- `buildUrl(adapter, { page, since }?)` → the request URL (a string) for that page.

**`/canary`**
- `checkCanary(report, history, cfg, { now = new Date() }?)` → `{ status: 'ok'|'stale',
  breaches: string[], skipped: [{check, reason}] }`.

**`/report`**
- `buildReport({ ... })` → the v2 report object (see [Run report reference](#run-report-reference)).
- `writeReport(dir, report)` → `Promise<string>` (the written file's path). Publishes
  atomically (temp file + rename); a crash mid-write never leaves a half-written report at
  the final name.
- `readHistory(dir, limit = 5)` / `readEligibleHistory(dir, limit, isEligible?)` →
  `Promise<Report[]>`, newest first, skipping malformed/legacy-shaped files.

**`/contract`**
- `buildRecord({ host, sourceId, sourceUrl, fields, raw, fetchedAt })` → a record (throws
  `E_RECORD_INVALID` on an invalid identity/URL/timestamp/field value).
- `contentHash(fields)`, `canonicalize(value)`, `isValidSourceId(v)`, `isValidSourceUrl(v)`.
- `assertNoUndefined(value, rootPath = '$')` — throws `E_RECORD_INVALID` naming the path of
  the first `undefined` value or non-plain object inside `value`.

**`/extract`**
- `extractAll(rawItems, adapter, { fetchedAt })` → `{ records, errors, errorCount,
  fieldFailures }`. `errorCount` is always the true total; `errors` is capped at 20 samples.
- `getPath(obj, path)` — own-properties-only dot-path reader (`"$"` = the whole object; a
  numeric segment indexes an array). Never traverses the prototype chain.

**`/normalize`**
- `applyNormalizer(name, value, options?)` — `name` is one of `text`, `number`, `iso-date`, `iso-datetime`, `bool`; `options.assume_zone` may be `"Z"`.
- `isValidDateOnly(value)`.

**`/dedupe`**
- `splitByIndex(records, index)` → `{ fresh, changed, unchanged }`.

## Writing an adapter by hand

For autocomplete and inline checks in your editor, point the adapter at the JSON Schema
that ships with the package (since 0.4). Either the installed copy, which works offline:

```json
{ "$schema": "./node_modules/@shrinivas-sn/adapter-ingestion/schema/adapter.schema.json", "version": 1, "...": "..." }
```

or a version-pinned URL:
`https://unpkg.com/@shrinivas-sn/adapter-ingestion@0.10.0/schema/adapter.schema.json`.
The schema is also importable as `@shrinivas-sn/adapter-ingestion/adapter.schema.json`. It
helps while writing; `validateAdapter` (or `npx adapter-ingestion validate`) stays the
authority, because some rules (selector compilation, cross-field checks) cannot be expressed
in a schema. `$schema` does not change an adapter's fingerprint, so adding it keeps the
canary's history.

Top-level keys the engine does not read are ignored, so you can keep your own metadata in an
adapter. Start their names with `_` (`_notes`, `_owner`): no release will give such a key a
meaning. Since 0.5, a top-level key one edit away from `fetch`, `records_path`, `required`
or `canary` (for example `record_path`, `recordsPath`, `requried`, `canry`) gets an
`A_TOP_LEVEL_KEY_TYPO` notice in `doctor` and in the run report, naming the key it probably
meant. Fixing such a key turns that setting on, so the next run can behave differently. It
also changes the adapter's fingerprint, so `count_drop_ratio` starts a new history. Keys
inside a section are stricter: an unknown one fails validation.

`map` entries are `{ path, normalize?, assume_zone? }` or `{ template }`. `path` is a dot-path into the raw source item
(`"$"` for the item itself, `geometry.coordinates.0` for an array index). `normalize` is
one of `text` (strips HTML, decodes numeric character references, collapses whitespace),
`number`, `iso-date` (validates a real calendar date; returns `YYYY-MM-DD` or `null` —
never a silently-wrapped invalid date), `iso-datetime` (since 0.7; keeps the time and
returns UTC `YYYY-MM-DDTHH:mm:ss.sssZ`, for example `2026-10-19T20:53:15+05:30` →
`2026-10-19T15:23:15.000Z`; a value with no zone, no time, or an impossible date gives
`null`), or `bool`. `assume_zone: "Z"` (since 0.7, only with `iso-datetime`) reads a time
that has no zone as UTC, for sources that document their times as UTC, such as WordPress
`date_gmt`. A value with its own zone keeps it. Switching a field from `iso-date` to
`iso-datetime` changes its stored value, so every record shows as changed once, and the
adapter fingerprint changes (`count_drop_ratio` starts a new history). `source_id` and
`url` are always required identity fields, independent of whatever else you list in
`required`.

`template` (since 0.8) builds a value from several fields of the raw item, for a source with
no URL column or no single id column:

```json
"source_id": { "template": "{entity}:{year}" },
"url": { "template": "https://earthquake.usgs.gov/earthquakes/eventpage/{id}" }
```

- `{name}` reads a path, as `path` does (dot segments, no `$`). Other `{` or `}`
  characters are not allowed. A template may have no placeholder (a fixed value).
- A placeholder needs a non-blank string or a finite number. Anything else (missing, `null`,
  blank, `true`, an object) makes the whole field `null`, never a half-built value.
- In a template that starts with `http://` or `https://`, each value is percent-encoded
  (`/` is kept, so `openrouter.ai/{id}` works with `anthropic/claude`), and the scheme and
  host must be written out: `https://{host}/x` is a validation error.
- In any other template, values are inserted as they are. `template` cannot be combined
  with `path`, `normalize` or `assume_zone`.

`access.url`'s hostname must equal `adapter.host` (or be a subdomain of it) — this is a
provenance guarantee, not a formality: it's what makes a record's `source_host` trustworthy.

`fetch.headers` (optional) maps a header name to a string, or to
`{ "env": "NAME", "optional"?: true }` to read a secret from an environment variable (since
0.6), for example `"Authorization": { "env": "API_TOKEN" }`. The value is read once when the
run starts and sent on every page. It never appears in an error, a run report, the history
file or CLI output, and a custom `kinds` parser sees only the reference. An unset or empty
variable fails the run with `E_HEADER_ENV` (CLI exit 2) before any request; with
`"optional": true` the header is left out instead. Put the full header text in the variable
(`Bearer …` included). Rotating the secret keeps the adapter's fingerprint; moving a literal
value into a reference changes it once, so `count_drop_ratio` starts a new history.

`fetch.pagination` (optional): `{ style: 'page-param', param, per_page?, per_page_param?,
max_pages?, allow_truncation? }`. Hitting `max_pages` on a still-full-looking page is a
hard failure unless `allow_truncation: true`.

### Adapter key reference

Every key the engine reads (since 0.10 listed here in full). "Safe integer" means at most
2^53 − 1. `—` in **Since** means 0.2 or earlier.

**Top level**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `$schema` | string; editor support only, ignored by the engine | none | 0.4 |
| `version` | `1`; required | none | — |
| `host` | lower-case bare hostname, at most 253 characters; required | none | — |
| `access` | object (below); required | none | — |
| `fetch` | object (below) | all defaults | — |
| `records_path` | `"$"` or dot segments; must be `"$"` for the built-in `csv` and `feed` kinds and html `select` | `"$"` | — |
| `map` | object: field name → map rule (below); `source_id` and `url` required | none | — |
| `required` | array of unique mapped field names | none | — |
| `canary` | object (below) | all defaults | — |
| `html` | object; required with `access.kind: "html"`, not allowed otherwise. See [Source kinds](#source-kinds) | none | 0.3 |

Any other top-level key is your own metadata (start it with `_`).

**`access`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `tier` | integer 0–5; required | none | — |
| `kind` | `"json-api"`, `"html"` (0.3), `"csv"` (0.8), `"feed"` (0.9), or a kind you register; required | none | — |
| `url` | `http(s)` URL, no credentials, on `host` or a subdomain of it; required | none | — |

**`fetch`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `method` | `"GET"` only | `"GET"` | — |
| `headers` | header name → string, or `{ "env": "NAME", "optional"?: true }`: `env` names the environment variable; `optional` `true` sends no header when it is unset | none | env refs 0.6 |
| `timeout_ms` | integer 1–2147483647; one request | 30000 | — |
| `max_duration_ms` | integer 1–2147483647; the whole fetch, retries included | 120000 | — |
| `max_records` | positive safe integer | 5000 | — |
| `max_response_bytes` | positive safe integer; one response | 20000000 (`html`, `feed`: 5000000) | — |
| `max_total_bytes` | positive safe integer; all responses together | 100000000 | — |
| `delay_ms` | integer 0–2147483647; wait between pages | 0 | — |
| `pagination` | object (below) | one page | — |
| `incremental` | object (below); needed for `since` | none | — |
| `retry` | object (below) | all defaults | — |

**`fetch.pagination`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `style` | `"page-param"` only; required | none | — |
| `param` | nonempty string: the page-number query parameter; required | none | — |
| `max_pages` | positive safe integer | 1 | — |
| `per_page` | positive safe integer; a shorter page ends pagination | none | — |
| `per_page_param` | string; needs `per_page`, must differ from `param` | none | — |
| `allow_truncation` | boolean; `true` turns hitting `max_pages` into `W_PAGE_LIMIT` instead of `E_PAGE_LIMIT` | `false` | — |

**`fetch.incremental`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `param` | nonempty string; must not equal a pagination parameter; required | none | — |
| `type` | `"iso-date"` (`since` is `YYYY-MM-DD`) or `"iso-datetime"` (`since` is a date-time such as `2026-10-19T04:18:47` or `2026-10-19T04:18:47Z`, sent unchanged); required | none | `iso-datetime`: 0.11 |

Use `iso-datetime` when the source wants a time too (WordPress REST `after` and
`modified_after` reject a date alone). The engine checks the form and never converts the
value: the source decides what a missing zone means.

**`fetch.retry`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `max_attempts` | integer 1–5 | 3 | — |
| `backoff_ms` | integer 0–60000 | 500 | — |
| `max_delay_ms` | integer 0–60000, at least `backoff_ms` | 10000 | — |

**`map` rule**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `path` | dot-path into the raw item (`"$"` = the item); required unless `template` is set | none | — |
| `template` | string with `{name}` placeholders; not with `path`, `normalize` or `assume_zone` | none | 0.8 |
| `normalize` | `"text"`, `"number"`, `"iso-date"`, `"iso-datetime"` (0.7), `"bool"` | none | — |
| `assume_zone` | `"Z"`; only with `iso-datetime` | none | 0.7 |

**`canary`**

| Key | Type and range | Default | Since |
|---|---|---|---|
| `min_records` | nonnegative safe integer | 1 | — |
| `required_field_ratio` | number 0–1 | 0.9 | — |
| `median_window` | integer 1–100 | 5 | — |
| `count_drop_ratio` | number 0–1 | 0.4 | — |
| `max_staleness_days` | number above 0; set with `staleness_field` | none | — |
| `staleness_field` | a field name in `map`; set with `max_staleness_days` | none | — |

These checks run with their defaults even when the adapter has no `canary` block; staleness
runs only when both `max_staleness_days` and `staleness_field` are set.

## Source kinds

`access.kind` says how a response body becomes records. Parsing happens after the bounded
read, so every kind gets the same transport rules: timeouts, byte caps, retries, no
redirects, pagination and repeat-page checks, `max_records`, and the canary.

**`json-api`**: the body is JSON; `records_path` points at the array of records.

**`csv`** (since 0.8): a CSV file with a header row. Each data row becomes one record, keyed
by the header names, so `map` paths are column names. No extra package is needed.

```json
{
  "version": 1,
  "host": "earthquake.usgs.gov",
  "access": { "tier": 0, "kind": "csv", "url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.csv" },
  "map": {
    "source_id": { "path": "id" },
    "url": { "template": "https://earthquake.usgs.gov/earthquakes/eventpage/{id}" },
    "place": { "path": "place", "normalize": "text" },
    "magnitude": { "path": "mag", "normalize": "number" },
    "time": { "path": "time", "normalize": "iso-datetime" }
  },
  "required": ["source_id", "url", "magnitude"]
}
```

- The format is RFC 4180: `,` between cells, `"` around a cell that holds commas, quotes
  (written `""`) or line breaks. Line ends may be LF, CRLF or CR. Empty lines are skipped.
- The body must be UTF-8 (a byte-order mark is removed); anything else is `E_PARSE`.
- Every cell is the exact string, untrimmed; an empty cell is `null`. Use `normalize` to get
  numbers, dates and booleans.
- Header names are used exactly as written. A repeated name, or more than 1000 columns, is
  `E_PARSE`. A column with an empty header name is left out of the record.
- A short row gives `null` for its missing cells. A value past the last header column (or
  under an empty header name) is `E_PARSE`; empty trailing cells are fine.
- Broken quoting (text after a closing quote, a quote never closed) is `E_PARSE`. Every
  `E_PARSE` message names the line, never the cell text.
- `records_path` must be omitted or `"$"`. Rows beyond `fetch.max_records` fail with
  `E_RECORD_LIMIT` while parsing. Every row holds every named column, so rows times named
  columns is capped at 5,000,000 (`E_PARSE`); the defaults never reach it.
- The stored `raw` is the whole row, every named column included.

The repository's `adapters/ourworldindata.org.adapter.json` is a worked example, with a
composite id (`{entity}:{year}`) and its recorded file under `fixtures/`.

**`feed`** (since 0.9): an RSS 2.0, RSS 1.0 (RDF) or Atom 1.0 feed, such as a WordPress
site's `/feed/`, a GitHub `releases.atom` or a news feed. Each item or entry becomes one
record, with the same keys whatever the format, so one `map` works for any feed. Install
the optional peer first (`npm install cheerio`); without it, a feed adapter fails with
`E_KIND_DEPENDENCY`.

```json
{
  "version": 1,
  "host": "wordpress.org",
  "access": { "tier": 0, "kind": "feed", "url": "https://wordpress.org/news/feed/" },
  "map": {
    "source_id": { "path": "id" },
    "url": { "path": "url" },
    "title": { "path": "title", "normalize": "text" },
    "published": { "path": "published", "normalize": "iso-datetime" }
  },
  "required": ["source_id", "url", "title"]
}
```

| Key | RSS | Atom |
|---|---|---|
| `id` | `guid` | `id` |
| `url` | `link`, else a `guid` that is a permalink | the `link` with no `rel` or `rel="alternate"` (`type="text/html"` first) |
| `title` | `title` | `title` |
| `summary` | `description` | `summary` |
| `content` | `content:encoded` | `content` (the markup itself when `type="xhtml"`) |
| `published` | `pubDate`, else `dc:date` | `published` |
| `updated` | always `null` | `updated` |
| `author` | `author`, else `dc:creator` | the entry's `author` `name`, else the feed's |
| `categories` | every `category` | every `category` `term` |

- Every key is always present. Text is trimmed; an empty or missing value is `null`.
  `categories` is an array, possibly empty.
- `published` and `updated` are already ISO 8601 UTC (`2026-10-06T17:00:00.000Z`): RSS dates
  (`Tue, 06 Oct 2026 17:00:00 +0000`) are converted. A date that cannot be read exactly is
  `null`.
- `url` is resolved against the feed URL; anything but `http`/`https` becomes `null`.
- The format is detected from the root element (`rss`, `rdf:RDF` or `feed`), not the
  Content-Type. Any other root, such as an HTML error page, is `E_PARSE`.
- Encoding: a byte-order mark, else the Content-Type charset, else the XML declaration, else
  UTF-8. DTD entities are never expanded and external entities are never read.
- `records_path` must be omitted or `"$"`. Items beyond `fetch.max_records` fail with
  `E_RECORD_LIMIT`. An empty feed gives 0 records (the canary's `min_records` reports it).
- The stored `raw` is the item object above, not the XML.

The repository's `adapters/wordpress.org.adapter.json` (RSS) and
`adapters/github.com.adapter.json` (Atom) are worked examples, with recorded feeds under
`fixtures/`.

**`html`**: server-rendered pages. Install the optional peer first (`npm install cheerio`);
without it, an html adapter fails with `E_KIND_DEPENDENCY`. Selectors are data in the
adapter, never code. An unsupported selector (such as `:hover`) fails as
`E_ADAPTER_INVALID`, naming the field. The data must be in the server's first response:
pages that only fill in through JavaScript are not supported.

- `select` mode: one record per element matching `rows`. A field is the trimmed text of the
  first element matching its `selector` inside the row (no `selector` means the row itself),
  or that element's `attr`. A missing element or empty value is `null`. With
  `resolve_url: true` the value becomes an absolute URL against the page URL; anything but
  `http`/`https` (such as `javascript:` or `mailto:`) becomes `null`. `records_path` must be
  `"$"`.

  ```json
  "access": { "tier": 2, "kind": "html", "url": "https://news.ycombinator.com/" },
  "html": {
    "mode": "select",
    "rows": "tr.athing",
    "fields": {
      "id":    { "attr": "id" },
      "title": { "selector": ".titleline > a" },
      "link":  { "selector": ".titleline > a", "attr": "href", "resolve_url": true }
    }
  },
  "records_path": "$",
  "map": { "source_id": { "path": "id" }, "url": { "path": "link" }, "title": { "path": "title", "normalize": "text" } }
  ```

- `script_json` mode: `{ "mode": "script_json", "script": "script#__NEXT_DATA__" }`. The
  JSON inside the first matching element becomes the body, and `records_path` and `map` work
  as for `json-api`. To pick one of several JSON-LD blocks, match on content:
  `script[type="application/ld+json"]:contains("ItemList")`. No match is `E_PARSE_NO_MATCH`;
  invalid JSON is `E_RESPONSE_JSON`.

Encoding is detected from the raw bytes: a byte-order mark first, then the `Content-Type`
charset, then `<meta charset>`. With none of these, the page is read as UTF-8. Legacy
encodings such as windows-1252, KOI8-R or Shift_JIS decode correctly.

The repository's `adapters/` folder has worked html examples for seven sites on different
platforms, each with its recorded page under `fixtures/`.

**Your own format (`kinds`)**: register a parser and name it in `access.kind`.

```js
const tsv = {
  // Bytes in, an array of plain objects out (sync or async).
  parse({ bytes }) {
    const [header, ...lines] = bytes.toString('utf8').trim().split('\n');
    const keys = header.split('\t');
    return lines.map((line) => Object.fromEntries(line.split('\t').map((v, i) => [keys[i], v])));
  },
  // Optional: extra adapter checks, reported like built-in ones.
  validate(adapter, need) { need(adapter.records_path === '$', 'tsv adapters use records_path "$"'); },
};

// adapter.access = { tier: 1, kind: 'tsv', url: 'https://example.test/data.tsv' }
await runIngest({ adapter, paths, kinds: { tsv } });
```

`parse` receives `{ bytes, contentType, url, adapter, limits }`, where `limits` is
`{ maxRecords, remainingRecords }`. `json-api` and `html` can never be
replaced: registering either name is `E_OPTIONS`. A built-in kind added later (since 0.8:
`csv`; since 0.9: `feed`) is used only when you have not registered a kind of that name, so a parser you
registered as `csv` before 0.8 keeps being used; drop it to switch to the built-in. If
`parse` throws, the run fails with `E_PARSE` and a generic message: your
error's text never reaches a report (it stays on `err.cause`). A result that is not the array
`records_path` expects fails with `E_RESPONSE_SHAPE`, as for JSON.

## Writing a filter

A filter is declarative data, never code. `mode: "all"` ANDs its rules, `"any"` ORs them.
Operators: `any_of`, `none_of`, `between`, `gte`, `lte`, `within_days`, `after_date`,
`includes_any`, `excludes_any`, `exists`. A rule on a missing field fails by default,
except `none_of`/`excludes_any`/`exists:false`, which pass — absence is not a match, but it
is the absence of a disqualifier. `field` addresses the record itself, so a mapped field
lives under `fields.` (e.g. `fields.title`, `fields.magnitude`).

## Reading a run report

Every invocation writes exactly one `runs/<host>/report-*.json`, including a run that threw
before finishing — a cron job with no report artifact fails invisibly for weeks; this never
skips writing one. Check `outcome` first: `"ok"` or `"stale"` mean the run completed
(`stale` needs attention, not a retry); `"error"`/`"aborted"` mean it didn't — `failure.
{code, message, stage}` says where and why. `stages.{fetched,parsed,fresh,changed,
unchanged,written}` explain the numbers; `error_count`/`errors` (capped at 20 samples) and
`warning_count`/`warnings` cover rejected records and store-corruption/pagination-truncation
notices respectively. `canary.breaches` names which threshold tripped
(`min_records`/`required_field_ratio`/`count_drop_ratio`/`staleness`) when
`canary.status === "stale"`. Every key and value: [Run report reference](#run-report-reference).

`notices` (since 0.4) is a list of advice (`A_*`) and deprecations (`D_*`) about this
adapter: what this engine version offers it, and anything it uses that will be removed.
Each notice has `code`, `kind` (`"advice"` or `"deprecation"`), `message`, `since`, `docs`,
and optionally `path` (the adapter key involved) and `removed_in`. Notices never change
`outcome` or an exit code, and they never contain values, URLs or headers, so they are safe
to log. Read them after every upgrade. `report_version` is still `2`: new keys are additive
(see [VERSIONING.md](VERSIONING.md)).

### Canary history on CI

`count_drop_ratio` compares this run with the median of past runs, read from
`runs/<host>/`. A scheduled CI job that starts from a fresh checkout has no `runs/`, so the
check never has history and never fires; every run then carries an `A_CANARY_NO_HISTORY`
notice. Fix it by keeping the history in a file you commit next to the store:

```js
await runIngest({
  adapter,
  paths: {
    storeFile: 'store/example.gov.jsonl',
    runsDir: 'runs/example.gov',
    historyFile: 'store/example.gov.history.jsonl',
  },
});
```

Each line holds one finished run's `report_version`, `run_id`, `host`,
`adapter_fingerprint`, `mode`, `outcome`, `started_at` and `stages`, and nothing else (no
errors, URLs or headers). The file keeps the newest `max(50, 2 × median_window)` lines and
is rewritten atomically under the store lock. With `historyFile` set, the canary reads
history only from it. A run that fails validation or cannot take the lock adds no line.

### Run report reference

Every top-level key of a report (since 0.10 listed here in full). New keys and values may
be added in a minor version; code that reads reports must ignore ones it does not know.

| Key | Type | Meaning |
|---|---|---|
| `report_version` | `2` | Report format version. |
| `run_id` | string | Unique id of this run; also in the report's file name. |
| `adapter_fingerprint` | string or `null` | Hash of the adapter's settings; `count_drop_ratio` compares only runs with the same one. `null` when the adapter failed validation. |
| `mode` | `"snapshot"` or `"incremental"` | `incremental` when the run had `since`. |
| `outcome` | string | `"ok"`, `"stale"` (completed, canary tripped), `"error"` or `"aborted"`. |
| `host` | string or `null` | The adapter's `host`; `null` when the adapter has none. |
| `started_at`, `finished_at` | string | ISO timestamps. |
| `duration_ms` | number | `finished_at` minus `started_at`. |
| `stages` | object | `{ fetched, parsed, fresh, changed, unchanged, written }` counts; `written` is `null` when `storage.status` is `uncertain`. |
| `error_count` | number | How many items were rejected (the true total). |
| `errors` | array | Up to 20 rejected-item samples (below). |
| `fatal_error` | string or `null` | Same text as `failure.message`, kept for older readers. |
| `failure` | object or `null` | `{ code, message, stage, details? }` when `outcome` is `error` or `aborted`; otherwise `null`. |
| `secondary_errors` | array | Always `[]` in reports `runIngest` writes. A failure that happens alongside the main one (`stage` `report` or `lock_release`) is attached to the thrown error's `details.secondary_errors`. |
| `warnings` | array | Up to 20 warnings (below). |
| `warning_count` | number | The true number of warnings. |
| `newest_staleness_value` | any or `null` | Newest `canary.staleness_field` value in this run; `null` when staleness is not configured or no value is a date. |
| `canary` | object | `{ status, breaches, skipped }` (below). |
| `fetch` | object | `{ pages, attempts, retries, statuses, status_count, bytes, complete, stop_reason }`; `statuses` keeps the first 20 HTTP statuses, `status_count` counts all. |
| `storage` | object | `{ status, written }` (below). |
| `notices` | array | Advice and deprecations (see [Reading a run report](#reading-a-run-report)). |

Allowed values:

- `outcome`: `ok`, `stale`, `error`, `aborted`.
- `failure.stage`: `validate`, `fetch`, `extract`, `store`, `canary`, `lock`,
  `lock_release`. `run --json` can also print `options` when the options were rejected
  before any report was built.
- `details.secondary_errors[].stage` (on the thrown error): `report`, `lock_release`.
- `storage.status`: `not_started` (the run stopped before the store step), `unchanged`
  (nothing new to write), `committed` (`written` records appended), `uncertain` (an append
  failed part way, so `written` is `null`: the batch may have partly landed).
- `fetch.stop_reason`: `single_page` (no pagination), `empty_page`, `short_page`,
  `max_pages`, or `null` when the fetch did not finish.
- `canary.status`: `ok`, `stale`, `not_evaluated` (the run did not get that far).
- `canary.skipped[]`: `{ check, reason }`; `check` is `min_records`,
  `required_field_ratio`, `count_drop_ratio` or `staleness`; `reason` is
  `incremental_batch`, `empty_batch`, `no_history` or `not_configured`.
- `canary.breaches[]`: strings `"<check>: <detail>"`, for example `"staleness: newest …"`.
- `errors[]`: `{ index, code, missing, invalid, source_id, source_url }`; `missing` and
  `invalid` list field names.
- `warnings[]`: `{ code, message?, line? }`, where `code` is one of:
  - `W_PAGE_LIMIT`: pagination stopped at `max_pages` while pages were still full, because
    `allow_truncation` is `true`.
  - `W_STORE_CORRUPT_LINE`: a store line is not a JSON object, so it was skipped.
  - `W_STORE_INVALID_RECORD`: a store line has no nonempty `id` or `content_hash`, so it was
    skipped.
  - `W_HISTORY_CORRUPT_LINE`: a history file line could not be read, so the canary skipped
    it.

## Gotchas

- **`undefined` must never reach the store.** A missing value is `null`, consistently. An
  `undefined` field silently rejects an entire write in some document stores.
- **This framework does not queue or retry a locked store.** Two overlapping runs against
  the same host both hitting `runIngest` at once is `E_STORE_LOCKED` for the loser, not a
  silent duplicate write. Give the *caller* (your cron/workflow) its own mutual exclusion —
  e.g. a GitHub Actions `concurrency: { group: ingest-<host>, cancel-in-progress: false }` —
  so a slow run blocks the next scheduled one instead of racing it.
- **A lock left behind by a killed process needs an explicit operator recovery step** — see
  MIGRATION-0.2.md's "Recovering from a crashed run". No automated stale-lock takeover.
  Distributed locking across machines is out of scope — one physical local store, one lock.
- **Editing an adapter's `map` changes every record's `content_hash`** (it's a hash of the
  mapped `fields`, by design). The next run after a `map` change re-appends the *entire*
  current source listing as `changed`, with no canary signal, since nothing about the
  source itself moved. Expected, not a bug, but surprising the first time.
- **Fetches have a timeout and size ceilings by default** (`fetch.timeout_ms`: 30000ms;
  `fetch.max_records`: 5000; `fetch.max_response_bytes`: 20MB; `fetch.max_total_bytes`:
  100MB across all pages). A source with a legitimately larger page size or slower response
  needs these raised explicitly — the defaults exist so an unattended cron run can't hang
  indefinitely or OOM the runner on a single misbehaving or hostile response. `html`
  and `feed` default to 5MB per response instead, because a parsed page takes many times
  its size in memory; set `fetch.max_response_bytes` to change it. A page with more rows
  (or a feed with more items) than `max_records` fails before any record is built.
- **Parsing is CPU work that `timeout_ms` does not interrupt.** The timeout covers the
  request and the body download; `max_duration_ms` is checked again once parsing returns.
  A pathological page (thousands of nested elements) can still take seconds to parse, so
  keep `max_response_bytes` small for sources you don't trust.
- **The canary's `count_drop_ratio` check needs past runs.** It compares this run with the
  median of recent runs, read from `paths.runsDir` unless `paths.historyFile` is set. A CI
  runner that starts from a fresh checkout every time has no `runs/`, so this check never
  fires and every report carries `A_CANARY_NO_HISTORY`. Set `paths.historyFile` (CLI:
  `--history`) to a file you commit next to the store (see
  [Canary history on CI](#canary-history-on-ci)). `min_records`, `required_field_ratio` and
  `staleness` need no history.
- **A UA-only bot gate shows up as a 403 with a default agent, 200 with a browser UA** —
  probe both when writing a new adapter.
- **Redirects are not followed.** A 301 or 302 fails as `E_REDIRECT`. Put the final URL in
  `access.url` (check it with `curl -sI <url>`).
- **Records that share a `source_id` within one run collapse to one** (the last one wins). A
  page that lists the same link twice, such as a menu plus the body, reports more `fetched`
  than `fresh` + `changed` + `unchanged`.
- **A CSV column whose header contains a `.` cannot be mapped.** Paths split on `.`, so
  `v1.0` reads key `v1`, then `0`. The column is still kept in `raw`.
- **A CSV with no id column needs a composite id.** Pick columns that are unique together
  (`{entity}:{year}`), or rows collapse as described above.
- **A feed item with no `guid` has a `null` id.** Map `source_id` from `url` for such feeds.
- **Feed `summary` and `content` are usually HTML.** They are kept as written; add
  `"normalize": "text"` to strip the tags.
- **Feed dates with a two-digit year or a single-letter military zone are `null`**, and the
  weekday is not checked. `xml:base` is not applied: relative links resolve against the
  feed URL.
- **A feed's own namespace prefixes are matched as written** (`dc:`, `content:`). A feed that
  binds Dublin Core to another prefix gives `null` for `dc:creator` and `dc:date`.
  Extension elements (`media:thumbnail`, `enclosure`) are not read yet.
- **No cross-source fuzzy dedupe** (within-source only, by design — see Non-goals).

## Non-goals

Not a crawler or a general-purpose scraper: one adapter reads one listing URL (plus its
pages). Not a dashboard/analytics/storage product, not a hosted service. Doesn't own what a consuming app does with ingested data. No cross-source fuzzy
dedupe (within-source only, v1). No unattended LLM regeneration — a stale canary alerts; a
human re-runs whatever generated the adapter. No distributed/networked locking — one local
store, one physical lock file, cooperative single-machine exclusion only. No POST/GraphQL/
auth/OAuth (GET only). No headless browser: pages that only render through JavaScript are
out of scope.

## Project status and roadmap

| Question | Where to look |
|---|---|
| What shipped in each version? | [CHANGELOG.md](CHANGELOG.md) (generated by Changesets) and the [npm version history](https://www.npmjs.com/package/@shrinivas-sn/adapter-ingestion?activeTab=versions) |
| What changed between majors, and how do I upgrade? | [MIGRATION-0.2.md](MIGRATION-0.2.md) |
| Why does the engine stay generic? | [NOTES-generalization.md](NOTES-generalization.md) |

**Rule for new scope:** a new capability needs evidence from at least two real sources
before it is planned. That keeps the engine generic instead of shaped around one site.

## Contributing

Issues and pull requests are welcome. Work happens on feature branches and lands on `main`
by pull request. A change that affects the published package needs a changeset
(`npx changeset`), and `npm test` must pass on the CI matrix. Please open an issue first for
new adapter capabilities, so the two-source evidence rule above can be checked.

---

## Developing this repo

The sections below are about *this* repository's own worked examples, dev tooling, and
release process — none of it is required to use the published package.

This repo carries worked-example adapters, each with recorded fixtures (`adapters/`,
`fixtures/`, `filters/`). There are 13: 3 JSON APIs, 7 HTML pages, 1 CSV
file and 2 feeds (RSS and Atom), plus a template `example.adapter.json`.
They are **not** part of the npm package — `npm pack`'s file allowlist (`package.json`'s
`"files"`) ships only the engine, its types and schema, and the docs listed under
[Install](#install); verified by `scripts/verify-package.mjs` (packs the real tarball,
installs it into a disposable consumer, runs a consumer script that imports only the
installed package, type-checks a TypeScript consumer, and runs the installed bin). The
published command is `adapter-ingestion` (see [Command line](#command-line)). The older
entry point `node src/run.mjs <adapter.json> [--since DATE]` still works —
running `node src/run.mjs adapters/<HOST>.adapter.json` writes `runs/<HOST>/report-*.json`
and exits non-zero on a stale canary or failure (exit codes: `0` ok, `1` stale/operational
error/aborted, `2` usage/configuration).

### Adding a source (to this repo)

1. Run the `generate-adapter` skill (an internal Claude Code skill in this maintainer's own
   `~/.claude/skills/` — not needed to use the published package) against the target site.
   It writes `adapters/<HOST>.adapter.json` and `fixtures/<HOST>/sample-*.json`, refusing to
   emit if fixture verification falls below an 0.8 parse ratio. Writing the adapter JSON by
   hand against the "Writing an adapter by hand" section above works identically.
2. `node src/run.mjs adapters/<HOST>.adapter.json` to run it against the live source.

### Verifying a new or changed adapter manually

`scripts/verify-*-adapter.mjs` and
`scripts/run-earthquake-offline.mjs` are reusable patterns (not project-specific despite the
names) for checking an adapter against
its fixtures and running the full pipeline offline before ever hitting the network.
`scripts/run-earthquake-broken.mjs` is the canary regression check — copy this pattern
whenever adding a new source, pointed at the new adapter/fixture.

### Known gap: unstructured text extraction

`extract.mjs`/`normalize.mjs` today only understand **structural** field access — a path
into JSON through a typed normalizer. Some sources bury the fields that matter (an
organization name, a deadline date) inside unstructured prose in one HTML blob, findable
only by a labeled-text pattern. There's no declarative primitive for that today — see
`NOTES-generalization.md` for the fuller writeup and what adding one would look like.

### Publishing

Versioned with [Changesets](https://github.com/changesets/changesets), published via
GitHub Actions using npm's OIDC **trusted publishing** — no long-lived `NPM_TOKEN` secret.

**Normal flow:** merge a PR with a changeset (`.changeset/*.md`) into `main`. The
`release.yml` workflow (gated on the same CI matrix `ci.yml` runs for every PR — a red
matrix cell blocks release the same as a red Ubuntu unit-test run) opens a "Version
Packages" PR. Merging *that* PR re-runs `release.yml`, which now sees no pending changeset
and publishes via `changeset publish`.

**First-publish bootstrap (already done, 06/09/2026 — kept here for the next package that
needs it):** unlike PyPI, npm requires a package to already exist before a Trusted
Publisher can be linked to it — there is no way to pre-register OIDC trust for a brand-new
name. So the very first version has to go up the old way:

1. `npm login` (interactive, needs 2FA) — one time, locally.
2. `npm publish` from a clean checkout — creates the package on the registry.
3. npmjs.com → the package → Settings → Trusted Publishing → add a GitHub Actions
   publisher: org/user, repo, and the exact workflow **filename** (`release.yml`).
4. From then on, `release.yml`'s own `id-token: write` permission lets it publish without
   ever touching an npm token.

**Known issue, not a misconfiguration:** the automated OIDC publish can fail with
`E404: Not Found - PUT https://registry.npmjs.org/@scope%2fname` on a scoped package, even
with Trusted Publishing correctly configured and the OIDC token itself accepted (provenance
signs successfully; the failure is on the actual `PUT`). This matches other users' reports
against the same `changesets/action`/npm CLI combination — see
[npm/cli#8976](https://github.com/npm/cli/issues/8976) (and the issues it links, #8730,
#8678) — not anything specific to this repo's config; a diff against `verify-claims`'
working `release.yml` (which hits the same registry the same way) turned up no material
difference. **Workaround when it happens:** `npm login` (if the local session lapsed) then
`npm publish` from a checkout of the version `release.yml` failed to publish — same
mechanism as the bootstrap above, just for a version after the first. Automation resumes on
its own for the *next* release; nothing needs to be reverted or reconfigured.
