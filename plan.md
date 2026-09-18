# Adapter Ingestion 0.2.0 Reliability Implementation Plan

> **For Claude Sonnet 5:** Use `superpowers:executing-plans` and execute sequentially, one task at a time. Read `STATUS.md` first. Follow the checkboxes and acceptance scenarios. Do not delegate unless the user authorizes it. This document does not start implementation: the current session requested planning only.

**Goal:** Release a dependable, bounded JSON ingestion package with enforced record identity, safe local-store coordination, truthful persisted reports, tested recovery, and verified npm publishing.

**Architecture:** Retain the ESM fetch → extract → dedupe → append-only JSONL pipeline and read-time filters. Add small internal modules only for shared configuration, errors, HTTP transport, and local-store locking. Keep public exports and successful result shapes, with additive diagnostics and the explicitly documented stricter behavior below.

**Tech stack:** JavaScript `.mjs`, Node built-ins, native Fetch/Response, `node:test`, npm, Changesets. Zero runtime dependencies. Installed Changesets CLI at planning time: `3.0.2`.

**Spec:** Sections 1–8 are the release specification; section 9 is the execution plan. `STATUS.md` is the resume pointer. Original draft: Git object `fd1fba1:plan.md`.

**Date:** 2026-09-18. **Implementation:** NOT STARTED. **Target:** `0.2.0`, subject to registry reconciliation in Task 0. A completed plan is not production-readiness evidence.

## 1. Authority, scope, and execution constraints

### 1.1 Authority

1. Current user instructions and workspace safety rules govern execution.
2. This document defines this release's behavior. Do not silently change it.
3. Existing source/tests define compatibility except for the intentional changes listed here.
4. Section 12 primary references establish external API truth.
5. `E:/dev-recipes/generated-adapter-ingestion/README.md` is historical background. It differs from this package, including URL templates. Do not copy its templates wholesale or silently treat them as package requirements.

If requirements conflict or a necessary behavior is unspecified, record the exact narrow conflict in STATUS.md and request a decision. Routine implementation details preserving this specification need no approval. Do not invent a third behavior to bypass a conflict.

### 1.2 Included

- JSON over HTTP(S), GET, fixed dot-path extraction, existing four normalizers.
- Single-response and numbered page-parameter pagination.
- Caller-supplied `since`; stable source identity and canonical field hashing.
- Local JSONL storage, replay, latest views, cooperative single-machine exclusion.
- Bounded fetches, limited retries, cancellation, pacing, useful errors.
- Snapshot/incremental-aware canaries and final persisted reports.
- Validated filters, migration notes, installed-package proof, CI/release checks.

### 1.3 Excluded

No XML/RSS/HTML/browser/CSV parsers, GraphQL/POST bodies, OAuth, proxy rotation, arbitrary regex or expression extraction, URL templates, plugin frameworks, queues, databases, distributed locks, automatic checkpoints, compaction, retention deletion, fuzzy matching, automatic LLM regeneration, dashboards, or billing. No TypeScript migration, build pipeline, schema framework, logging dependency, or new CLI binary. Keep the existing source-module CLI. These are separate future decisions, not unfinished tasks in this release.

### 1.4 Working rules

- This planning session changes only plan.md and root STATUS.md.
- Before writes, verify `(Get-Acl -LiteralPath 'E:\adapter-ingestion').Owner` equals `SSN-INSPIRON-35\Dell`. Do not change ACLs, replace `.git`, or create a new top-level workspace in the sandbox.
- Preserve user edits. Never reset/clean the checkout or overwrite real store/runs directories in tests.
- Keep ESM structure; no source-specific hostname branches in src/.
- Each scenario: failing test → observed failure → minimal fix → focused pass → full suite → evidence update.
- Mocks do not prove actual HTTP cancellation, byte enforcement, filesystem races, or publishing.
- No blanket catch-and-ignore. Distinguish bad records, bad configuration, and operational failures.
- Execute inline and sequentially. Commit/push/merge/publish only when authorized in the executing session. This plan is not publication authorization.
- Runtime floor: Node 22.15.0. Support Linux and Windows local filesystems. Shared/network filesystems and multiple hosts sharing one store are outside scope.
- No unrelated refactors, speculative settings, live-source calls from automated tests, or mass dependency updates.

## 2. Verified baseline

Commit: `fd1fba1`. package.json is `0.1.0`; package-lock.json root metadata is `0.0.0`. Current engine is `>=20`; CI covers Ubuntu/Node 24 only. Working tree was clean before planning.

On 2026-09-18, Windows/Node v22.15.0 passed 66/66 existing tests. Extraction passed 5/5 USGS and 6/6 Karnataka Careers fixture records. Historical fixtures prove extraction, not present-day freshness. Current live-source health and npm publication were not verified; the registry lookup through the available web tool failed.

| ID | Observed evidence | Disposition |
| --- | --- | --- |
| B01 | max_pages 3 without per_page makes only one request. | Correct termination/completeness. |
| B02 | Two missing IDs become example.test:null and collapse into one record. | Unconditional identity/URL invariants. |
| B03 | Native 1,023-byte Response passes a 10-byte cap without Content-Length. | Count actual consumed bytes. |
| B04 | Numeric entity &#1114112; throws RangeError. | Invalid entities cannot abort ingestion. |
| B05 | 2026-02-31 is returned as valid. | Calendar validation. |
| B06 | Unknown pagination style, negative page count, ratio 4 pass validation. | Strict execution config checks. |
| B07 | Filter mode 'al' silently behaves as OR. | Validate even with zero input records. |
| B08 | Feed/html/browser validate but fetch parses JSON only. | Reject unsupported kinds. |
| B09 | Latest/index reads first materialize all store history. | Streaming reducers and measured limits. |
| B10 | Index-read/dedupe/append lack mutual exclusion. | Whole-run cooperative local lock. |
| B11 | Saved report precedes canary and omits its result. | Persist final canary/outcome. |
| B12 | Validation is outside reporting; report errors can replace primary errors. | Explicit lifecycle/error precedence. |
| B13 | Canary history includes failed runs; freshness ignores injected now. | Comparable good history and one logical clock. |
| B14 | Fetch errors embed full URLs. | Safe bounded diagnostic projection. |
| B15 | Lockfile root version differs from manifest. | Reconcile before release. |

B01–B07 were reproduced during planning. B08–B15 were confirmed by code-path inspection; race/crash/memory behavior still requires the integration evidence below.

Correct old-draft inaccuracies: offset ISO strings already produce a date; colon keys already work; method was configurable but body was not; OOM thresholds were not measured. Remove speculative market-share claims. Readiness claims apply only to the supported scope.

## 3. Public interfaces, data contract, and configuration

### 3.1 Existing interfaces retained

Keep every current package export. Keep existing keys/results for validateAdapter, verifyAgainstFixtures, buildUrl, extractAll, applyNormalizer, splitByIndex, readRecords, readLatestRecords, readIndex, appendRecords, applyFilter, buildReport, writeReport, readHistory, and runIngest. Dedupe remains last occurrence wins. Add optional parameters/diagnostics as follows:

```js
// Existing /store subpath
iterateRecords(filePath, { maxLineBytes = 64_000_000, onWarning } = {})
// AsyncIterable<Record>
readRecords(filePath, options = {}) // collects iterator
readLatestRecords(filePath, options = {}) // reduces directly
readIndex(filePath, options = {}) // reduces directly
appendRecords(filePath, records, { maxLineBytes = 64_000_000 } = {})
withStoreLock(filePath, { runId }, async canonicalStoreFile => result)

// Existing /filter subpath
validateFilter(filterDef) // { ok: boolean, errors: string[] }

// Existing /fetch subpath
fetchAll(adapter, { since, fetchImpl = fetch, signal } = {})
// { items, pages, statuses, diagnostics }

// Existing /canary subpath
checkCanary(report, history, cfg, { now = new Date() } = {})

// Existing root subpath
runIngest({ adapter, paths, since, fetchImpl, signal, now = new Date(),
  store = { max_line_bytes: 64_000_000 } })
// resolves { report, canary } on completed run, including stale canary
// rejects on config/transport/storage/lock/cancellation/reporting failures
```

fetchImpl must return a standard Response with a readable body. Convert existing json()-only test doubles/scripts to `new Response(JSON.stringify(data))`. No unbounded compatibility fallback. New internal modules do not become new package subpaths.

### 3.2 Intentional compatibility changes

Migration documentation must cover Node floor 22.15.0; unsupported kinds/non-GET rejection; strict config/filter checks; unconditional identity/URL checks; impossible dates becoming null; missing records_path becoming a shape error; capped pagination requiring explicit allow_truncation; overlapping runs failing E_STORE_LOCKED; native Response requirements for injected fetch; report v2 fields; extraction samples capped at 20 with separate errorCount/fieldFailures; JSON nesting bound 100; and corrupt-line warnings.

Preserve valid record IDs, field names/types, hash algorithm/order, latest-record semantics, and existing valid filter behavior. Do not rewrite old stores or recompute historical hashes. Corrected normalization can create one legitimate changed revision; document it. URL-template support is deferred, and package docs must stop implying the external recipe is the exact implemented schema.

### 3.3 Record invariants

