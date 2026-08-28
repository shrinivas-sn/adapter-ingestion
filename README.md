# adapter-ingestion

Keeps any app supplied with fresh records from websites that have no API. An adapter is
generated once by an LLM; a plain-rules runner applies it on every cron at zero cost. A
relevance filter is a read-time view over stored records, never a write-time gate. A
canary flags a stale adapter — loudly — when a source changes shape.

Full design authority: `E:\dev-recipes\SPEC-generated-adapter-ingestion.md`.

## Flow

```
  generator (once, per source)  ->  adapter file
                                        |
  fetch -> extract -> dedupe -> store  (the framework)
                                        |
                                   RECORD CONTRACT   <-- the framework stops here
                                        |
                            filter (a read-time view)
                                        |
                                  ( consuming app )   store/analyze/recalculate/notify
```

The framework never decides what the data is for. Storing into an app's domain model,
analytics, recalculation, and notification are the consuming app's job.

## Adding a source

1. Run the `generate-adapter` skill (`~/.claude/skills/generate-adapter/SKILL.md`) against
   the target site. It writes `adapters/<HOST>.adapter.json` and
   `fixtures/<HOST>/sample-*.json`, refusing to emit if fixture verification falls below
   an 0.8 parse ratio.
2. `node src/run.mjs adapters/<HOST>.adapter.json` to run it. A `runs/<HOST>/report-*.json`
   is written every run; a stale canary exits non-zero.

## Writing a filter

A filter (`filters/<NAME>.filter.json`) is declarative data, never code — see
`filters/example.filter.json` and `filters/earthquakes-significant.filter.json` for real
examples. `mode: "all"` ANDs its rules, `"any"` ORs them. Operators: `any_of`, `none_of`,
`between`, `gte`, `lte`, `within_days`, `after_date`, `includes_any`, `excludes_any`,
`exists`. A rule on a missing field fails by default, except `none_of`/`excludes_any`/
`exists:false`, which pass — absence is not a match, but it is the absence of a
disqualifier.

Apply one with `applyFilter(records, filterDef, now)` from `src/filter.mjs` over records
read from the store (`readRecords`, `src/store.mjs`) — this is a read-time view, never
baked into ingestion.

## Reading a run report

`runs/<HOST>/report-*.json`: `stages.{fetched,parsed,fresh,changed,unchanged}`,
`error_count`/`errors` (up to 20, each `{ index, missing }`), `duration_ms`. Check
`canary.status` — `"stale"` means the adapter needs regeneration; `breaches` names which
threshold from the adapter's `canary` config tripped (`min_records`,
`required_field_ratio`, `count_drop_ratio`).

## Verifying a new or changed adapter manually

`scripts/verify-earthquake-adapter.mjs` and `scripts/run-earthquake-offline.mjs` are
reusable patterns (not project-specific despite the name) for checking an adapter against
its fixtures and running the full pipeline offline before ever hitting the network.
`scripts/run-earthquake-broken.mjs` is the canary regression check — copy this pattern
whenever adding a new source, pointed at the new adapter/fixture.

## Gotchas

- **`undefined` must never reach the store.** A missing value is `null`, consistently. An
  `undefined` field silently rejects an entire write in some document stores.
- **A missing datastore security rule fails silently** in some backends, rendering as a
  normal empty state rather than an error — verify rules explicitly in the consuming app.
- **UA-only bot gating** shows up as a 403 with a default agent, 200 with a browser UA —
  probe both during generation; it becomes a named test, not a comment.
- **A cron job with no run-report artifact fails invisibly for weeks.** `writeReport` runs
  every invocation, success or failure — never skip it.
- **A parent marketing domain and its actual data-feed subdomain can behave completely
  differently** under bot-challenge middleware. Probe the exact ingestion host, not
  wherever `robots.txt` happened to be easiest to find.
- **Publishing derived data:** keep provenance on every record, deep-link to
  `source_url`, never mirror wholesale, and state the derived license against the
  source's — public-domain source data does not make a downstream product's license
  decisions for it.
- **A source field that doesn't fit an existing normalizer structurally** (epoch
  milliseconds instead of a date string, `0`/`1` instead of `yes`/`no`) often already
  passes through an existing normalizer unchanged — check before adding one. See
  `NOTES-generalization.md`.

## Non-goals

Not a general-purpose scraper, not a dashboard/analytics/storage product, not a hosted
service. Doesn't own what a consuming app does with ingested data. No cross-source fuzzy
dedupe (within-source only, v1). No unattended LLM regeneration — a stale canary alerts;
a human re-runs the generator.
