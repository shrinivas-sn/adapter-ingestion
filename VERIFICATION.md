# Verification log

Append-only. One entry per executed command that produces scenario or baseline evidence.
Raw bulky logs belong in an ignored `.verification-output/` directory, not here.

## Task 0 — Establish the executable baseline and test ledger

**Date:** 2026-09-18
**Revision:** `179e5f4` (docs commit on `main`), replayed on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `(Get-Acl -LiteralPath 'E:\adapter-ingestion').Owner` | 0 | `SSN-INSPIRON-35\Dell` — matches expected workspace owner. | |
| `node --version` | 0 | `v22.15.0` | |
| `npm --version` | 0 | `10.9.2` | |
| `git rev-parse HEAD` | 0 | `179e5f423a1a0e5bd230cf80db88507ba70a5842` | |
| `npm test` (pre-change, script `node --test`) | 0 | 66/66 pass. | |
| `npm view @shrinivas-sn/adapter-ingestion version dist-tags --json` | 0 | `{"version":"0.1.0","dist-tags":{"latest":"0.1.0"}}`. 0.2.0 unused. | Registry lookup succeeded via npm CLI this session (prior web-tool lookup had failed per STATUS.md); target 0.2.0 remains provisional until Task 12 recheck. |
| `npm test` (post-change, script `node --test "test/*.test.mjs"`) | 0 | 66/66 pass; discovery unchanged, `test/helpers/fixtures.mjs` correctly excluded (no import-time side effects, no test() calls). | |

**Scenario status:** No section-8 scenario ID is proved by Task 0; this task only establishes
baseline evidence, the ledger, and reusable test helpers. TEST-MATRIX.md created with all 38
rows `unproven`.

**Deviations from plan:** None. package.json test script changed exactly as specified.
No production source touched.

## Task 1 — Validate configuration and enforce record identity