- source_id is a non-whitespace string or finite number. Zero is valid. Null/undefined/boolean/object/array/Infinity/NaN are invalid. Preserve valid values; no trimming or random/index/title-hash fallbacks.
- source_url is a nonempty absolute HTTP(S) URL with no username/password. Preserve a valid string. Cross-host deep links are allowed.
- id is exactly `${host}:${sourceId}`; record identity never uses run UUIDs.
- fields contains JSON-safe values only. Optional missing values become null. Reject undefined, non-finite numbers, functions, symbols, BigInt, cycles, and non-plain objects supplied through direct JS APIs. Do not mutate caller data.
- raw preserves the source JSON object; direct buildRecord callers may use null. Extraction accepts plain objects only.
- fetched_at is a valid ISO timestamp. Existing canonical JSON/hash output for valid fields stays identical.
- Required fields reject null/empty/whitespace-only strings; zero/false remain valid. Identity and URL are always required independently of adapter.required.
- Invalid source records produce one rejection diagnostic each. Invalid adapter/unknown normalizer fails configuration, not each record.

### 3.4 Adapter validation and defaults

Use small explicit validators. validateAdapter returns `{ok, errors}` for malformed JSON-compatible input and must not throw incidental TypeErrors. Validate containers before iteration. Share fetch-relevant rules with public fetchAll, which may be called without a map. Keep useful existing error message fragments where tests depend on them.

Top-level metadata is allowed without interpretation. Reject unknown keys inside access/fetch/pagination/incremental/retry/map-rule/canary; typos in execution settings must not disappear.

| Setting | Rule/default |
| --- | --- |
| version | Exactly 1. |
| host | Existing bare hostname; max length 253; reject Windows reserved device basenames CON/NUL/AUX/PRN/COM1–9/LPT1–9, also when followed by a dot. |
| access | tier integer 0–5; kind json-api; absolute HTTP(S) URL without credentials; existing host/subdomain provenance check. |
| fetch.method | Omitted or exactly GET. |
| fetch.headers | Plain string map accepted by native Headers validation. |
| records_path | Omitted → $; otherwise $ or nonempty dot segments. Numeric indices/colon keys supported. |
| map | Nonempty plain object including source_id/url; rules contain path plus optional known normalize. No other transforms. |
| required | Optional unique string array naming mapped fields. |
| timeout_ms | Integer 1–2,147,483,647; default 30,000 per attempt including body consumption. |
| max_duration_ms | Same integer range; default 120,000 for entire fetch phase including waits/retries/pages. Not a filesystem timeout. |
| max_records | Positive safe integer, default 5,000. |
| max_response_bytes | Positive safe integer, default 20,000,000 consumed/decompressed bytes per attempt. |
| max_total_bytes | Positive safe integer, default 100,000,000 across attempts/pages. |
| delay_ms | Integer 0–2,147,483,647, default 0 between successful pages. |
| pagination | Optional; style page-param, nonempty param, max_pages positive safe integer default 1. |
| per_page | Optional positive safe integer; no Infinity termination default. |
| per_page_param | Optional nonempty string; requires per_page and differs from page param. |
| allow_truncation | Boolean default false; applies only to max_pages, never other limits. |
| incremental | Optional; nonempty param, type iso-date; no collision with page/per_page params. |
| since | Optional valid nonempty YYYY-MM-DD; requires incremental config. |
| retry | Optional: max_attempts integer 1–5 default 3; backoff_ms integer 0–60,000 default 500; max_delay_ms integer 0–60,000 default 10,000 and >= backoff_ms. |
| canary.min_records | Nonnegative safe integer, default 1. |
| canary.median_window | Integer 1–100, default 5. |
| canary.count_drop_ratio / required_field_ratio | Finite number 0–1, defaults 0.4 / 0.9. |
| max_staleness_days / staleness_field | Paired; finite days >0, existing map key. Values: date-only, explicit-zone ISO timestamp, or epoch milliseconds; no seconds guessing. |

Fetch settings in the table live under fetch; per_page/per_page_param/allow_truncation live under fetch.pagination. No configurable retry status list. Reject output map names/path segments __proto__, constructor, prototype. getPath traverses own properties only; missing/non-object intermediates return undefined. No expressions/wildcards/empty path segments.

### 3.5 Filter validation

Optional version must be 1. Omitted mode means all; otherwise exactly all/any. rules is an array. Empty all keeps everything; empty any keeps nothing. Validate before iterating even [] input. Direct evaluateRule validates its rule too.

Field uses the same own-property path syntax. Current operators only. any_of/none_of values: arrays of JSON primitives; includes_any/excludes_any: arrays of strings; numeric operands finite; between min <= max; within_days nonnegative integer; after_date valid YYYY-MM-DD; exists boolean. Reject unknown rule keys; permit harmless top-level metadata. Do not change missing-field/array-intersection semantics.

## 4. Transport, pagination, normalization, and diagnostics

### 4.1 Transport

Validate fetch settings/since/signal before requests. Use native fetch with `redirect: 'error'`; redirected sources must configure their final URL. Classify native redirect rejection as E_REDIRECT when its cause identifies a redirect; otherwise use safe E_FETCH without guessing from arbitrary error text. No redirect framework. Injected fetch must honor Fetch options.

Read body chunks and count bytes before buffering beyond caps. Content-Length is only an early rejection hint. Count decompressed bytes exposed by Fetch. Dispose/cancel readers on success/error/abort/retry. Decode UTF-8, parse once, and reject malformed/empty JSON or missing/non-array records_path. An explicit [] is a valid fetch result for canary evaluation.

Check max_records before retaining a batch; do not spread arbitrarily large arrays as function arguments. Total memory remains proportional to configured body/record bounds, not constant. No store append until all requested pages succeed. A later-page failure rejects with progress diagnostics, never partial items disguised as success.

Caller abort stops requests/waits. Check it before store append. Once append begins, finish or report its I/O failure rather than intentionally cutting a write short; a cancellation observed afterward still ends as aborted with actual storage status. Do not promise interruptible arbitrary OS filesystem calls.

Timers cannot preempt synchronous JavaScript parsing. Check deadline/abort before and after decode/parse and before returning; the byte ceilings bound synchronous work. Document these as cooperative fetch deadlines, not a hard CPU-time guarantee.

### 4.2 Retries and pacing

Retry GET connection failures, per-attempt timeouts, HTTP 408/429/500/502/503/504 only. Never retry caller abort, total deadline, redirects, malformed JSON, shape/config errors, size/record limits, 401/403/404, or other HTTP failures. max_attempts includes the first attempt.

For retry n starting at 1, local ceiling is `min(max_delay_ms, backoff_ms * 2 ** (n - 1))`; choose full jitter in [0, ceiling]. Parse Retry-After as integer seconds or HTTP date; past date → 0, invalid header → local backoff. Wait max(jitter, retryAfterMs). If Retry-After exceeds max_delay_ms or the remaining fetch budget, fail E_RETRY_DEFERRED with retry_after_ms; never retry earlier than requested. If the selected wait exhausts the remaining budget, stop instead of issuing another attempt.

Abortable waits; pure delay helper takes injected numeric nowMs/random for unit tests only. Do not expose a fake clock or randomness in adapter JSON. Use actual timers/native Fetch in integration tests with small configured limits. delay_ms is the minimum pause after a successful page before the next page; there is no concurrent fetching.

### 4.3 Termination and completeness

- No pagination: one response, complete true, stop_reason single_page.
- Empty array: complete true, stop_reason empty_page.
- Declared per_page and shorter batch: complete true, stop_reason short_page.
- No per_page: continue until [] or cap; never infer a short page.
- Cap reached on a nonterminal page: complete false, stop_reason max_pages. Default E_PAGE_LIMIT, no storage. Explicit allow_truncation true returns a deliberate bounded window plus warning. That run may be ok, but saved complete:false must remain visible.
- Exact repeat of a prior nonempty batch: E_PAGINATION_REPEAT even with allow_truncation. Compare a digest of JSON.stringify(batch) in response order, not extracted IDs. This is exact repetition detection, not universal pagination correctness.
- Overlapping IDs in differing batches are valid; last occurrence wins during dedupe.
- Never interpret HTTP 400/404 as normal end-of-list. A source with such behavior needs an explicitly verified bounded window or a separate future pagination feature.

### 4.4 Normalizers

Text retains tag stripping, named-entity subset, and whitespace rules. Decode valid numeric Unicode scalars; zero, surrogates, values >0x10FFFF, or overflow become U+FFFD. No recursive decoding. This is not an HTML sanitizer; output must be escaped by consuming UIs.

Number retains current separator/currency/unit parsing, returning null for non-finite results. No locale framework. Bool keeps current behavior.

iso-date keeps YYYY-MM-DD, syntactically valid ISO timestamp suffixes, English DD-Mon-YYYY (short/full month), and day-first DD/MM/YYYY or DD-MM-YYYY. Validate real dates and leap years. A valid offset timestamp retains the written date, not the UTC-shifted date. Reject trailing garbage and impossible time components. Do not use unrestricted Date parsing. RFC dates and epoch-seconds normalization are deferred.

Accepted grammar after outer whitespace trimming: year exactly four digits 0001–9999; ISO date uses two-digit month/day; optional suffix is `T` + HH:mm, optional :ss with optional 1–9 fractional digits only after seconds, followed by optional Z or ±HH:mm. Hours 00–23, minutes/seconds 00–59, offsets hours 00–23/minutes 00–59. Zone-less timestamps retain legacy support. English day-month-year permits matching separators dash, slash, or whitespace with a recognized complete English short/full month name; numeric day-first dates require matching dash or slash separators. No leap seconds, 24:00, two-digit years, localized names, or partial strings. Reuse calendar-component validation without routing epoch values through this normalizer.

### 4.5 Trust, errors, and safe output

