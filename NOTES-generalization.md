# Generalization notes — second source proof

**Second source:** `earthquake.usgs.gov` GeoJSON summary feed. Chosen deliberately
structurally unlike a categorical-text source: numeric ranges (`magnitude`, `depth_km`),
geo coordinates (`latitude`/`longitude`), an epoch-millisecond timestamp, and a boolean
flag (`tsunami`) — see SPEC §8.1.

## Legal gate

USGS earthquake data is a work of the U.S. federal government and is public domain
domestically (17 U.S.C. §105); USGS's published data policy states its data are a free
public service with no usage restriction. `robots.txt` / ToS pages on `www.usgs.gov`
returned inconsistent statuses from this sandbox (bot-challenge responses, intermittent
`ECONNRESET`) rather than a clear allow/deny — the legal basis here rests on USGS's
well-established, independently verifiable public-domain data policy, not on a fetched
ToS page. Recorded as a gotcha below.

## Access ladder

Landed at **tier 0** — official, documented JSON API
(`/earthquakes/feed/v1.0/summary/4.5_day.geojson`). No probing below tier 0 was needed.

## Framework edits required: **zero**

No file under `src/` was touched to onboard this source. Every difference from the first,
categorical-text source was absorbed entirely by adapter-file configuration:

- Geo coordinates live at an array path (`geometry.coordinates.0/1/2`) — `getPath`'s
  existing numeric-index support (`a.b.0.c`) handled this with no change.
- The source's timestamp is epoch milliseconds, not a date string. Rather than stretch
  the `iso-date` normalizer (which parses string formats), the field was named
  `occurred_at_epoch_ms` and mapped through the existing `number` normalizer — `number`
  already passes a finite `typeof v === 'number'` through unchanged. No normalizer change.
- The source's boolean flag (`tsunami`) is `0`/`1`, not `"yes"`/`"no"`. The existing `bool`
  normalizer stringifies before comparing (`String(0)` → `'0'`), so `0`/`1` already match
  its known tokens. No normalizer change.
- `records_path: "features"` (a plain top-level key, no pagination) — `fetchAll`'s existing
  `pagination`-optional path (defaults to a single page) handled a one-shot feed with no
  change.
- Filtering a boolean field for a specific value used the existing `any_of` operator with
  `"value": [true]`, rather than adding an `equals` operator.

This is the target outcome from SPEC §8.2: an empty log, not a proof that changes were
necessary.

## Verification

- `validateAdapter` → `{ ok: true, errors: [] }`.
- `verifyAgainstFixtures` against 5 real fetched records → `ratio: 1` (5/5), well above
  the 0.8 refuse-to-emit threshold.
- `runIngest` against the fixture (offline, deterministic) → `fetched: 5, parsed: 5,
  fresh: 5`, `canary.status: "ok"`.
- `runIngest` against the **live** endpoint via the CLI (`node src/run.mjs
  adapters/earthquake.usgs.gov.adapter.json`) → exited 0, wrote a real run report.
- Deliberately renamed `properties.mag` → `properties.magnitude` in a copy of the adapter,
  re-ran against the same fixture → `parsed: 0`, `canary.status: "stale"` with breaches
  `min_records` and `required_field_ratio`, process exit 1 (SPEC §8.3, reproducible via
  `scripts/run-earthquake-broken.mjs`).

## Gotchas specific to this source (beyond SPEC §10)

- `www.usgs.gov` (the marketing/docs site) sits behind bot-challenge middleware that
  returns inconsistent status codes and occasional `ECONNRESET` to scripted clients —
  distinct from `earthquake.usgs.gov` (the actual data feed host), which answered
  consistently. Probe the *exact ingestion host*, not its parent domain, when judging
  reachability.
- The feed is a single JSON object with an array under `features`, not a bare array —
  `records_path` must point past the envelope (`"features"`, not `"$"`).
