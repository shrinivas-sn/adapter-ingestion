# Migrating to 0.2.0

0.2.0 is a reliability hardening release. The public API shape is unchanged (see
`README.md`'s "API" section), but several behaviors that were previously loose, silent, or
undocumented are now strict and explicit. Nothing here changes a valid record's `id`,
`fields`, `content_hash`, or a working filter's matching semantics — an existing store and
existing filter definitions keep working unmodified.

## Runtime requirement

**Node 22.15.0 or newer is now required** (`engines.node` in `package.json`). Earlier 0.1.x
accepted Node >=20. If you're on an older Node, upgrade before installing 0.2.0 — nothing in
this package will silently downgrade its behavior on an unsupported runtime.

## Stricter validation — things that now fail instead of silently passing through

These are the compatibility-relevant changes. If your adapter or calling code already
matched the documented contract, none of this changes observed behavior; if it relied on
something now rejected, `validateAdapter`/`runIngest` will tell you exactly what and why
via `{ ok: false, errors: [...] }` or an `E_ADAPTER_INVALID` report — never a silent partial
success.

- **`access.kind` must be `"json-api"`.** Any other kind (a placeholder for `feed`/`html`/
  `browser`, which were never implemented) is now a validation error, not a value that
  silently reached a fetch layer that could only ever parse JSON anyway.
- **`fetch.method` must be omitted or exactly `"GET"`.** Non-GET was previously
  unvalidated; this release never implemented request bodies, so this is now enforced
  explicitly instead of failing confusingly at request time.
- **Every adapter/filter config field is now strictly validated** — unknown keys (a likely
  typo), out-of-range limits, malformed pagination/retry/canary blocks, and reserved map
  field names (`__proto__`, `constructor`, `prototype`) are all rejected before any network
  call, with a specific error message per field.
- **`source_id`/`url` (`source_url`) are unconditionally required on every record**,
  independent of whatever you list in `adapter.required`. A record missing either was
  always meant to be unidentifiable; this is no longer an assumption you could accidentally
  bypass by leaving them off your `required` array.
- **An impossible calendar date normalizes to `null`, not a garbage `Date`.** The
  `iso-date` normalizer validates real calendar/leap-year rules by hand — Feb 30, hour 25,
  etc. produce `null`, never a `Date` object that silently wrapped around to a nearby
  real date.
- **A missing/mistyped `records_path` is a shape error (`E_RESPONSE_SHAPE`), not an empty
  result.** If `records_path` resolves to something other than an array, the run now fails
  loudly instead of quietly ingesting zero records — the exact failure mode a stale canary
  exists to catch, made explicit at the source instead.
- **Pagination that hits `max_pages` while the batch still looks full is a hard failure
  (`E_PAGE_LIMIT`) unless you explicitly set `fetch.pagination.allow_truncation: true`.**
  Previously this could silently stop short of the real end of a listing. If your source
  legitimately needs a bounded window, opt in explicitly; the report's
  `fetch.complete`/`fetch.stop_reason` fields tell you which happened.
- **Two overlapping runs against the same store now fail loudly** (`E_STORE_LOCKED`) instead
  of both succeeding and double-appending the same records. `runIngest` acquires an owned,
  local, cooperative lock (`<storeFile>.lock`) for the duration of the run. This package
  does **not** implement stale-lock takeover, PID/age heuristics, or distributed locking —
  a lock left behind by a killed process (a crashed run, a force-terminated CI job) is
  cleared only by an operator explicitly removing the `.lock` file after confirming the
  owning process is actually gone. See "Recovering from a crashed run" below.
- **An injected `fetchImpl` must resolve with a real `Response`** (a readable `.body`,
  `.headers.get()`, `.status`) — a hand-rolled `{ ok, status, json: async () => ... }`
  double is no longer accepted. Byte caps, real chunked/gzip decoding, and timeout/abort
  wiring all depend on a genuine Response object. Convert an existing test double to
  `new Response(JSON.stringify(data), { status: 200 })`.

## Report shape — v2

Every report is now `report_version: 2` (previously an informal ad hoc shape). New/changed
top-level fields: `run_id`, `adapter_fingerprint`, `mode` (`"snapshot"` or `"incremental"`),
`outcome` (`"ok"` / `"stale"` / `"error"` / `"aborted"`), `failure` (`{ code, message,
stage, details? }` — `null` on success), `secondary_errors`, `warnings`/`warning_count`
(capped at 20 persisted samples, with the true total in `warning_count`, same pattern as
the existing `errors`/`error_count`), `fetch.{pages,attempts,retries,statuses,status_count,
bytes,complete,stop_reason}`, and `storage.{status,written}` (`written: null` specifically
means "uncertain, not zero" — a mid-write disk failure, not "nothing happened"). A minimal
standalone `buildReport()` caller gets sane, explicit defaults for every new field.

`error_count`/`errors` already existed but the split is now guaranteed exact: `error_count`
is always the true total number of rejected records for the run, while the persisted
`errors` array stays capped at 20 samples — check `error_count`, not `errors.length`, if
you need the real number. `errors[].fieldFailures` (via `extractAll`'s own return value, not
the report) breaks down which specific fields caused each rejection.

## Corrupt-line handling and structural limits

- A store line that fails to parse, isn't a JSON object, or is missing `id`/
  `content_hash` is now skipped with an explicit warning (`W_STORE_CORRUPT_LINE` /
  `W_STORE_INVALID_RECORD`, surfaced via the report's `warnings`) instead of throwing and
  aborting the whole read, or being silently dropped with no trace. A prior run's crash
  mid-write leaves a readable history; only the corrupt tail line itself is lost, and you
  now find out about it.
- Record `fields`/`raw` nesting is bounded to depth 100 (`E_RECORD_INVALID` beyond that) —
  a defensive bound against a pathological direct-`buildRecord` caller, not something any
  real adapter output should ever approach.
- A single store line has a configurable byte ceiling (`store.max_line_bytes`, default 64
  MB) — an oversized line fails explicitly (`E_STORE_LINE_LIMIT`) rather than being read
  into memory unbounded.

## Recovering from a crashed run

If a run was killed (not a graceful failure) while holding the store lock, `<storeFile>.lock`
remains on disk and every subsequent run against that store fails with `E_STORE_LOCKED` —
by design; this package never auto-recovers a lock. To recover:

1. Confirm the owning process is actually gone (check `.lock`'s `pid`/`hostname`/
   `started_at` fields against what you know about the crashed run).
2. Delete `<storeFile>.lock` manually.
3. Re-run. If the crash happened mid-append, the store's own corrupt-line handling
   (above) means an already-synced record survives and a partially-written tail is
   dropped with a warning — replay the same source and any record that didn't make it
   in reappears exactly once, not duplicated.

## What did not change

Valid record `id`s, `fields`, `content_hash` (same hash algorithm and canonical field
ordering), `readLatestRecords`/`readIndex` last-write-wins semantics, and existing valid
`filters/*.filter.json` matching behavior are all unchanged — an existing store and
existing filters keep working exactly as before against 0.2.0. If your adapter previously
relied on a normalizer coercing an already-correct value differently (a rare, targeted
fix — see the `fix-text-normalizer-entities` changeset), that specific field may produce one
legitimate new revision on the next run; nothing else about historical data is rewritten or
recomputed.