Adapters, local paths, and injected fetch functions are trusted caller configuration; upstream content is not. This package is not an SSRF sandbox. Trusted localhost/private endpoints remain supported. Do not add a speculative IP allowlist or claim hostname validation prevents SSRF.

Internal `IngestionError` shape: `{ name: 'IngestionError', code, message, cause?, details? }`. Keep original causes in memory only. Serialized diagnostics/CLI include safe code/message/stage and bounded counts/identifiers, never headers, response bodies, adapters, full request URLs, credentials, query values, fragments, or arbitrary error.message copied from a fetch implementation. Request context uses origin plus page/attempt, omitting path because path segments may contain secrets.

Extraction entries retain index/missing and add code, invalid (field names), source_id (scalar string <=200 chars or null), and source_url (valid URL stripped of credentials/query/fragment, <=500 chars or null). No raw snippets. Reports can still contain business identifiers: document access-control responsibility.

Use these codes consistently: E_OPTIONS, E_ADAPTER_INVALID, E_FILTER_INVALID, E_RECORD_INVALID, E_FETCH, E_HTTP_STATUS, E_REDIRECT, E_TIMEOUT, E_FETCH_DEADLINE, E_ABORTED, E_RESPONSE_LIMIT, E_TOTAL_BYTES_LIMIT, E_RECORD_LIMIT, E_RESPONSE_JSON, E_RESPONSE_SHAPE, E_PAGE_LIMIT, E_PAGINATION_REPEAT, E_RETRY_DEFERRED, E_STORE_READ, E_STORE_WRITE, E_STORE_LINE_LIMIT, E_STORE_LOCKED, E_LOCK_RELEASE, E_REPORT_READ, E_REPORT_WRITE. Add a code only with a named requirement/test; no general error taxonomy framework.

## 5. Storage, locking, and recovery

### 5.1 Bounded readers and append

iterateRecords splits byte chunks at LF, tolerates CRLF, preserves split UTF-8, and accepts a complete final line without LF. Enforce maxLineBytes before collecting an oversized line; unbounded readline buffering is insufficient. Missing/empty file yields no rows; only ENOENT means missing. Other filesystem errors fail.

Skip malformed JSON/primitives/arrays/null with `onWarning({code:'W_STORE_CORRUPT_LINE',line})`. Skip objects without nonempty string id/content_hash with W_STORE_INVALID_RECORD. Accept opaque existing string hashes; do not retroactively demand SHA-256 length from low-level store users. Warn with line/code only. Oversized lines fail E_STORE_LINE_LIMIT rather than being skipped.

readRecords collects the iterator, O(all returned records). readLatestRecords directly reduces to latest per ID, O(unique records). readIndex directly reduces to ID/hash, O(unique IDs). Neither reducer materializes historical arrays. Index growth remains a limit; no compaction/index database in this release.

appendRecords preflights serialization, id/hash shape, and per-line size for the entire batch before mutation. Serialize one record at a time during preflight/write rather than joining a second whole batch. Insert a newline before appending if a prior non-newline tail exists; never truncate/delete history. Await writes, sync the file before success, close in finally. A disk failure may leave a valid prefix and partial last line; this is not an atomic transaction.

### 5.2 Whole-run ownership

withStoreLock creates `<canonicalStoreFile>.lock` exclusively with open(...,'wx'). Create/realpath parent, reject a symlink store file. Same canonical local path must be used by all writers. Hard-link aliases, network filesystems, multi-host storage, and noncooperating writers are unsupported.

Metadata: `{version:1,run_id,pid,hostname,started_at}`. Existing lock means immediate E_STORE_LOCKED. No polling/stealing/PID probing/age-based unlock. On metadata initialization failure, close/remove only the lock just created by this invocation. A contender never removes another lock.

Hold the lock from before fetch through read-index/dedupe/append, history/canary, and final report publication. This prevents an older slow fetch writing after a newer run. Release owned lock in finally and verify run_id before unlinking. Preserve primary error if cleanup also fails; attach safe secondary E_LOCK_RELEASE. If cleanup alone fails, reject E_LOCK_RELEASE and attempt to update this run's report to error; further report failure stays secondary.

Low-level read/append functions do not acquire locks implicitly. Their concurrent users explicitly wrap work in exported withStoreLock. runIngest always does. No reentrant lock or distributed exactly-once guarantee.

### 5.3 Recovery

- Crashes can leave locks. Operator confirms all writers stopped, inspects metadata/preserves store, explicitly removes that one lock, then replays. No automatic unlock command.
- Fetch failure writes no records. Append failure can write a prefix; replay dedupes against valid actual lines.
- Successful append plus failed report rejects E_REPORT_WRITE with storage.status committed in attached in-memory report. Replaying unchanged data adds zero duplicates.
- A killed process cannot promise a final report. Report failure is visible through stderr/API. sync is not a promise against every hardware/power failure.
- Corrupt history stays preserved and warnings stay visible. No inferred deletions/tombstones when upstream records disappear.

## 6. Run lifecycle, reports, and canaries

### 6.1 Additive report schema

```js
{
  report_version: 2, run_id, adapter_fingerprint, mode: 'snapshot',
  outcome: 'ok', // stale | error | aborted
  host, started_at, finished_at, duration_ms,
  stages: { fetched, parsed, fresh, changed, unchanged, written },
  error_count, errors, fatal_error: null,
  failure: null, // or {code,message,stage}
  secondary_errors: [], warnings: [], warning_count: 0,
  newest_staleness_value: null,
  canary: { status: 'ok', breaches: [], skipped: [] },
  fetch: { pages: 0, attempts: 0, retries: 0, statuses: [],
    status_count: 0, bytes: 0, complete: false, stop_reason: null },
  storage: { status: 'not_started', written: 0 }
}
```

run_id is a UUID for an invocation, never a record ID. mode is incremental only when since is supplied. Fatal runs use canary.status not_evaluated. storage.status is not_started/unchanged/committed/uncertain; written is null on uncertain append failure. stages.written follows the same rule.

Bound diagnostic sample arrays to 20 during collection, not only serialization. errors count rejected records independently of samples; warnings/statuses have total counts. Bound safe strings to 1,000 chars except shorter extraction limits. fetchAll retains its legacy statuses list of one terminal status per completed page for compatibility; report diagnostics are capped separately. max_pages/total deadline bound fetchAll's work; do not use it as an unlimited log.

fetchAll.diagnostics uses the report.fetch fields plus warnings/warning_count. runIngest copies fetch metrics into report.fetch and merges warning samples/totals into the report's top-level warning collector. HTTP status samples describe all attempts; pages counts successfully decoded/accepted pages. A deliberately truncated window emits W_PAGE_LIMIT. Extraction errorCount feeds report.error_count even when only 20 errors are returned. Record rejection fieldFailures increments each distinct missing/invalid field once per record.

fetched counts decoded accepted page records, including progress before later-page failure. parsed is valid extracted count before duplicate collapse. fresh/changed/unchanged are classification counts, not write claims. written reports confirmed writes, or null when unknown.

Fingerprint: SHA-256 of canonical `{version,host,access,fetch:fetch??{},records_path:records_path??'$',map,required:required??[],canary:canary??{}}`. Exclude metadata/since/clock. Do not persist fingerprint input/header values. Explicit defaults versus omitted defaults can conservatively reset history; document this.

### 6.2 Lifecycle and error precedence

1. Validate storeFile/runsDir as nonempty strings; invalid paths reject E_OPTIONS with in-memory diagnostic because no reliable report location exists. Validate now and signal types.
2. Allocate run ID, logical start, monotonic elapsed clock, counters, and safe collectors. Use now for fetched_at/freshness; finished_at is logical start plus elapsed duration.
3. Validate adapter/since/options within the reportable lifecycle. If runsDir is usable, persist a validation error report; use null host/fingerprint if invalid.
4. Acquire store lock. Inside it fetch → extract → read index → classify → append → read eligible history → canary → publish final report. Lock-acquisition failure gets a separate unique error report without store mutation.
5. Valid records still store when canary is stale, preserving current behavior. Rejected records remain observable through counts/ratio; no new quarantine store.
6. Fatal error yields error/aborted outcome and not_evaluated canary, preserves progress, attaches report to the thrown error. Report errors cannot replace the original error; record secondary E_REPORT_WRITE. If reporting alone fails, it is primary.
7. Release owned resources. Library never exits the process. CLI sets exitCode after cleanup: 0 ok; 1 stale/operational/aborted; 2 usage/configuration.

Filename: `report-<safe-started-at>-<run_id>.json`. Publish via exclusive unique temporary sibling, sync/close, then rename. Same timestamp must not overwrite another invocation. Ignore temporary files during reads. Legacy filenames remain readable. Validate report object/date/stages shape; malformed content may be skipped, but EACCES/EIO must fail instead of impersonating empty history.

Read past history before publishing current report; remove write-then-slice(1). Order by parsed started_at with filename tie-breaker. Public readHistory(dir,limit) keeps newest-valid-report semantics. Add an internal history iterator to scan until enough eligible reports exist; do not limit filenames before eligibility or load all report bodies. Directory-name enumeration may remain O(report count); retention is excluded and documented.

### 6.3 Canary semantics

