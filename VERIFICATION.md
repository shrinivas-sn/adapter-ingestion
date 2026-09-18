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
