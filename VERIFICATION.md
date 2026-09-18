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