- Snapshot: existing min_records, parse ratio, median drop, configured freshness checks.
- Incremental: evaluate ratio only if fetched >0; skip minimum/count-drop/freshness with reason incremental_batch. An empty delta is not stale proof. This also does not certify source freshness; advise periodic snapshots.
- Median candidates: report v2, outcome ok, matching host/fingerprint, snapshot mode, no fatal error, earlier started_at. Exclude stale/error/legacy/incremental/future/current reports. Do not train baseline downward with repeated failures.
- No eligible history: skip median only; other snapshot checks apply. Disclose absent baseline.
- Standalone checkCanary retains support for simple existing test reports: missing mode means snapshot; runIngest supplies eligible history. Helper still excludes explicitly failed/stale reports when their metadata is present.
- Freshness uses passed now, never hidden Date.now. Accept strict date-only, explicit-zone ISO, finite epoch milliseconds. Invalid values breach; no locale parsing/seconds inference.

canary.skipped is an array of `{check,reason}` objects. Checks use min_records, required_field_ratio, count_drop_ratio, staleness. Reasons are incremental_batch, no_history, not_configured, empty_batch, or run_failed. For example an empty incremental run skips ratio with empty_batch and the other three with incremental_batch. Snapshot [] still evaluates min_records; missing optional freshness config is not_configured. breaches remains an array of human-readable strings for compatibility.

## 7. File responsibility map

| File | Responsibility |
| --- | --- |
| src/config.mjs (new internal) | Shared config defaults and adapter/fetch validation. |
| src/errors.mjs (new internal) | Structured errors, safe projection, bounded collectors. |
| src/http.mjs (new internal) | Bounded body reading, retry-delay math, abortable waits/attempt cleanup. |
| src/lock.mjs (new internal) | Owned local exclusive lock, re-export via store. |
| src/adapter.mjs | Public validation wrapper and fixture verification. |
| src/contract.mjs | Identity/JSON invariants; unchanged valid hashing. |
| src/extract.mjs | Own-property paths, per-record errors. |
| src/normalize.mjs | Four existing normalizers with correctness fixes. |
| src/fetch.mjs | Page/retry orchestration and completeness. |
| src/store.mjs | Bounded iterator/reducers/preflighted append. |
| src/report.mjs | Final schema/publication/history. |
| src/canary.mjs | Pure quality decisions with supplied time. |
| src/run.mjs | Lifecycle and existing CLI. |
| src/filter.mjs | Validation and unchanged matching semantics. |
| src/dedupe.mjs | Preserve last-occurrence-wins; no speculative change. |
| test/helpers/fixtures.mjs (new) | Base adapter/native Response/temp cleanup helpers. |
| test/helpers/http-server.mjs (new) | Loopback HTTP server, ephemeral port, deterministic routes. |
| test/helpers/store-worker.mjs (new) | IPC-controlled child process for lock/crash tests. |
| test/lock.test.mjs, test/integration.test.mjs (new) | Ownership and real network/filesystem/process tests. |
| scripts/verify-package.mjs (new) | Pack/install/import/consumer verification in disposable directory. |
| scripts/verify-store-scale.mjs (new) | Constrained-heap store proof, synthetic data only. |
| TEST-MATRIX.md, VERIFICATION.md (execution) | Scenario status and command/evidence log. |
| MIGRATION-0.2.md (execution) | API/runtime/recovery/upgrade guidance; include in npm files. |

No other new production module without a requirement mapping. Do not export internal helpers via package.json. Do not introduce a DOCS migration or site-build machinery. Test helpers must not auto-run as standalone tests or spawn children on import.

## 8. Scenario matrix and proof standards

Task 0 creates TEST-MATRIX.md with ID, origin=project, task, scenario, must_prove, named test/script, command, status (unproven/pass/fail/blocked), limitation. All new scenarios start unproven. The shared capability registry has no exact standalone ingestion capability: apply its isolation/concurrency/evidence principles using these project scenarios; do not invent a website capability.

| ID | Task | Must prove |
| --- | --- | --- |
| V01 | 1 | Malformed input returns validation errors without incidental throws or fetching. |
| V02 | 1 | Invalid limits/styles/kinds/methods/headers/ratios rejected; real adapters validate. |
| V03 | 1 | ID/URL unconditional; zero ID and false ordinary fields survive. |
| V04 | 1 | No inherited traversal/prototype mutation; numeric/colon paths work. |
| N01 | 2 | Numeric entity correctness; huge/invalid/surrogate/zero references cannot throw. |
| N02 | 2 | Leap/date/time checks and written-date timezone behavior; finite number compatibility. |
| X01 | 2 | Mixed records retain valid rows with bounded actionable rejection samples. |
| F01 | 3 | Invalid filter rejected even on []; existing missing/array/empty semantics preserved. |
| H01 | 4 | Native chunked response without Content-Length is stopped by actual-byte cap. |
| H02 | 4 | Decoded compressed/total-byte/record limits enforced before excess retention. |
| H03 | 4 | Native header/body stalls terminate via timeout/deadline/abort and release resources. |
| H04 | 4 | JSON/path/redirect errors safe; supplied secret absent from reports/CLI. |
| P01 | 5 | Omitted per_page continues until []; known short-page/single-page cases correct. |
| P02 | 5 | Cap default fails with zero writes; explicit bounded window preserves complete:false. |
| P03 | 5 | Repeated page fails; normal overlapping IDs still dedupe last wins. |
| R01 | 6 | 503→200 uses two attempts; 401/403/404/invalid JSON use one. |
| R02 | 6 | Retry-After seconds/date respected; excessive delay deferred; attempts/budget bounded. |
| R03 | 6 | Abort during retry wait prevents next request; page pacing actually occurs. |
| S01 | 7 | JSONL/CRLF/split UTF-8/final-line/no-file plus latest/index semantics. |
| S02 | 7 | Bad lines warn; large line fails early; non-ENOENT failures are visible. |
| S03 | 7 | Invalid batch writes zero; prior partial tail repair preserves old/new records. |
| S04 | 7 | 256 MiB history, 100 IDs reduces under 96 MiB V8 heap; early break closes handle. |
| L01 | 8 | Actual concurrent processes: one enters, contender fails before fetch/mutation. |
| L02 | 8 | Owned cleanup on success/error; crash leaves lock; only explicit recovery permits replay. |
| O01 | 9 | Persisted and returned canary agree; terminal outcomes/counts accurate. |
| O02 | 9 | Same-now reports unique; atomic temp ignored; malformed history skipped, I/O surfaced. |
| O03 | 9 | Primary failure survives secondary report failure; committed storage remains visible. |
| C01 | 9 | Bad/legacy/incremental/different-adapter history cannot lower snapshot baseline. |
| C02 | 9 | Empty delta skips specified checks; empty snapshot stale; now deterministic. |
| E01 | 10 | Both fixtures: first/replay/edit/broken mapping/historical clock exercised end to end. |
| E02 | 10 | Page 2 failure yields zero appends and honest progress/error report. |
| E03 | 10 | Report fails after append; unchanged replay adds zero duplicates. |
| E04 | 10 | IPC-controlled child dies after known prefix/tail write; recovery preserves prefix. |
| K01 | 11 | Installed tarball imports every public subpath and runs without repo/dev files. |
| K02 | 11 | CLI codes 0/1/2 correct after flush; library import triggers no CLI. |
| K03 | 11 | Linux/Windows, floor 22.15.0 and supported 22/24 pass offline CI. |
| Q01 | 12 | Manifest/lock/changeset/changelog align; exact candidate tarball inspected/installed. |
| Q02 | 12 | Authorized actual workflow/registry/provenance/registry-install proof succeeds. |

Timing tests use observed requests and generous elapsed bounds, not exact milliseconds. Race tests use IPC barriers, not random sleeps/serial repetitions. Use actual loopback servers for byte/cancel/timeout mechanisms. Process termination is not all-power-failure proof. Keep offline fixtures, live-source results, CI, and actual publishing evidence distinct.

## 9. Sequential execution tasks

Execute 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12. A task is complete only when its named scenarios and focused/full checks pass and evidence is recorded. If a future-task scenario still fails, leave it unproven; do not weaken its assertion or implement future features opportunistically.

Each checkbox is a work unit, not permission to write the entire task before testing. For a group of cases, repeat the red/green cycle one behavior at a time. The code blocks below are representative executable regression seeds, not substitute implementations or the full required test set. Implement every scenario/table row referenced by the task.

### Task 0 — Establish the executable baseline and test ledger

**Files:** Create TEST-MATRIX.md, VERIFICATION.md, test/helpers/fixtures.mjs; modify only package.json's test script for precise discovery. Read all src/test files, package files, workflows, adapters, filters, and this plan. Update STATUS.md. No production code changes.

**Produces:** Scenario ledger; reusable test-only baseAdapter/jsonResponse/tempPaths helpers; recorded baseline and version reconciliation.

- [ ] Verify workspace owner and `git status --short`; record new user edits before proceeding.
- [ ] Run `node --version`, `npm --version`, `git rev-parse HEAD`, `npm test`; record exact command, platform, runtime, exit code, and counts. Baseline expectation here is 66 tests, but explain legitimate intervening changes rather than enforcing a magic count.
- [ ] Query `npm view @shrinivas-sn/adapter-ingestion version dist-tags --json`. A network/auth failure is unavailable evidence, not proof that 0.2.0 is unused. Continue implementation with target provisional; block publication until checked. If 0.2.0 already exists, obtain the next-version decision instead of overwriting it.
- [ ] Create all section 8 ledger rows as unproven. Record prior 66-test pass as baseline only. No scenario is passed merely by plan inspection.
- [ ] Add these helper exports. Use existing test style; do not rewrite every test for aesthetics.

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export const baseAdapter = {
  version: 1, host: 'example.test',
  access: { tier: 0, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' },
    title: { path: 'title', normalize: 'text' } },
  required: ['title'],
};
export const jsonResponse = (value, init = {}) =>
  new Response(JSON.stringify(value), { status: 200, ...init });
