# Test matrix

Scenario ledger for the 0.2.0 reliability release (plan.md section 8). Every row starts
`unproven`. A row moves to `pass` only after its named test/script actually runs and
passes; `fail` records an observed failure; `blocked` records what it is waiting on.
The prior 66-test baseline (2026-09-18, commit fd1fba1) is recorded as baseline evidence
only — no scenario below is passed by plan inspection alone.

| ID | Origin | Task | Scenario | Must prove | Test/script | Command | Status | Limitation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| V01 | project | 1 | Malformed adapter input | Malformed input returns validation errors without incidental throws or fetching. | test/adapter.test.mjs (malformed-input table) | `node --test test/adapter.test.mjs test/contract.test.mjs test/extract.test.mjs` | pass | |
| V02 | project | 1 | Invalid execution settings rejected | Invalid limits/styles/kinds/methods/headers/ratios rejected; real adapters validate. | test/adapter.test.mjs; adapters/*.adapter.json validated via node -e | same as V01, plus manual `validateAdapter` check against both real adapter JSON files | pass | |
| V03 | project | 1 | Unconditional identity/URL | ID/URL unconditional; zero ID and false ordinary fields survive. | test/extract.test.mjs, test/contract.test.mjs | same as V01 | pass | |
| V04 | project | 1 | Own-property paths only | No inherited traversal/prototype mutation; numeric/colon paths work. | test/extract.test.mjs, test/adapter.test.mjs | same as V01 | pass | |
| N01 | project | 2 | Numeric entity safety | Numeric entity correctness; huge/invalid/surrogate/zero references cannot throw. | test/normalize.test.mjs | `node --test test/normalize.test.mjs test/extract.test.mjs test/adapter.test.mjs` | pass | |
| N02 | project | 2 | Date/time correctness | Leap/date/time checks and written-date timezone behavior; finite number compatibility. | test/normalize.test.mjs | same as N01 | pass | |
| X01 | project | 2 | Mixed valid/invalid records | Mixed records retain valid rows with bounded actionable rejection samples. | test/extract.test.mjs | same as N01 | pass | |
| F01 | project | 3 | Filter validation | Invalid filter rejected even on []; existing missing/array/empty semantics preserved. | test/filter.test.mjs | `node --test test/filter.test.mjs` | pass | |
| H01 | project | 4 | Byte cap without Content-Length | Native chunked response without Content-Length is stopped by actual-byte cap. | test/integration.test.mjs | `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | pass | |
| H02 | project | 4 | Decoded/total/record limits | Decoded compressed/total-byte/record limits enforced before excess retention. | test/integration.test.mjs, test/fetch.test.mjs | same as H01 | pass | Cumulative-across-retries evidence completed in Task 6 (see VERIFICATION.md). |
| H03 | project | 4 | Stall/timeout/abort cleanup | Native header/body stalls terminate via timeout/deadline/abort and release resources. | test/integration.test.mjs | same as H01 | pass | |
| H04 | project | 4 | Safe error projection | JSON/path/redirect errors safe; supplied secret absent from reports/CLI. | test/integration.test.mjs, test/fetch.test.mjs | same as H01 | pass | |
| P01 | project | 5 | Unknown page size termination | Omitted per_page continues until []; known short-page/single-page cases correct. | test/fetch.test.mjs | `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | pass | |
| P02 | project | 5 | Explicit truncation | Cap default fails with zero writes; explicit bounded window preserves complete:false. | test/fetch.test.mjs | same as P01 | pass | |
| P03 | project | 5 | Repeat-page detection | Repeated page fails; normal overlapping IDs still dedupe last wins. | test/fetch.test.mjs | same as P01 | pass | |
| R01 | project | 6 | Retryable status classification | 503->200 uses two attempts; 401/403/404/invalid JSON use one. | test/fetch.test.mjs, test/integration.test.mjs | `node --test test/fetch.test.mjs test/run.test.mjs test/integration.test.mjs` | pass | |
| R02 | project | 6 | Retry-After handling | Retry-After seconds/date respected; excessive delay deferred; attempts/budget bounded. | test/fetch.test.mjs, test/integration.test.mjs | same as R01 | pass | |
| R03 | project | 6 | Abort during wait / pacing | Abort during retry wait prevents next request; page pacing actually occurs. | test/fetch.test.mjs, test/integration.test.mjs | same as R01 | pass | |
| S01 | project | 7 | Store iterator correctness | JSONL/CRLF/split UTF-8/final-line/no-file plus latest/index semantics. | test/store.test.mjs | `node --test test/store.test.mjs` | pass | |
| S02 | project | 7 | Corrupt-line handling | Bad lines warn; large line fails early; non-ENOENT failures are visible. | test/store.test.mjs | same as S01 | pass | |
| S03 | project | 7 | Preflight/tail repair | Invalid batch writes zero; prior partial tail repair preserves old/new records. | test/store.test.mjs | same as S01 | pass | |
| S04 | project | 7 | Bounded-memory scale proof | 256 MiB history, 100 IDs reduces under 96 MiB V8 heap; early break closes handle. | scripts/verify-store-scale.mjs | `node scripts/verify-store-scale.mjs` | pass | |
| L01 | project | 8 | Concurrent lock ownership | Actual concurrent processes: one enters, contender fails before fetch/mutation. | TBD (Task 8, orchestration boundary completed Task 10) | TBD | unproven | |
| L02 | project | 8 | Lock cleanup / crash recovery | Owned cleanup on success/error; crash leaves lock; only explicit recovery permits replay. | TBD (Task 8) | TBD | unproven | |
| O01 | project | 9 | Persisted vs returned canary agreement | Persisted and returned canary agree; terminal outcomes/counts accurate. | TBD (Task 9) | TBD | unproven | |
| O02 | project | 9 | Report publication integrity | Same-now reports unique; atomic temp ignored; malformed history skipped, I/O surfaced. | TBD (Task 9) | TBD | unproven | |
| O03 | project | 9 | Error precedence | Primary failure survives secondary report failure; committed storage remains visible. | TBD (Task 9) | TBD | unproven | |
| C01 | project | 9 | Canary baseline integrity | Bad/legacy/incremental/different-adapter history cannot lower snapshot baseline. | TBD (Task 9) | TBD | unproven | |
| C02 | project | 9 | Incremental/empty-delta canary | Empty delta skips specified checks; empty snapshot stale; now deterministic. | TBD (Task 9) | TBD | unproven | |
| E01 | project | 10 | Fixture end-to-end | Both fixtures: first/replay/edit/broken mapping/historical clock exercised end to end. | TBD (Task 10) | TBD | unproven | |
| E02 | project | 10 | Mid-pagination failure | Page 2 failure yields zero appends and honest progress/error report. | TBD (Task 10) | TBD | unproven | |
| E03 | project | 10 | Report-write failure replay | Report fails after append; unchanged replay adds zero duplicates. | TBD (Task 10) | TBD | unproven | |
| E04 | project | 10 | Crash-during-write recovery | IPC-controlled child dies after known prefix/tail write; recovery preserves prefix. | TBD (Task 10) | TBD | unproven | |
| K01 | project | 11 | Installed tarball public imports | Installed tarball imports every public subpath and runs without repo/dev files. | scripts/verify-package.mjs (Task 11) | TBD | unproven | |
| K02 | project | 11 | CLI exit codes | CLI codes 0/1/2 correct after flush; library import triggers no CLI. | TBD (Task 11) | TBD | unproven | |
| K03 | project | 11 | CI matrix proof | Linux/Windows, floor 22.15.0 and supported 22/24 pass offline CI. | .github/workflows/ci.yml (Task 11) | TBD | unproven | Requires actual CI run; local success does not pass this row. |
| Q01 | project | 12 | Candidate tarball inspection | Manifest/lock/changeset/changelog align; exact candidate tarball inspected/installed. | TBD (Task 12) | TBD | unproven | |
| Q02 | project | 12 | Real publish/install proof | Authorized actual workflow/registry/provenance/registry-install proof succeeds. | TBD (Task 12) | TBD | unproven | Requires publish authorization; not evaluated until Task 12. |

## Baseline (not a matrix row)

- 2026-09-18, commit `fd1fba1` (pre-plan-commit baseline; replayed post-commit on `179e5f4`
  before branching to `release/0.2.0-reliability`): `node --test "test/*.test.mjs"` on
  Windows / Node v22.15.0 -> 66/66 pass, exit 0.
- `npm view @shrinivas-sn/adapter-ingestion version dist-tags --json` -> `{"version":"0.1.0","dist-tags":{"latest":"0.1.0"}}`.
  0.2.0 is unused; target remains provisional per plan.md Task 0.
