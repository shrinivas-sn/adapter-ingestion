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