export async function tempPaths(t) {
  const dir = await mkdtemp(join(tmpdir(), 'adapter-ingestion-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') };
}
```

- [ ] Set the package test-script value to `node --test "test/*.test.mjs"` (encode the embedded quotes correctly in JSON). Node 22.15 supports quoted globs; Node expands this pattern consistently on Windows/Linux. This selects test files and excludes helpers/workers without adding a test runner. Confirm helpers have no import-time side effects, run npm test, and inspect discovery.
- [ ] Record baseline deviations, version lookup result, and next task in STATUS.md. Do not repair lockfile metadata yet; Task 11 owns it.

**Exit:** Clean baseline evidence and complete unproven matrix; no production behavior changed.

### Task 1 — Validate configuration and enforce record identity

**Files:** Create src/config.mjs, src/errors.mjs. Modify src/adapter.mjs, src/contract.mjs, src/extract.mjs; extend test/adapter.test.mjs, test/contract.test.mjs, test/extract.test.mjs. Add date-check helper in src/normalize.mjs only as needed for shared calendar validation; full normalizer behavior remains Task 2.

**Interfaces:** `validateAdapterConfig(adapter)` and `validateFetchConfig(adapter,{since}={})` return {ok,errors}; public validateAdapter delegates to the former. Fetch validator requires access URL/kind and fetch-related types, not a map or access tier. `IngestionError(code,message,{cause,details}={})` extends Error. `isValidDateOnly(value)` is an internal module export from normalize.mjs, not a new package subpath.

- [ ] Add malformed-input table tests: null, arrays instead of objects, string required, null rules, unknown kind/method/normalizer, zero/negative/NaN/Infinity limits, invalid ratios, path typos, invalid headers, colliding params, unsafe Windows host names. Assert validation returns errors, not incidental exceptions.
- [ ] Add unconditional record identity regression and observe it fail:

```js
test('missing identities cannot collapse unrelated records', () => {
  const { records, errors } = extractAll(
    [{ title: 'A' }, { title: 'B' }], baseAdapter,
    { fetchedAt: '2026-09-18T00:00:00.000Z' });
  assert.equal(records.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every(e => e.missing.includes('source_id')));
});
```

- [ ] Implement only section 3 validation/invariants. Validate full JSON safety iteratively with a fixed maximum nesting depth of 100 for fields/raw to prevent recursive hash traversal exhausting the call stack; deeper input is E_RECORD_INVALID. Document this bound in migration notes. Reject invalid direct buildRecord values; extraction translates record-data violations into per-record errors.
- [ ] Implement own-property paths and reserved-name rejection. Tests must include actual JSON.parse-created __proto__ keys, not object-literal syntax that changes the prototype before the test begins. Prove Object.prototype remains unchanged.
- [ ] Test ID 0, finite numeric IDs, valid cross-host URLs, blank identities, invalid URL protocols/credentials, cyclic direct-JS fields, non-finite nested values, and existing canonical hash values. Preserve a hash computed on an existing fixture record as a literal baseline assertion before editing hashing code.
- [ ] Confirm both recorded real adapters validate. Keep placeholder example.adapter.json as a template; do not count <HOST> as a valid hostname.
- [ ] Run `node --test test/adapter.test.mjs test/contract.test.mjs test/extract.test.mjs`, then `npm test`. Record V01–V04 evidence and any expected message-only assertion changes.

**Exit:** Bad configuration cannot produce runtime TypeErrors; invalid identities cannot become stored records; valid JSON hashes unchanged.

### Task 2 — Normalize bad source values and improve extraction diagnostics

**Files:** src/normalize.mjs, src/extract.mjs, src/adapter.mjs, src/errors.mjs; test/normalize.test.mjs, test/extract.test.mjs, test/adapter.test.mjs.

**Interfaces:** extractAll adds `errorCount` and `fieldFailures` while retaining records/errors. errors stores at most 20 samples; errorCount is the total rejected-record count; fieldFailures counts missing/invalid fields across all rejected records. verifyAgainstFixtures uses the full counters, never sampled errors to calculate ratios/failures. buildReport integration consumes errorCount in Task 9.

- [ ] Add/observe failing entity/date/overflow tests:

```js
test('bad numeric entities and impossible dates are safe', () => {
  assert.equal(applyNormalizer('text', 'A &#1114112; B'), 'A \uFFFD B');
  assert.equal(applyNormalizer('text', '&#xD800;'), '\uFFFD');
  assert.equal(applyNormalizer('iso-date', '2026-02-31'), null);
  assert.equal(applyNormalizer('iso-date', '2024-02-29'), '2024-02-29');
  assert.equal(applyNormalizer('iso-date', '2026-09-12T00:30:00+05:30'), '2026-09-12');
  assert.equal(applyNormalizer('number', '9'.repeat(400)), null);
});
```

- [ ] Implement section 4.4 with explicit grammar/component validation. Test month-name validation, all month lengths, non-leap century 1900 vs leap 2000, valid timestamp offsets, bad times, trailing garbage, epoch numbers remaining unsupported for iso-date, and every existing supported normalizer example.
- [ ] Add mixed-source tests: one invalid field/record cannot throw away other valid records; programming/configuration errors are not caught as ordinary malformed source data.
- [ ] Add 25 rejected rows and assert errorCount 25, errors.length 20, full fieldFailures 25, accurate fixture ratio, safe bounded identifiers, and no raw/secret content in diagnostics. Include whitespace required values and false/0 positive controls.
- [ ] Implement counters during iteration, not after allocating every error sample. Preserve original raw values and do not add diagnostic properties to fields or content_hash.
- [ ] Run `node --test test/normalize.test.mjs test/extract.test.mjs test/adapter.test.mjs`, then full suite; record N01/N02/X01.

**Exit:** Malformed content cannot crash supported normalization; fixture reporting remains correct beyond the diagnostic sample limit.

### Task 3 — Reject invalid filters without changing matching behavior

**Files:** src/filter.mjs; test/filter.test.mjs. Reuse path/calendar helpers rather than adding a second date parser.

**Produces:** exported validateFilter; applyFilter validates once; direct evaluateRule validates its supplied rule.

- [ ] Add typo regression and observe failure:

```js
test('invalid mode is rejected even for an empty store', () => {
  assert.throws(() => applyFilter([], { mode: 'al', rules: [] }),
    err => err.code === 'E_FILTER_INVALID');
});
```

- [ ] Implement the section 3.5 operand table and unknown-key checks. Default version/mode behavior must preserve existing tests that omit version.
- [ ] Test every operator with valid/invalid operands, empty all/any, absent fields, array intersection, inclusive boundaries, invalid now, and invalid field paths. `now` must be a valid Date for public calls using date rules; invalid caller time is E_OPTIONS.
- [ ] Run `node --test test/filter.test.mjs`, then full suite; record F01. Do not add filter operators or change read-time-only architecture.

**Exit:** Typos cannot silently broaden/narrow results; all documented valid matching behavior preserved.

### Task 4 — Enforce native body limits, timeouts, and safe failures

**Files:** Create src/http.mjs and test/helpers/http-server.mjs. Modify src/fetch.mjs, src/errors.mjs, test/fetch.test.mjs. Convert Response doubles in test/run.test.mjs and scripts/run-earthquake-{offline,broken}.mjs. Create the transport portion of test/integration.test.mjs.

**Interfaces:** `readJsonBody(response,{signal,maxResponseBytes,budget})`, where budget is one mutable per-fetch `{bytes,maxBytes}` object reused across attempts; throws structured size/JSON errors. `safeFailure(error,stage)` projects approved fields only. Fetch diagnostics are attached as error.details.fetch on failure. Never export mutable global counters.

- [ ] Write a standard-Response regression before implementing bounded reads:

```js
test('actual bytes are limited without Content-Length', async () => {
  const a = { ...baseAdapter, fetch: { max_response_bytes: 10 } };
  await assert.rejects(fetchAll(a, {
    fetchImpl: async () => jsonResponse([{ payload: 'x'.repeat(1000) }]),
  }), err => err.code === 'E_RESPONSE_LIMIT');
});
```

- [ ] Add a helper using node:http createServer, listen on 127.0.0.1 port 0, expose origin, track sockets, and close/destroy them in t.after. It must allow routes to send chunked/gzip/stalled/malformed responses without contacting public hosts. Native loopback tests use host 127.0.0.1, the same URL origin, and actual Fetch.
- [ ] Implement chunk accounting/cancel/cleanup and combined caller/per-attempt/overall signals. Match Node 22.15 APIs from section 12; do not merely pass a signal without consuming/rejecting a stalled body. Keep retry disabled internally until Task 6 is complete, using one attempt in this task's tests.
- [ ] Add native chunked, decompressed oversized body, cumulative byte budget, pre-header stall, mid-body stall, caller abort, already-aborted caller, and disposed-body tests. Ensure a body above the limit is rejected without first loading it fully. Cancellation tests assert server/request closure and absence of subsequent work.
- [ ] Test malformed JSON/empty body/missing path/null path/non-array path, redirects, URL credentials rejection, and a secret placed in query/header/body/cause. Assert serialized safe failure contains none of those secrets. Do not add HTTP content-type enforcement: JSON endpoints with absent/mislabelled content type may work if parsing succeeds.
- [ ] Convert each affected old fake to native Response with the same payload. Do not weaken byte checks to accommodate fakes. Fixture scripts remain offline and must not be run against real store paths as tests.
- [ ] Run `node --test test/fetch.test.mjs test/integration.test.mjs test/run.test.mjs`, then full suite; record H01–H04, marking cumulative-attempt evidence pending Task 6 if needed.

**Exit:** Actual body/time bounds are demonstrated over native HTTP. Keep all unimplemented retry scenarios unproven.

### Task 5 — Fix pagination and make truncation explicit

**Files:** src/fetch.mjs; test/fetch.test.mjs; adapters/www.karnatakacareers.org.adapter.json; adapters/example.adapter.json; relevant integration tests.

**Consumes:** bounded transport and shared pagination validation. **Produces:** diagnostics.complete/stop_reason and repeat protection per section 4.3.

- [ ] Add omitted-per_page regression:

```js
test('unknown page size continues until empty', async () => {
  const a = { ...baseAdapter, fetch: { pagination: {
    style: 'page-param', param: 'page', max_pages: 3,
  } } };
  const batches = [[{ id: 1 }], [{ id: 2 }], []];
  const result = await fetchAll(a, { fetchImpl: async () => jsonResponse(batches.shift()) });
  assert.equal(result.pages, 3);
  assert.equal(result.items.length, 2);
  assert.equal(result.diagnostics.complete, true);
});
```

- [ ] Implement explicit termination table, cap handling, repeated-batch digest, safe record accumulation, and progress diagnostics.
- [ ] Test short/empty/unknown-size/exact-full-final-page, cap 1, repeated batches, differing overlapping IDs, max_records boundary and overflow, and an endpoint ignoring its page parameter. Never synthesize a terminal page after HTTP failure.
- [ ] Update Karnataka adapter with allow_truncation true because its current max_pages 5 intentionally defines a bounded latest window. Document that intent in metadata/README later; do not claim complete historical coverage. The example template should show allow_truncation false by default and explain when true is justified.
- [ ] Existing test asserting a full three-page cap succeeds must opt into allow_truncation explicitly; retain a separate default-rejection test. This is an intentional changed contract, not a reason to delete the old behavior test.
- [ ] Run focused fetch/integration tests then full suite; record P01–P03. Zero-store-on-failure integration is completed in Task 10.

**Exit:** Every fetch result/failure explains why pagination stopped; configured windows are explicit.

### Task 6 — Add bounded retries, pacing, and cancellation through waits

**Files:** src/http.mjs, src/fetch.mjs, src/errors.mjs; test/fetch.test.mjs, test/integration.test.mjs.

**Interfaces:** internal `retryDelay({retryNumber,backoffMs,maxDelayMs,retryAfter,nowMs,random})` returns `{delayMs,deferred,retryAfterMs}`; `waitFor(ms,signal)` rejects on abort and removes listeners/timers. Adapter defaults from config.mjs; no new public injection options.

- [ ] Add retry regression:

```js
test('transient 503 retries once before succeeding', async () => {
  let calls = 0;
  const a = { ...baseAdapter, fetch: { retry: {
    max_attempts: 3, backoff_ms: 0, max_delay_ms: 0,
  } } };
  const r = await fetchAll(a, { fetchImpl: async () =>
    ++calls === 1 ? jsonResponse({}, { status: 503 }) : jsonResponse([]) });
  assert.equal(calls, 2);
  assert.equal(r.diagnostics.attempts, 2);
  assert.equal(r.diagnostics.retries, 1);
});
```

- [ ] Implement exactly section 4.2, disposing failed responses before wait. Recompute remaining budget before every attempt/wait. Total consumed bytes include bytes read from failed/retried attempts; discarded unread status bodies do not need draining into memory.
- [ ] Pure-helper table: seconds/date/past/invalid Retry-After, 0/max random endpoints, exponential cap, header beyond cap, attempt limit. Never reduce a valid server delay to fit local preferences.
- [ ] Native integration: 503→200; 429 Retry-After: 1 with sufficient budget/cap and actual >=1s wait; abort during that wait; 403 one request; transport disconnect then success; repeated disconnect bounded; timeout vs total deadline distinct. Use server-side timestamps/counts and generous bounds.
- [ ] Page pacing test confirms requested delay between successful page completions/next request; retries do not count as new pages. No request after deadline/abort.
- [ ] Run focused fetch/integration tests then full suite; record R01–R03 and complete H02 cumulative-retry evidence. Confirm tests exit naturally without force-exit or arbitrary sleep cleanup.

**Exit:** Network failures are retried only when allowed and can never produce unbounded work.

### Task 7 — Stream history and preserve replay after incomplete writes

**Files:** src/store.mjs; test/store.test.mjs; create scripts/verify-store-scale.mjs. No lock implementation yet.

**Interfaces:** section 3 store APIs; read option maxLineBytes/onWarning. readIndex/readLatestRecords consume iterateRecords directly. appendRecords returns successful appended count only after sync/close; errors use E_STORE_WRITE and preserve cause.

- [ ] Add warning/iterator regression:

```js
test('iterator recovers with visible corruption and latest hash', async t => {
  const p = await tempPaths(t);
  await writeFile(p.storeFile,
    '{"id":"h:1","content_hash":"a"}\nnot json\n' +
    '{"id":"h:1","content_hash":"b"}\n', 'utf8');
  const warnings = [];
  const idx = await readIndex(p.storeFile, { onWarning: w => warnings.push(w) });
  assert.equal(idx.get('h:1'), 'b');
  assert.deepEqual(warnings.map(w => [w.code, w.line]), [['W_STORE_CORRUPT_LINE', 2]]);
});
```

- [ ] Implement bounded byte-line iteration with try/finally cleanup on full consumption, early return, or throw. No historical-record array in reducers; no repeated Buffer concatenation with quadratic behavior on long lines. Keep chunks until line boundary while enforcing byte count, concatenate only that bounded line.
- [ ] Test CRLF, split multibyte character, missing file, empty file, final complete line without LF, malformed final tail, valid non-object JSON, missing id/hash objects, tiny maxLineBytes boundary, oversized unterminated line, early break/close, and a genuine non-ENOENT read error. Do not change machine ACLs to simulate permissions; use an invalid filesystem shape and focused injected-error tests if required.
- [ ] Add preflight tests: a later unserializable/oversized record leaves existing file byte-identical; no records means zero/no new file. Implement preflight, newline repair, awaited writes/sync/close. Test Windows rename/remove after completion to catch leaked handles.
- [ ] Keep original store regression tests; add latest/index test with many revisions to verify both final value and ordering (Map insertion order remains first-seen ID order, with last value).
- [ ] Write verify-store-scale.mjs to create a disposable 256 MiB JSONL history incrementally in bounded chunks, rotating 100 IDs with approximately 4 KiB payloads. Spawn a child Node process with `--max-old-space-size=96`; child calls readIndex and readLatestRecords separately, asserts 100 IDs and latest values, reports elapsed/heap/RSS. Never generate the entire fixture string/array in memory. Clean only its own resolved temp directory. Put worker mode in this script guarded by explicit argv, not test discovery.
- [ ] Run `node --test test/store.test.mjs`, `node scripts/verify-store-scale.mjs`, then full suite. Record S01–S04 with runtime, file bytes, unique count, heap flag, result and observed memory. This proves repeated-history reduction, not unlimited unique-ID capacity.

**Exit:** Store history is scanned with bounded line buffering; legacy array API remains available with honest memory limits.

### Task 8 — Add owned local locking and process-level proof

**Files:** Create src/lock.mjs, test/lock.test.mjs, test/helpers/store-worker.mjs. Re-export withStoreLock in src/store.mjs. runIngest integration remains Task 9.

**Consumes:** canonical local paths and IngestionError. **Produces:** withStoreLock per section 5.2, callback gets canonicalStoreFile, and returns callback result unchanged.

- [ ] Start with nested contender test:

```js
test('contender cannot enter or remove the owner lock', async t => {
  const p = await tempPaths(t);
  await withStoreLock(p.storeFile, { runId: 'owner' }, async () => {
    let entered = false;
    await assert.rejects(withStoreLock(p.storeFile, { runId: 'contender' }, async () => {
      entered = true;
    }), e => e.code === 'E_STORE_LOCKED');
    assert.equal(entered, false);
    assert.equal(JSON.parse(await readFile(p.storeFile + '.lock', 'utf8')).run_id, 'owner');
  });
  await assert.rejects(readFile(p.storeFile + '.lock'), { code: 'ENOENT' });
});
```

- [ ] Implement exclusive creation, initialization cleanup, safe canonical parent/store handling, owned metadata, and finally release. Do not recursively lock appendRecords. Do not delete an existing lock based on time or PID.
- [ ] Add callback-throws, failed initialization, missing parent, symlink-store rejection, lock metadata mismatch, and release failure tests. A release failure must not mask the callback's primary failure. Use internal filesystem seam only where a real portable error cannot be arranged; never expose it as adapter configuration.
- [ ] Add an IPC child protocol: parent starts owner; child sends `locked`; parent starts contender and waits for its E_STORE_LOCKED outcome; parent sends `release`; owner exits; a third acquisition succeeds. No timing-based guess about when lock exists.
- [ ] Kill owner after `locked` and wait for actual exit. Assert lock remains, next call fails, inspect metadata, explicitly remove only that test-owned lock after the child is confirmed gone, then acquire again. Cleanup must never remove a real project's lock.
- [ ] Run `node --test test/lock.test.mjs` then full suite. Record L01/L02 distinguishing Promise-level test from actual child-process evidence. Reuse worker in Task 10 for runIngest contention.

**Exit:** Lock ownership is proved across processes on the local platform; no stale-lock automation or distributed claims.

### Task 9 — Integrate the final lifecycle, reports, and canary baseline

**Files:** src/run.mjs, src/report.mjs, src/canary.mjs, src/errors.mjs; test/run.test.mjs, test/report.test.mjs, test/canary.test.mjs, test/integration.test.mjs.

**Interfaces:** buildReport retains current inputs and adds runId, adapterFingerprint, mode, outcome, errorCount, failure, secondaryErrors, warnings/warningCount, fetchDiagnostics, storage, canary. Missing new inputs get explicit benign defaults for standalone callers. readHistory keeps signature; internal history iterator supports eligible scanning. runIngest uses section 6 schema and lock wrapper.

- [ ] Add saved-canary regression:

```js
test('final saved canary matches returned stale result', async t => {
  const paths = await tempPaths(t);
  const { report, canary } = await runIngest({ adapter: baseAdapter, paths,
    fetchImpl: async () => jsonResponse([]), now: new Date('2026-09-18T00:00:00Z') });
  const [saved] = await readHistory(paths.runsDir, 1);
  assert.equal(canary.status, 'stale');
  assert.deepEqual(saved.canary, canary);
  assert.equal(saved.outcome, 'stale');
  assert.equal(saved.run_id, report.run_id);
});
```

- [ ] First implement report schema/build tests, safe bounded collectors, unique filenames, exclusive temp publication, legacy reads, and non-masked filesystem errors. Keep report publication tests independent of runIngest.
- [ ] Add a unique-ID test running two reports with the exact same startedAt and asserting two distinct files/content; include a crash-left temporary sibling and malformed JSON file that history ignores. Assert report_version/shape validation; do not accept arbitrary arrays/null as history.
- [ ] Refactor runIngest in the exact lifecycle order in section 6.2. Use internal finalize logic to avoid duplicated success/failure report code. Do not create a generic workflow engine. Handle pre-lock errors with their own report, and owned-lock work with final publication before release.
- [ ] Feed full extraction errorCount, capped samples, corruption warnings, fetch diagnostics, real storage result, and fingerprint to the report. Set written null only for uncertain append failures, not ordinary fetch/config failures. Canaries must not retroactively block storage of otherwise valid records.
- [ ] Add invalid-adapter-with-valid-runsDir artifact test; invalid paths/CLI unreadable config are explicit no-guaranteed-artifact cases. Test original failure plus report failure and primary error retention via cause/secondary_errors.
- [ ] Implement eligible-history scanning before current publication; tests place many ineligible reports ahead of five eligible ones and prove all five good reports are considered. Include changed fingerprint, stale/error/legacy/incremental/future entries, and no eligible history.
- [ ] Pass one logical now throughout canary evaluation. For epoch-millisecond fixtures, do not accidentally parse numeric values as seconds. Add empty-delta test with incremental config/since and explicit skipped checks; keep empty snapshot stale. Update old report-history tests to populate valid v2 metadata where integration eligibility now requires it.
- [ ] Test primary success/report failure and lock release failure semantics. Filesystem errors can be arranged with runsDir set to a regular file; ACL editing is prohibited. Error samples/strings and CLI projection must omit the injected secret from Task 4.
- [ ] Run `node --test test/run.test.mjs test/report.test.mjs test/canary.test.mjs test/integration.test.mjs`, then full suite; record O01–O03/C01/C02. Recheck errorCount >20 through full run, not just extraction.

**Exit:** Returned state, disk artifact, storage state, and error precedence agree for each modeled outcome.

### Task 10 — Prove real consumer and failure/replay scenarios

**Files:** test/integration.test.mjs, test/helpers/store-worker.mjs, test/helpers/http-server.mjs, test/run.test.mjs. Production changes only to fix failures against requirements already in this plan.

**Consumes:** completed Tasks 1–9. **Produces:** end-to-end evidence E01–E04 and strengthened L01/H/P evidence.

- [ ] For each recorded adapter, load its fixture and pass native Response. Choose explicit logical now from the newest mapped staleness value plus 12 hours so historical fixtures have deterministic health. Never disable freshness checks merely to make fixtures green. Assert first fresh count, identical replay written 0, one edited mapped field changed 1, latest view has one row per ID, and broken required mapping reports stale.
- [ ] Use a native local two-page endpoint: first page valid, second 503 through all attempts. Seed existing store before test and assert byte-identical store afterward; report shows page-1 progress and error, not a successful partial ingestion.
- [ ] Use a regular file as runsDir to force report-publication failure after successful append. Catch E_REPORT_WRITE, assert attached storage committed, restore a valid new runsDir, replay same payload and assert no added lines. Representative final assertions:

```js
const before = await readFile(paths.storeFile, 'utf8');
const rerun = await runIngest({ adapter, paths: recoveredPaths, fetchImpl });
assert.equal(rerun.report.stages.written, 0);
assert.equal(await readFile(paths.storeFile, 'utf8'), before);
```

- [ ] Run two child processes executing actual runIngest against the same store and a gated loopback endpoint. Owner waits inside fetch after lock acquired; contender must fail before issuing HTTP. Release owner via IPC/server control; a later replay adds zero duplicates. This completes L01 at the orchestration boundary.
- [ ] Extend worker to simulate abrupt write interruption at a precisely signaled point: while holding its test-store lock, write/sync one valid line plus a known partial next line, send `partial_written`, and wait. Parent terminates it, waits for exit, proves lock remains, performs explicit test-only recovery, then replays full source through runIngest. Earlier record remains, missing record appears once, corrupt tail is warned, no fabricated successful report for killed invocation. This is a controlled storage-crash scenario, not proof that production append is transactional.
- [ ] Test ordinary successful page overlap with different content for one ID: last occurrence wins and parsed/classified/written counts explain the difference. Test canceled fetch and canceled wait produce no store mutation; cancellation after append preserves committed status.
- [ ] Run `node --test test/integration.test.mjs`, full suite, and scale script. Record OS/process topology/native HTTP use/commands/results. Do not replace failures with serial-only tests, force exits, or retries of the whole test suite.

**Exit:** Fixture success, network failure, concurrency, and replay have observed outcomes on real filesystem/process/network boundaries.

### Task 11 — Document the real API and verify the installed artifact on supported platforms

**Files:** README.md, new MIGRATION-0.2.md, package.json, package-lock.json, .github/workflows/ci.yml, .github/workflows/release.yml, new scripts/verify-package.mjs; scripts/run-earthquake-offline.mjs, scripts/run-earthquake-broken.mjs as needed for Response/time-safe documented examples. Update TEST-MATRIX.md/VERIFICATION.md/STATUS.md.

**Produces:** working installed-package consumer, explicit migration/recovery guidance, test matrix in CI, aligned runtime/lockfile metadata. No package publish yet.

- [ ] Rewrite README around actual JSON/GET support and package imports. Include a copyable complete adapter + runIngest + readLatestRecords + applyFilter example using a local fixture Response so a fresh installer can run it without repository adapters. Include paths, error handling, canary handling, and clock example. No absolute E: drive or ~/.claude skill path as a requirement for package users.
- [ ] Document all sections 3.2/5 recovery/6 incremental limits, strict config/defaults, bounded windows, low-level locking responsibility, raw HTML escaping, diagnostic sensitivity, and remaining O(unique IDs)/directory-history bounds. Clarify advisory canary storage behavior and unknown write counts. Public functions must have input/result/error descriptions.
- [ ] Add MIGRATION-0.2.md to the npm files allowlist. Keep adapters/fixtures/scripts/tests/plan/status/verification/local stores out of package. Do not rewrite NOTES-generalization.md historical proof as current live proof; README can explain its historical scope.
- [ ] Set engines.node to >=22.15.0; reconcile package-lock metadata using npm tooling without upgrading dependencies. Before/after dependency diff must show no unintended version changes. Keep package version 0.1.0 until Changesets versioning in Task 12.
- [ ] Implement verify-package.mjs: create its own temp directory, `npm pack --json --pack-destination <temp>`, inspect file allowlist/version, create a temp consumer package, install the exact local tarball with `--ignore-scripts --omit=dev --package-lock=false --no-audit --no-fund`, and launch a consumer .mjs using only package imports. Handle Windows npm invocation correctly with explicit executable/argument handling, no concatenated shell command containing untrusted text.
- [ ] Consumer imports every current public subpath, runs a native-Response first/replay/edit/stale fixture flow, checks stored/report artifacts, and confirms no import-side CLI effect. Imports must resolve from the installed package, not relative src paths or NODE_PATH. Runtime dependency list remains empty. Write pack manifest/version/hash and test outcome into verification output; delete only the owned temp directory after inspection, unless execution requests retaining the candidate for release.
- [ ] Harden existing CLI argument parsing: one adapter path and optional --since YYYY-MM-DD only; missing/duplicate/unknown flags exit 2. Catch file/JSON/config errors without stack/body leakage. Validate host before deriving default paths. CLI config-file failures before a safe host exists have stderr evidence, not a fabricated report location. Hook SIGINT/SIGTERM into an AbortController for fetch/waits, await cleanup, remove handlers, set exitCode; never install process handlers on library import.
- [ ] CLI process tests spawn Node with argv arrays, disposable cwd, local adapter/server; assert exit codes/artifacts and no unexpected writes on import. Preserve direct `node src/run.mjs <adapter>` usage; do not add bin/npx claims.
- [ ] CI matrix: ubuntu-latest/windows-latest × Node 22.15.0, latest 22, latest 24. Each cell runs npm ci, npm test, node scripts/verify-package.mjs. Scale proof runs once per OS on Node 24. Upload failure evidence using verified action versions; do not guess future major tags. There is no requirement for public-source network access in tests; dependency installation is separate.
- [ ] Release workflow must gate publication on the same CI verification, not just Ubuntu unit tests. Prefer making ci.yml callable with workflow_call and a release validation job using it, then release job needs validation. Preserve normal pull_request/push coverage; tolerate duplicate validation rather than weakening the release gate. Look up GitHub's exact reusable-workflow syntax before editing.
- [ ] Preserve verified Changesets v2.1.0 inputs publish-script/version-script. Do not "fix" them to old v1 names from memory. Replace floating npm@latest with an exact verified npm 11 version compatible with chosen release Node 24 and trusted publishing; record the chosen version/source in VERIFICATION.md. Do not select the exact patch from memory.
- [ ] Run npm ci, full tests, package verification and scale script locally; then obtain actual CI results on both OSes/runtimes during authorized integration. Local success does not mark K03 passed. Validate migration instructions using the installed tarball and real old fixture records.

**Exit:** K01/K02 local evidence passes; K03 requires real matrix results. Package users can follow instructions without the author's workstation/recipe directory.

### Task 12 — Review, version, and publish only the verified candidate

**Files:** new .changeset/reliability-release.md; package.json/package-lock.json/CHANGELOG.md via Changesets; VERIFICATION.md, TEST-MATRIX.md, STATUS.md. Workflow fixes only if verified release evidence requires them.

**Inputs:** all prior scenario evidence, CI run identifiers, registry version, inspected tarball. **Output:** verified release, or clearly recorded remaining publication blocker. A local plan/test pass alone is not a published version.

- [ ] Review final diff against the scope, all B findings, section 8 matrix, intentional compatibility changes, secret projection, cleanup/error precedence, and no-new-runtime-dependency rule. Perform a focused independent review only if agent/delegation authorization exists; otherwise do a separate inline review pass. Any new confirmed defect receives a named regression, minimal fix, and relevant re-verification.
- [ ] Require every scenario owned by Tasks 1–11 passed, with no unexplained failures/skips. K03 must have actual CI evidence. Q01 is completed by the version/candidate steps below and Q02 after actual publication; do not demand either before doing its owning work. Check no real source/store data or secrets entered the diff/artifact.
- [ ] Add this Changeset after code and migration documentation are complete; preserve the existing numeric-entity patch Changeset so it is incorporated by Changesets rather than manually deleted:

```md
---
"@shrinivas-sn/adapter-ingestion": minor
---