**Date:** 2026-09-18
**Revision:** `7cb16e5` (Task 0 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** new `src/config.mjs`, `src/errors.mjs`; modified `src/adapter.mjs` (delegates to
`validateAdapterConfig`), `src/contract.mjs` (identity/URL invariants, iterative JSON-safety
check replacing the old recursive `assertNoUndefined`), `src/extract.mjs` (own-property-only
`getPath`, unconditional source_id/url checks folded into `missing`, `buildRecord` failures
caught per-record); `src/normalize.mjs` (added `isValidDateOnly` — internal export, not a
new package subpath). Test files extended: `test/adapter.test.mjs`, `test/contract.test.mjs`,
`test/extract.test.mjs`.

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/adapter.test.mjs test/contract.test.mjs test/extract.test.mjs` | 0 | 64/64 pass (21 before this task, confirmed via `git stash`; +43 new tests). | |
| `npm test` (full suite) | 0 | 109/109 pass (66 baseline + 43 new). | |
| `node -e` script validating both real adapters + example.adapter.json against `validateAdapter` | 0 | `earthquake.usgs.gov` → ok:true; `www.karnatakacareers.org` → ok:true; `example.adapter.json` → ok:false (`<HOST>` correctly rejected as not a bare hostname, `<PATH>` URL invalid). | Matches plan.md instruction: template stays intentionally invalid. |

**Scenario status:** V01, V02, V03, V04 — pass (see TEST-MATRIX.md). X01/N01/N02 remain
Task 2's responsibility (extractAll's `errorCount`/`fieldFailures` diagnostics are not yet
added; Task 1 kept the existing `{index, missing}` error shape).

**Notable implementation decisions (not deviations, but worth recording):**
- `access.kind` is now restricted to `json-api` only (was previously `json-api`/`feed`/
  `html`/`browser`) — this resolves B08's validation-layer half (fetch-layer enforcement is
  still Task 4/H04). No existing adapter or test used the other three kinds.
- Windows reserved-device-basename check tests only the host string's first dot-separated
  label (`CON.example.com` → basename `CON` → rejected), matching how Windows determines
  filename validity for a single path component containing dots.
- `assertNoUndefined` was extended in place (same export, same signature, same message
  format for the undefined case) rather than adding a parallel function, since its existing
  direct tests only exercise the undefined case and the new checks are supersets that don't
  change that behavior.
- Existing error-message fragments relied on by the pre-Task-1 test suite
  (`/bare hostname/`, `/hostname must equal/`, `/must both be set or both omitted/`,
  `/must name a field in map/`, `/unknown key/`, `/ghost/`, `/url/`, `/normalizer/i`,
  `/http/`) were preserved verbatim — confirmed by the full suite staying green.

**Deviations from plan:** None identified.

## Task 2 — Normalize bad source values and improve extraction diagnostics

**Date:** 2026-09-18
**Revision:** `964c830` (Task 1 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/normalize.mjs` (rewrote `text`'s numeric-entity decode to never throw and
route zero/surrogate/overflow to U+FFFD; fixed `number` to reject overflow-to-Infinity;
rewrote `iso-date` as an explicit hand-validated grammar — no `Date` parsing — covering ISO
timestamps with offsets, English day-month-year, and numeric day-first, with full calendar
validation via the `isValidCalendarDate` helper added in Task 1); `src/extract.mjs`
(`extractAll` now returns `errorCount` and `fieldFailures` computed over *all* rejected
records, caps `errors` samples at 20, and splits each failure into `missing` vs `invalid`
field names with bounded/safe `source_id`/`source_url` diagnostics — no raw content, no
credentials/query/fragment); `src/adapter.mjs` (`verifyAgainstFixtures` now reads
`fieldFailures` from extractAll's full counters instead of re-deriving from the capped
`errors` sample). Test files extended: `test/normalize.test.mjs`, `test/extract.test.mjs`,
`test/adapter.test.mjs` (unchanged this task — no config-layer normalizer surface).

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/normalize.test.mjs test/extract.test.mjs test/adapter.test.mjs test/contract.test.mjs` | 0 | 93/93 pass (70 before this task, confirmed via `git stash`; +23 new tests). | |
| `npm test` (full suite) | 0 | 132/132 pass (109 before + 23 net new). | |
| `node -e` script re-running `verifyAgainstFixtures` against both real adapters' recorded fixtures | 0 | `earthquake.usgs.gov` → 5/5, `{}` field failures; `www.karnatakacareers.org` → 6/6, `{}` field failures — unchanged from Task 0/1 baseline despite the `iso-date`/`number` rewrite. | |

**Scenario status:** N01, N02, X01 — pass (see TEST-MATRIX.md).

**Notable implementation decisions:**
- Full month names (e.g. "September") were already silently accepted by the pre-Task-2 code
  via an unbounded `slice(0,3)` prefix trick, which also wrongly accepted garbage words
  sharing a month's first 3 letters (e.g. "Septemberish"). Task 2 replaces this with an
  explicit short/full name list requiring an exact case-insensitive match.
- The Task-1-authored extract test `'an invalid source_url (bad protocol) is reported even
  when url is not in required'` asserted the bad URL landed in `missing`. Task 2 introduces
  the missing/invalid split from section 4.5, so a present-but-malformed URL is now correctly
  `invalid`, not `missing`. Updated in place (not a regression — a refinement this task
  explicitly introduces) and renamed to make the distinction explicit.
- `code` on an error entry is `'E_RECORD_INVALID'` for classification failures (missing/
  invalid identity or required fields) and the thrown `IngestionError`'s own code for a
  `buildRecord` rejection (currently always `E_RECORD_INVALID` too, since that's the only
  code `buildRecord` throws as of Task 1).

**Deviations from plan:** None identified.

## Task 3 — Reject invalid filters without changing matching behavior

**Date:** 2026-09-18
**Revision:** `b0d6683` (Task 2 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/filter.mjs` (new `validateFilter`; `applyFilter` validates once up front —
including on a zero-record call — and throws `IngestionError('E_FILTER_INVALID', ...)`;
`evaluateRule` validates its own rule when called directly; both validate `now` as
`E_OPTIONS`); `src/config.mjs` (exported `isValidPathString`/`pathHasReservedSegment` for
reuse, no new package subpath); `test/filter.test.mjs` extended.

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/filter.test.mjs` | 0 | 27/27 pass (6 before this task, confirmed via `git stash`; +21 new). | |
| `npm test` (full suite) | 0 | 153/153 pass (132 before + 21 new). | |

**Scenario status:** F01 — pass (see TEST-MATRIX.md).

**Notable implementation decisions:**
- Matching semantics (10 existing operators, array-intersection, missing-field pass/fail
  table) are byte-for-byte unchanged — only a validation layer was added in front.
- Reused `isValidPathString`/`pathHasReservedSegment` from config.mjs and `isValidDateOnly`
  from normalize.mjs rather than writing second copies, per plan.md Task 3's file note.
- `evaluateRule` re-validates on every call, including when invoked internally by
  `applyFilter`'s per-record loop (already validated once at the top) — accepted as
  redundant-but-correct per the plan's explicit "direct evaluateRule validates its rule too"
  interface; the rule sets here are small enough that this costs nothing measurable.

**Deviations from plan:** None identified.

## Task 5 — Fix pagination and make truncation explicit

**Date:** 2026-09-18
**Revision:** `14a6beb` (Task 4 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/fetch.mjs` (`perPage` is now `undefined` when omitted instead of defaulting to
`Infinity`, so a short page can never be inferred without a declared `per_page`; added
`diagnostics.complete`/`stop_reason` per the section 4.3 termination table — `single_page`,
`empty_page`, `short_page`, `max_pages`; `allow_truncation` opt-in that turns a cap-hit on a
still-full page from `E_PAGE_LIMIT` into `complete:false` plus a `W_PAGE_LIMIT` warning;
new `digestBatch` — SHA-256 of `JSON.stringify(batch)` in response order — throws
`E_PAGINATION_REPEAT` on an exact nonempty-batch repeat even with `allow_truncation` set);
`adapters/www.karnatakacareers.org.adapter.json` (`allow_truncation: true` added — its real
pagination legitimately returns a full last page); `test/fetch.test.mjs` extended (P01–P03);
`test/integration.test.mjs` adjusted (transport tests now explicitly opt into
`allow_truncation` or vary each page's content, so they don't trip the two new,
unrelated pagination checks); `test/run.test.mjs` adjusted (`allow_truncation: true` added
to its fixture adapter, whose recorded page is a genuinely full single page).

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | 0 | 42/42 pass (32 before this task, confirmed via `git stash`; +10 new). | |
| `npm test` (full suite) | 0 | 180/180 pass (170 before + 10 new). | |

**Scenario status:** P01, P02, P03 — pass (see TEST-MATRIX.md).

**Notable implementation decisions:**
- Repeat detection only fires on a *nonempty* batch digest match — two consecutive empty
  pages (which can't happen inside the loop, since an empty batch always breaks with
  `empty_page` first) or two empty responses across independent calls are not a repeat by
  construction, matching section 4.3's "exact repeat of a prior nonempty batch."
- The cap-hit/truncation check (`page === maxPages` reached on a batch that still looks full,
  or whose fullness can't be determined because `per_page` is undefined) runs *after* the
  repeat check, so a source that repeats its final page is always reported as
  `E_PAGINATION_REPEAT`, never silently accepted as a truncated-but-distinct window.
- `test/integration.test.mjs`'s `H02` cumulative-bytes test previously sent byte-identical
  page bodies by construction (same fixed array every response) — harmless before Task 5,
  but now a true positive for `E_PAGINATION_REPEAT` since it's a real exact repeat. Fixed by
  making each page's payload include its own page number rather than by suppressing the new
  check; the byte-cap assertion itself is unaffected since total bytes across the (now
  slightly larger, still deterministic) three pages is unchanged.
- No adapter behavior change for `earthquake.usgs.gov`: it uses no pagination config at all,
  so it was and remains `stop_reason: 'single_page'`, unaffected by this task.

**Deviations from plan:** None identified.

## Task 6 — Add bounded retries, pacing, and cancellation through waits

**Date:** 2026-09-18
**Revision:** `a22aed4` (Task 5 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/http.mjs` (new `retryDelay` — pure, injectable `nowMs`/`random`, full-jitter
exponential backoff capped at `max_delay_ms`, honors a parsed `Retry-After` as a floor and
returns `deferred: true` when it can't be honored within `max_delay_ms`; new internal
`parseRetryAfterMs` — integer seconds or HTTP-date, past date to 0, invalid to `null`; new
`waitFor` — abortable delay, removes its timer/listener on every exit path); `src/fetch.mjs`
(the single fetch attempt per page became a bounded per-page retry loop — fresh
`AbortSignal.timeout` per attempt, `isRetryableError` restricted to `E_FETCH`/`E_TIMEOUT`/
retryable `E_HTTP_STATUS` (408/429/500/502/503/504), `E_RETRY_DEFERRED` when a server
`Retry-After` exceeds `retry.max_delay_ms` or the remaining `max_duration_ms` budget; added
`delay_ms` pacing between successful pages; `diagnostics.bytes` now reads from the shared
per-call `budget.bytes` instead of a success-only running total, so bytes consumed by a
stalled/retried attempt are no longer dropped; added `diagnostics.attempts`/`diagnostics.retries`).
`test/fetch.test.mjs` extended (pure `retryDelay`/`waitFor` table, R01 fake-`fetchImpl`
regression, two prior tests given explicit `retry: { max_attempts: 1 }` since E_TIMEOUT/E_FETCH
became retryable by default and those tests are about classification, not retries).
`test/integration.test.mjs` extended (real-server R01–R03 tests, the completed H02
cumulative-retry-bytes proof; three prior H03/H04 tests given the same explicit
`max_attempts: 1` opt-out for the same reason).

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | 0 | 62/62 pass (42 before this task, confirmed via `git stash`; +20 new). | |
| `npm test` (full suite) | 0 | 200/200 pass (180 before + 20 new). | |
| `node --check` on `src/http.mjs`, `src/fetch.mjs` | 0 | Syntax valid. | |
| Throwaway probe script (`node -e ...`, not committed): a real loopback server destroying the socket before any response | 0 | `fetch()` rejects with `TypeError('fetch failed')`, `err.cause.code === 'UND_ERR_SOCKET'` — not `TimeoutError`/`AbortError` — confirming `classifyFetchError` correctly falls through to the generic, retryable `E_FETCH` rather than being guessed. | |

**Scenario status:** R01, R02, R03 — pass; H02's cumulative-across-*retries* evidence
(deferred from Task 4) is now complete (see TEST-MATRIX.md).

**Notable implementation decisions:**
- **"Stop instead of issuing another attempt" vs. `E_RETRY_DEFERRED` are two different
  outcomes, deliberately.** Section 4.2 distinguishes a server-specified `Retry-After` that
  can't be honored (fails loudly with `E_RETRY_DEFERRED` and `retry_after_ms`, since the
  server gave an explicit, actionable directive the caller may want to reschedule around)
  from a plain exponential-backoff wait that would exceed the remaining `max_duration_ms`
  budget (no server directive exists to report, so `fetchAll` just gives up quietly and
  rethrows the failure that actually happened — the last 503/timeout/etc. — rather than
  manufacturing a distinct error). This also keeps "timeout vs. total deadline distinct"
  (an explicit Task 6 test requirement) true: `E_FETCH_DEADLINE` remains reserved for the
  top-of-page-loop budget check between pages; a retry-budget exhaustion mid-page never
  produces it.
- The mid-page retry-budget-exhaustion test needed to be deterministic without access to
  `retryDelay`'s injectable `random` (which `fetchAll` intentionally never exposes through
  adapter JSON, per section 4.2's "do not expose a fake clock or randomness in adapter JSON").
  Solved by making the first attempt itself take longer than `max_duration_ms` (a
  deliberately delayed server response, well inside `timeout_ms`), so remaining budget is
  already negative by the time the retry decision runs — any non-negative computed wait
  exceeds it regardless of jitter, without needing to control `Math.random()`.
- `isRetryableError`'s HTTP-status check reads `err.details.fetch.status`, a new field added
  to the `E_HTTP_STATUS` throw site specifically for this classification (via `fetchContext`
  gaining an optional `extra` merge parameter) — additive only; no existing test asserts an
  exact shape for `.details.fetch`, only named subfields like `.origin`.
- Three existing Task 4/5 tests (`H03` pre-header-stall, `H03` mid-body-stall, `H04` secret
  in a 500 response) and two in `fetch.test.mjs` (the fake `TimeoutError`/`DOMException` test,
  and the DNS-failure secret-leak test) started incidentally exercising retries once E_TIMEOUT
  and E_FETCH became retryable by default, since none of them had previously needed to say
  anything about retry behavior. Each was given an explicit `retry: { max_attempts: 1 }`
  opt-out, mirroring exactly how Task 5 gave transport-focused tests an explicit
  `allow_truncation` opt-out for the same reason (an unrelated new default rippling into an
  older test's assumptions) — not a weakening of any assertion, since every original
  assertion is unchanged and still enforced.
- `budget.bytes` (already threaded through every `readJsonBody` call across a whole
  `fetchAll` invocation since Task 4) turned out to already satisfy "total consumed bytes
  include bytes read from failed/retried attempts" with no new bookkeeping — swapping
  `diagnostics.bytes` from a success-only running total to `budget.bytes` directly was the
  entire fix.
- `delay_ms` pacing and the retry backoff wait share the same `waitFor` primitive but are
  applied at two different points: pacing runs once per page, only when the loop is actually
  continuing to another page (not after the terminal page); retry backoff runs inside the
  per-attempt loop, only between a failed attempt and the next one. Retries never increment
  `pages`, so pacing cannot be miscounted as having occurred "per attempt".

**Deviations from plan:** None identified.

## Task 7 — Stream history and preserve replay after incomplete writes

**Date:** 2026-09-18
**Revision:** `dc7e358` (Task 6 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/store.mjs` rewritten (new `iterateRecords` async generator — bounded 64 KiB
chunk reads via a raw file handle, a line's bytes held as an array of Buffer slices and
concatenated exactly once when the line completes rather than repeatedly, `maxLineBytes`
enforced immediately on every append to the pending line rather than only after buffering an
entire oversized line, CRLF tolerated by trimming a trailing `\r` off the assembled line,
UTF-8 decoded only once a complete line's bytes are known so a multi-byte character split
across a chunk boundary can't corrupt; malformed JSON/non-object JSON warns
`W_STORE_CORRUPT_LINE`, a well-formed object missing a nonempty string `id`/`content_hash`
warns `W_STORE_INVALID_RECORD`; `readRecords`/`readLatestRecords`/`readIndex` now consume the
iterator directly — the latter two reduce without ever building the intermediate records
array `readRecords` still does; `appendRecords` preflights id/hash shape, JSON
serialization, and per-line size for the *entire* batch, one record at a time, before any
file mutation, then writes/syncs/closes in a `finally`). New `scripts/verify-store-scale.mjs`
(disposable 256 MiB fixture generated in bounded batches, verified in a child process capped
at `--max-old-space-size=96`). `test/store.test.mjs` extended with the full S01–S04 table.

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/store.test.mjs` | 0 | 24/24 pass (6 before this task, confirmed via `git stash -u`; +18 new). | |
| `npm test` (full suite) | 0 | 218/218 pass (200 before + 18 new). | |
| `node scripts/verify-store-scale.mjs` | 0 | Generated 66,041 records / 256.0 MiB in 3853ms. Child (heap capped at 96 MB): `readIndex` 1735ms, `readLatestRecords` 1972ms, both confirming all 100 unique ids with the correct latest `content_hash`; `heapUsedMb` 17.82, `rssMb` 77.60 — comfortably under the 96 MB heap cap. Output verbatim: `{"heapLimitMb":96,"uniqueIds":100,"readIndexMs":1735.3922,"readLatestRecordsMs":1971.6174,"heapUsedMb":17.823455810546875,"rssMb":77.6015625}` | Proves repeated-history reduction under 100 unique ids at this scale, not unlimited unique-ID capacity (index growth is O(unique ids), documented as a standing limit). |
| `node --check src/store.mjs`, `node --check scripts/verify-store-scale.mjs` | 0 | Syntax valid. | |

**Scenario status:** S01, S02, S03, S04 — pass (see TEST-MATRIX.md).

**Notable implementation decisions:**
- An ENOTDIR-style "file where a directory is expected" trick (used successfully in earlier
  tasks' Windows-portable error simulation) was tried first for S02's "genuine non-ENOENT
  read error" case and empirically failed: probed directly, `open()` on a path with a regular
  file standing in for a directory component reports plain `ENOENT` on Windows, not a
  distinct code — which this package's `iterateRecords` correctly treats as "missing file,"
  making that specific trick unusable here. Replaced with a path containing an embedded null
  byte, which Node's own `fs` path validation rejects with `ERR_INVALID_ARG_VALUE` on both
  platforms (verified) — a real, portable, non-ACL, non-ENOENT failure.
- CHUNK_BYTES (64 KiB) is an internal implementation constant, not part of the public
  interface — the "multi-byte UTF-8 split across a chunk boundary" test necessarily hardcodes
  the same 64 KiB value to construct a fixture that straddles the real boundary; a comment at
  the test site flags this coupling so a future change to the internal chunk size doesn't
  silently make that specific test stop testing what it claims to.
- `finalizeLine`'s size/CRLF/blank/parse/shape checks run in the same order for both a
  newline-terminated line and a final unterminated tail at EOF (both funnel through the same
  function) — a truncated final tail from a crash is treated exactly like a corrupt
  mid-file line (`W_STORE_CORRUPT_LINE`, skipped), not as a special case, matching section
  5.3's "corrupt tail is warned" recovery expectation.
- `appendRecords`'s preflight validates id/hash shape and attempts `JSON.stringify` per
  record before checking that record's serialized byte length — order doesn't affect
  outcome (an invalid-shape record and an internally-cyclic record are both rejected
  before any write regardless of which check fires first), but is worth noting since the
  plan lists "serialization, id/hash shape, and per-line size" without an explicit sequence.
- The scale script's 4 KiB-per-record padding, 100-id rotation, and 256 MiB target produced
  66,041 total records (not a round number) — expected, since payload size is only
  "approximately" 4 KiB per the plan's own wording (JSON structural overhead varies slightly
  per record), and the script stops as soon as the cumulative byte count reaches the target,
  not at a fixed record count.

**Deviations from plan:** None identified.

## Task 8 — Add owned local locking and process-level proof

**Date:** 2026-09-18
**Revision:** `973022d` (Task 7 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** new `src/lock.mjs` (`withStoreLock(filePath, {runId}, callback)` — realpaths the
parent directory after creating it, rejects a symlinked store file with `E_OPTIONS`; creates
`<canonicalStoreFile>.lock` exclusively via `open(...,'wx')`, an existing lock is immediate
`E_STORE_LOCKED`; writes `{version,run_id,pid,hostname,started_at}` metadata, cleaning up only
the lock this invocation just created on an initialization failure; releases in a `finally`-
equivalent flow that verifies `run_id` before unlinking, refusing to touch a lock it can't
confirm it owns; a release failure never masks the callback's own thrown error, and a
cleanup-only failure itself rejects `E_LOCK_RELEASE`); `src/store.mjs` re-exports
`withStoreLock` per the plan's file map; new `test/helpers/store-worker.mjs` (an IPC-driven
child for real cross-process proof, reused again in Task 10); new `test/lock.test.mjs`.

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/lock.test.mjs` | 0 | 13/13 (12 pass, 1 documented skip; file is new this task, no prior baseline). | The symlink-rejection test skips on this machine (Windows, no Developer Mode/admin) — `fs.symlink` itself rejects with `EPERM` before the code under test ever runs, empirically verified. |
| `npm test` (full suite) | 0 | 231/231 (230 pass, 1 skip; 218 before this task + 13 new). | |
| `node --check` on `src/lock.mjs`, `test/helpers/store-worker.mjs`, `test/lock.test.mjs` | 0 | Syntax valid. | |

**Scenario status:** L01, L02 — pass (see TEST-MATRIX.md, including L01's documented scope:
Promise/process-level proof at the `withStoreLock` boundary; the `runIngest`-orchestration
boundary is Task 10's).

**Notable implementation decisions:**
- **A real, reproducible cross-process hang was found and fixed in the test helper, not in
  production code.** `test/helpers/store-worker.mjs`'s original design left its top-level
  `process.on('message', ...)` listener registered after finishing a command; a forked
  child's IPC channel keeps the event loop alive for as long as that listener exists,
  whether or not more messages are actually coming, so the worker never exited on its own
  after a graceful `release` -- only `t.after`'s force-kill (which never fires for a process
  that already looks exited-in-progress) or the OS eventually reaping it would have ended it.
  Diagnosed by bisecting with throwaway, non-`node:test` probe scripts (the default TAP
  reporter buffers a test's `console.log`/`stderr` until that test concludes, which is why
  the hang wasn't visible through `node --test` output directly) down to a raw
  `open('wx')`-only reproduction, which resolved instantly, isolating the actual cause to the
  worker never calling `process.exit()`. Fixed by having the worker explicitly exit after
  each one-shot command, waiting for `process.send`'s own completion callback first (`send()`
  is asynchronous; exiting immediately after calling it risks the process dying before the
  message actually reaches the parent -- a second, smaller correctness risk caught in the
  same pass). Left ~17 already-orphaned `node.exe` processes across several earlier hung
  runs; identified precisely by command line (`Get-CimInstance Win32_Process`) and killed
  only those, verified by command line to belong to this debugging session and not to any of
  the user's other running Node processes (a Next.js dev server, `codex.js`, `cua-repl.mjs`).
- **No code from section 4.5's list fits "reject a symlink store file" exactly**, since it's
  neither "lock already held" (`E_STORE_LOCKED`) nor a store-content write failure
  (`E_STORE_WRITE`). Classified as `E_OPTIONS`, matching section 6.2's existing use of that
  code for an invalid `storeFile`/`runsDir` path -- a symlinked store path is the same kind
  of "this configuration can't be used," not a runtime contention or write failure.
- **"Lock metadata mismatch" and "release failure" were both provable with real, portable
  filesystem behavior** (overwriting/deleting the lock file out from under a still-running
  callback) rather than the internal test seam the plan allows -- reserved that seam
  (`__testHooks.afterCreateBeforeMetadata`, exported only for tests importing `src/lock.mjs`
  directly, never read from adapter JSON) for the one case with no such portable equivalent:
  a write failing in the narrow window between the lock file's exclusive creation and its
  metadata actually landing.
- The plan's IPC protocol note ("parent starts owner; child sends `locked`; parent starts
  contender...") is implemented with the *contender* acquisition happening directly in the
  parent test process rather than as a second forked child -- the exclusion being proved is
  between the owner (a genuinely separate OS process) and any other caller, and the parent
  process is exactly that; a second child would prove the same boundary with more moving
  parts for no additional evidence.

**Deviations from plan:** None identified.

## Task 9 — Integrate the final lifecycle, reports, and canary baseline

**Date:** 2026-09-18
**Revision:** `a5fe3f4` (Task 8 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** `src/canary.mjs` rewritten (`checkCanary(report, history, cfg, {now})` — a 4th
options param for injectable, deterministic time; incremental mode skips
min_records/count_drop_ratio/staleness with reason `incremental_batch`, and
required_field_ratio with `empty_batch` when the incremental delta is empty; snapshot mode
always evaluates min_records, including `[]`; a new `canary.skipped` array records every
skip with its reason; staleness now parses via a dedicated `parseStalenessInstant` — strict
date-only or explicit-zone ISO timestamp (reusing `isValidDateOnly` from normalize.mjs for
the calendar check) or finite epoch milliseconds, rejecting a zone-less timestamp instead of
guessing; a light defensive median filter excludes any given history entry whose own
`outcome` says failed/stale, while still counting legacy entries with no `outcome` field at
all). `src/report.mjs` rewritten (`buildReport` emits the full v2 schema — `report_version`,
`run_id` defaulting to a real `randomUUID()`, `adapter_fingerprint`, `mode`, `outcome`,
`failure`, `secondary_errors`, `warnings`/`warning_count`, capped `fetch`/`storage` blocks —
with every new field defaulting sanely for a minimal standalone caller; `fatal_error`
defaults to mirroring `failure.message` for compatibility, overridable explicitly;
`writeReport` publishes via an exclusive uniquely-named temp sibling, sync, close, then
rename, with the run_id embedded in the final filename so two reports at the identical
`started_at` never collide; new `readEligibleHistory(dir, limit, isEligible)` scans
newest-first and stops once enough eligible reports are found without loading every body;
`readHistory` is now a thin wrapper over it with no filter). `src/run.mjs` rewritten
end-to-end in the exact section 6.2 lifecycle order, wired to Task 8's `withStoreLock`.
`src/errors.mjs` gained `addSecondaryError` (shared by `run.mjs` and a refactored
`lock.mjs`, replacing lock.mjs's own inline duplicate of the same logic).
`test/run.test.mjs`, `test/report.test.mjs`, `test/canary.test.mjs` extended; two existing
`run.test.mjs` assertions updated (see below); `test/integration.test.mjs` unchanged this
task (see scope note below).

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/run.test.mjs test/report.test.mjs test/canary.test.mjs` | 0 | 37/37 (15 before this task, confirmed via `git stash`; +22 new). | |
| `node --test test/run.test.mjs test/report.test.mjs test/canary.test.mjs test/integration.test.mjs` | 0 | 57/57 (the 37 above + 20 unchanged `integration.test.mjs` transport tests, confirming no regression there). | |
| `npm test` (full suite) | 0 | 253/253 (252 pass, 1 documented skip carried over from Task 8; 231 before this task + 22 new). | |
| `node --check` on `src/run.mjs`, `src/report.mjs`, `src/canary.mjs`, `src/lock.mjs`, `src/errors.mjs` | 0 | Syntax valid. | |
| `node scripts/verify-earthquake-adapter.mjs` (read-only; no `runIngest`/store/runs writes) | 0 | `validateAdapter` ok:true; `verifyAgainstFixtures` 5/5, ratio 1, `{}` field failures — extraction path unaffected by this task. | `scripts/run-earthquake-{offline,broken}.mjs` were re-`node --check`ed only, not executed, since both write into this workspace's real `store/`/`runs/` directories (same standing limitation recorded in Task 4's entry); Task 10 owns real fixture end-to-end execution (E01) in isolated temp paths. |

**Scenario status:** O01, O02, O03, C01, C02 — pass (see TEST-MATRIX.md).

**A real bug found and fixed while writing the O03 tests (not a pre-existing regression --
introduced and caught within this same task):** `report.mjs`'s `writeReport` called
`mkdir(dir, {recursive:true})` outside any try/catch. Forcing that specific call to fail
(`runsDir` pointed at a regular file, an approach the plan's own Task 9 checklist names) threw
a raw `EEXIST` `Error`, not an `IngestionError` -- `safeFailure` correctly refuses to trust an
unrecognized error's own code/message, but its fallback for exactly that case assumes an
unrecognized error can only be an arbitrary `fetchImpl` failure and labels it `E_FETCH`. The
first O03 test's own assertion (secondary error must be `E_REPORT_WRITE`) caught this
immediately. Fixed by wrapping the `mkdir` call and classifying it the same way every other
fs call in this module already was.

**Notable implementation decisions:**
- **Two existing `run.test.mjs` assertions were updated, not weakened.** `fetch.retry:
  {max_attempts: 1}` was added to the shared test adapter -- E_FETCH/E_TIMEOUT became
  retryable by default in Task 6, and none of this file's tests are about retry behavior
  (same pattern Task 6 already used elsewhere). The "run that throws" test's
  `assert.match(history[0].fatal_error, /DNS lookup failed/)` was replaced with assertions on
  `outcome`/`failure.code` and an explicit check that the raw message is *absent* from the
  persisted JSON -- the old assertion depended on exactly the unsafe behavior section 4.5
  requires removing (E_FETCH's message is always replaced in any safe projection); the
  underlying in-memory thrown error still carries the raw message unchanged, which a separate
  assertion in the same test still confirms.
- **`test/integration.test.mjs` was deliberately left unchanged this task.** Its existing
  scope is transport-only (`fetchAll` against real servers); a real-HTTP-server-plus-full-
  `runIngest` proof would duplicate what Task 10 exists specifically to do end-to-end
  (real fixtures, real concurrent processes, real crash-recovery), so Task 9's own coverage
  stayed at the `runIngest`-with-fake-`fetchImpl` level already established in
  `run.test.mjs`, consistent with that file's existing pattern.
- **C01's test needed a genuine `adapter_fingerprint` value, not a guessed/duplicated hash
  computation.** Rather than exporting `computeAdapterFingerprint` (an internal helper) purely
  for test use, or re-implementing the same SHA-256-of-canonical-JSON formula a second time in
  the test file (exactly the kind of duplication the fingerprint's own "one canonical
  identity" purpose argues against), the test runs one real `runIngest` call first and reads
  back its actual published `adapter_fingerprint`, then uses that real value when hand-seeding
  the ineligible history entries that must be excluded from the median.
- **The four ineligible seed reports in C01 are dated *after* the two real baseline runs**
  (not before), specifically so a newest-first eligible-history scan encounters them *first*
  and must correctly skip past them to reach the two real eligible entries. Dating them
  earlier would have let the scan satisfy its `median_window` from the real entries alone,
  never exercising the exclusion logic the test exists to prove.
- **O03 needed two variants to isolate its two distinct report-handling failure points.**
  Snapshot mode's eligible-history scan and the final `writeReport` call both read/write the
  same `runsDir`, so pointing it at a blocked path fails at the *history scan* first
  (`E_REPORT_READ`) for a snapshot run -- still a faithful proof of "committed storage
  survives a downstream report failure," just not the specific `E_REPORT_WRITE` code. A
  second, incremental-mode variant (which skips the eligible-history scan entirely, per
  section 6.3) isolates the final-write failure specifically, proving `E_REPORT_WRITE` as
  primary when no other error exists.
- **A `withStoreLock`-release failure after an otherwise fully successful run** (section 5.2's
  "attempt to update this run's report to error") is tested by having `fetchImpl` itself
  overwrite the run's own lock file with a foreign `run_id` as a side effect -- `fetchImpl`
  runs *inside* the held lock, making it the one available hook to simulate external
  interference without an internal test seam. The already-published successful report is
  republished in place (same `run_id`/filename) with `outcome: 'error'`, and the store file's
  committed records are confirmed still present.
- `checkCanary`'s `now` parameter and `parseStalenessInstant`'s explicit-zone-timestamp
  regex are new; every other snapshot-mode check (min_records, required_field_ratio,
  count_drop_ratio) keeps its pre-Task-9 arithmetic unchanged, confirmed by all 8 pre-existing
  `canary.test.mjs` tests passing verbatim against the rewrite before any new tests were added.
- `readHistory`'s pre-Task-9 "write-then-slice(1)" pattern in `run.mjs` is gone entirely: the
  eligible-history scan now runs *before* the current report is published, so the current run
  is never in the read results to begin with, removing the off-by-one class of bug the Task 6
  regression test (`a real collapse is not masked by the median-window off-by-one`) exists to
  guard against. That test passes unchanged against the new implementation.

**Deviations from plan:** None identified.

## Task 4 — Enforce native body limits, timeouts, and safe failures

**Date:** 2026-09-18
**Revision:** `870accc` (Task 3 commit) → this task, on `release/0.2.0-reliability`
**Platform / runtime:** Windows 11 / Node v22.15.0 / npm 10.9.2

**Files:** new `src/http.mjs` (`readJsonBody` — actual-byte-counted body reading with a
per-response `maxResponseBytes` cap and a cross-page/attempt `budget` object for
`max_total_bytes`); new `test/helpers/http-server.mjs` (real loopback `node:http` server,
routes by pathname, tracks/destroys sockets on close); `src/errors.mjs` (`safeFailure` —
error-code-aware safe projection; `E_FETCH`'s message is always replaced since it can embed
text from an arbitrary injected `fetchImpl`, every other code is self-authored and passes
through); `src/fetch.mjs` rewritten (redirect:'error', combined caller+per-attempt abort
signal via `AbortSignal.any`, `max_duration_ms` deadline checked before/after body parse,
`max_records` checked before an unbounded spread, no full URL ever embedded in a message —
only `.details.fetch.origin`); converted every hand-rolled `{ok,status,json}` fake to native
`Response`/real sockets in `test/fetch.test.mjs`, `test/run.test.mjs`,
`scripts/run-earthquake-{offline,broken}.mjs`; new `test/integration.test.mjs` (transport
portion — real chunked/gzip/stall/redirect/malformed-JSON/secret-leak proofs).

| Command | Exit | Result | Limitation |
| --- | --- | --- | --- |
| `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | 0 | 32/32 pass (15 before this task across fetch+run, confirmed via `git stash`; +17 new, 11 of them in the new integration.test.mjs). | |
| `npm test` (full suite) | 0 | 170/170 pass (153 before + 17 new). | |
| `node --check` on every new/modified source file | 0 | Syntax valid. | |

**Scenario status:** H01, H02 (pages/attempts portion), H03, H04 — pass (see TEST-MATRIX.md).
H02's cumulative-across-*retries* evidence and H03's retry-specific pacing remain Task 6's
responsibility (retries are still disabled — one attempt per page, as the plan requires for
this task).

**Notable implementation decisions:**
- Empirically verified (via a throwaway probe script against this task's own
  `test/helpers/http-server.mjs`, not committed) the exact error shapes Node 22.15's native
  fetch throws, rather than guessing: `AbortSignal.timeout` firing names its error
  `TimeoutError` (`err.name`) even when wrapped in `AbortSignal.any([...])`; a manual
  `AbortController.abort()` names it `AbortError`; `redirect:'error'` rejects with a
  `TypeError` whose `.cause.message` is exactly `'unexpected redirect'`. `classifyFetchError`
  in fetch.mjs is built directly on these observed shapes.
- Fixed a real bug found while testing the mid-body-stall case: a stall *after* headers are
  already sent aborts inside `readJsonBody`'s stream read, which previously let the raw
  `TimeoutError`/`AbortError` escape unclassified past fetch.mjs's `catch` (it only checked
  `instanceof IngestionError`). Now classified the same way a connection-phase failure is.
  Caught by `test/integration.test.mjs`'s mid-body-stall test before this was committed.
  `readJsonBody`'s own `E_ABORTED`/`E_RESPONSE_LIMIT`/`E_TOTAL_BYTES_LIMIT`/`E_RESPONSE_JSON`
  throws are unaffected (already `instanceof IngestionError`).
- B14 (full request URLs embedded in fetch error messages) is fixed: no thrown message
  anywhere in fetch.mjs concatenates the request URL; only `.details.fetch.origin`
  (origin only, never path/query) is attached, and that detail is itself the input to
  `safeFailure`, which further replaces `E_FETCH`'s message with a generic phrase since it's
  the one case built from `err.message` of an arbitrary injected `fetchImpl`.
- Two test assumptions were corrected after they failed against real behavior, not by
  weakening the underlying check: (1) the loopback server originally matched routes on
  `req.url` including the query string fetchAll appends (`?page=1`), so every real-server
  test 404'd — fixed to route by pathname. (2) A socket-close-within-N-ms assertion for the
  pre-header-stall case was replaced with "no further request was made after the timeout" —
  whether/when undici tears down the underlying TCP socket after an abort is its own
  implementation detail, not something this package controls or needs to assert on; the
  mid-body-stall case (where a socket-level assertion isn't needed to prove the same thing)
  still proves the abort fires correctly.
- `verifyAgainstFixtures`/`validateAdapter` don't call `fetchAll`, so they and both recorded
  adapters' fixture extraction are unaffected by this task; not re-verified separately here
  (Task 2's re-verification already covers that surface).
- `scripts/run-earthquake-{offline,broken}.mjs` were converted and syntax-checked
  (`node --check`) but deliberately **not executed** — they write to the real,
  already-populated `store/`/`runs/` directories in this workspace, and the plan explicitly
  prohibits running fixture scripts against real store paths as tests.

**Deviations from plan:** None identified.