Harden JSON ingestion with strict adapter and record validation, bounded fetches,
retries, explicit pagination completeness, local store locking, streaming history
reads, and final run reports. Require Node 22.15.0 or newer. See MIGRATION-0.2.md
for stricter configuration, fetch injection, pagination, and recovery behavior.
```

- [ ] Recheck registry latest/dist-tags and that target 0.2.0 is unused. Verify actual trusted-publisher repository/workflow/environment settings when access is available; record unavailable checks as blocked, never inferred from YAML. README's historic OIDC 404 diagnosis is not proof of the current cause.
- [ ] Use the normal Changesets version PR flow once pushing/integration is authorized. Do not manually bump version and also run Changesets over the same changes. Review generated manifest/changelog/lockfile; the local lock root must match package version. Verify release script doesn't invoke a conflicting npm lifecycle version hook: use current Changesets/npm documentation and an isolated versioning dry run before relying on `npm run version`.
- [ ] Run tests/matrix/package verification on the actual version commit. Pack the candidate and record its version, file list, integrity/hash, revision, and verification. Mark Q01 passed only now. No unreviewed code changes between candidate validation and publish; if the workflow repacks, verify packed file content against the candidate manifest.
- [ ] Publish only when execution-session authorization covers release. Use trusted publishing through the configured workflow. A failure is investigated using actual safe logs; do not automatically run npm login/manual publish, add a token, weaken checks, or mark success because provenance alone was signed.
- [ ] After publication: query registry version/dist-tags, inspect published metadata/provenance, install the exact registry version into a new disposable consumer, repeat the public-import/ingest smoke, and compare expected files/version/integrity. Record actual workflow and registry evidence for Q02.
- [ ] Update STATUS.md with published version, commit, verification links and remaining known limitations only after those checks succeed. If publication is unavailable, say "implementation verified; publication pending" with the specific missing evidence.

**Exit:** Actual registry package is installable and tested; or publication remains explicitly incomplete. Never overwrite an existing npm version. A regression after release is handled by a new version or authorized dist-tag action, not modifying a published tarball.

## 10. Completion gates and resume discipline

Before closing any task: map its changes to requirements, verify named cases, inspect diff for unrelated additions, run focused/full commands, update matrix and status. No checkboxes are checked in this planning session.

Implementation-complete requires Tasks 0–11 and Task 12 review/version-preparation evidence, all implementation rows passed, reviewed migration notes, no unintended dependencies/exports, and verified CI. Release-complete additionally requires Q02 and actual registry install proof. Do not collapse those states.

At each handoff record in STATUS.md: current task, last completed task, next exact command/action, failed/blocked scenario IDs, dirty files, and links to evidence. Keep STATUS concise; detailed evidence belongs in VERIFICATION.md. Never restart completed tasks after context loss without checking their evidence/diff.

VERIFICATION entries contain date/revision/task/scenarios/platform/runtime/command/exit/result/limitations. Preserve red-test evidence where it demonstrates the original bug. Raw bulky logs live in an ignored verification-output directory or CI artifact, not in production source or npm tarball. If adding a local artifact directory during execution, name it `.verification-output/` and add only that entry to .gitignore.

After every behavior change ask: Does the new test fail if this fix is removed? Does it assert observable output/state rather than a helper call? Are success, failure, cleanup, and replay covered where relevant? Are known limitations stated rather than hidden behind a green count?

## 11. Deferred roadmap and future decision triggers

| Deferred item | Evidence required before a new plan |
| --- | --- |
| RSS/XML or HTML | Real source fixtures and consumer demand; explicit parser/dependency/security policy. |
| URL templates/text labels | A verified source that needs them, safe encoding/missing-field behavior, no per-host hacks. |
| Cursor/offset/Link pagination | Real protocol samples and termination/replay contract. |
| Automatic checkpoints | Commit ordering, late arrivals, timestamp ties, rejected-record replay, and restart proof; never just save maximum timestamp. |
| Compaction/external index | Measured unique-ID or history growth beyond documented local bounds, migration/recovery design. |
| POST/GraphQL/auth | Concrete read API, credential injection/redaction contract, safe retry semantics. |
| 1.0.0 | Deliberately stable public/schema/error contract plus real consumer upgrade evidence; version label alone is not a reliability fix. |

## 12. Primary references and source-use instructions

Reviewed on 2026-09-18. Fetch exact sections as needed before implementation; these references do not authorize external workspace edits. External docs support API mechanics; the product policies/defaults above are explicit design choices, not upstream requirements.

- [Node 22.15 filesystem APIs](https://nodejs.org/download/release/v22.15.0/docs/api/fs.html): exclusive open, file handles, awaited writes, sync/close, rename. Exclusive creation is not a network-filesystem guarantee.
- [Node 22.15 globals](https://nodejs.org/download/release/v22.15.0/docs/api/globals.html): Fetch, Response, AbortSignal.timeout/any and abort reasons.
- [Node 22.15 test runner](https://nodejs.org/download/release/v22.15.0/docs/api/test.html): native tests, cleanup, discovery. Verify exact CLI flags on the runtime in use.
- [RFC 9110 Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after): integer seconds or HTTP date. Retry cap/defer/jitter choices in this plan are package policy.
- [Changesets action v2.1.0 definition](https://raw.githubusercontent.com/changesets/action/v2.1.0/action.yml): this version uses publish-script and version-script and runs on Node 24. Preserve version-correct inputs.
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/): current docs require npm >=11.5.1 and Node >=22.14.0 for publishing; exact workflow identity matters. Recheck at release time.
- [Node release lifecycle](https://nodejs.org/en/about/previous-releases): Node 20 is EOL; 22/24 are LTS as reviewed. The package floor 22.15.0 is an explicit tested support choice.
- [Semantic Versioning](https://semver.org/): define the public API and communicate compatibility. 0.2.0 is a proposed development-series milestone, not a guarantee imposed by SemVer.
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows): implementation must retrieve exact workflow_call syntax before Task 11 edits; not yet verified by this planning pass.
- Local references read: `E:/dev-recipes/_knowledge/START-HERE.md`, `unified-testing-guide.md`, applicable test-patterns.yaml evidence/isolation rules, and generated-adapter-ingestion recipe. They do not require importing unrelated site workflow tools.

## 13. Planning record

- 2026-09-18: Replaced the speculative audit/market roadmap with this release specification and sequential execution plan after source/test/workflow/fixture inspection and targeted bug reproductions.
- Baseline checked: 66 existing tests pass; fixtures extract 5/5 and 6/6; workspace owner verified; local manifest/lock drift identified.
- All implementation tasks/scenario proofs remain pending. No source, tests, adapters, workflows, dependencies, versions, or published artifacts were changed in the planning session.
