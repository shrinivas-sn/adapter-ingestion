# adapter-ingestion

Keeps any app supplied with fresh records from websites that have no API. An adapter is a
small JSON config generated once per source; a plain-rules runner applies it on every cron
at zero LLM cost. A relevance filter is a read-time view over stored records, never a
write-time gate. A canary flags a stale adapter — loudly — when a source changes shape.

Published to npm as [`@shrinivas-sn/adapter-ingestion`](https://www.npmjs.com/package/@shrinivas-sn/adapter-ingestion).
Requires **Node 22.15.0 or newer**. Upgrading from 0.1.x? See [MIGRATION-0.2.md](MIGRATION-0.2.md).

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

**The published package ships only the generic engine** (`src/`, plus this README and
`MIGRATION-0.2.md`) — no adapters, fixtures, or scripts. You bring your own adapter JSON
and call `runIngest` against it from your own code.

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

## API

Every function below has a stable input/output/error contract. `error.code` is always one
of the `E_*` constants named per function.

**Root (`@shrinivas-sn/adapter-ingestion`)**
- `runIngest({ adapter, paths, since, fetchImpl, signal, now = new Date(), store })` →
  `Promise<{ report, canary }>` on success (including a `stale` canary — that's not a
  failure). Rejects with an `IngestionError` (`err.code`, `err.message`, `err.report`) on a
  config, transport, storage, lock, cancellation, or reporting failure. `paths.storeFile`/
  `paths.runsDir` are required nonempty strings. `since` (a `YYYY-MM-DD` string) switches to
  incremental mode and requires `adapter.fetch.incremental` to be configured. `signal` (an
  `AbortSignal`) cancels an in-flight fetch/wait; a cancellation that lands after the store
  append already committed does not roll back that commit.

**`/adapter`**
- `validateAdapter(adapter)` → `{ ok: boolean, errors: string[] }`. Never throws.
- `verifyAgainstFixtures(adapter, fixtureItems)` → `{ total, parsed, ratio, fieldFailures }`
  — run this against real fetched samples before trusting a generated adapter.

**`/store`**
- `readRecords(filePath, { maxLineBytes, onWarning }?)` → `Promise<Record[]>` — every
  historical revision, in file order. A missing file resolves to `[]`, never throws.
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

**`/fetch`**
- `fetchAll(adapter, { since, fetchImpl = fetch, signal }?)` → `Promise<{ items, pages,
  statuses, diagnostics }>`. `fetchImpl` must resolve with a real `Response`.

**`/canary`**
- `checkCanary(report, history, cfg, { now = new Date() }?)` → `{ status: 'ok'|'stale',
  breaches: string[], skipped: [{check, reason}] }`.

**`/report`**
- `buildReport({ ... })` → the v2 report object (see MIGRATION-0.2.md for the full shape).
- `writeReport(dir, report)` → `Promise<string>` (the written file's path). Publishes
  atomically (temp file + rename); a crash mid-write never leaves a half-written report at
  the final name.
- `readHistory(dir, limit = 5)` / `readEligibleHistory(dir, limit, isEligible?)` →
  `Promise<Report[]>`, newest first, skipping malformed/legacy-shaped files.

**`/contract`**
- `buildRecord({ host, sourceId, sourceUrl, fields, raw, fetchedAt })` → a record (throws
  `E_RECORD_INVALID` on an invalid identity/URL/timestamp/field value).
- `contentHash(fields)`, `canonicalize(value)`, `isValidSourceId(v)`, `isValidSourceUrl(v)`.

**`/extract`**
- `extractAll(rawItems, adapter, { fetchedAt })` → `{ records, errors, errorCount,
  fieldFailures }`. `errorCount` is always the true total; `errors` is capped at 20 samples.
- `getPath(obj, path)` — own-properties-only dot-path reader (`"$"` = the whole object; a
  numeric segment indexes an array). Never traverses the prototype chain.

**`/normalize`**
- `applyNormalizer(name, value)` — `name` is one of `text`, `number`, `iso-date`, `bool`.
- `isValidDateOnly(value)`.

**`/dedupe`**
- `splitByIndex(records, index)` → `{ fresh, changed, unchanged }`.

## Writing an adapter by hand

`map` entries are `{ path, normalize? }`. `path` is a dot-path into the raw source item
(`"$"` for the item itself, `geometry.coordinates.0` for an array index). `normalize` is
one of `text` (strips HTML, decodes numeric character references, collapses whitespace),
`number`, `iso-date` (validates a real calendar date; returns `YYYY-MM-DD` or `null` —
never a silently-wrapped invalid date), or `bool`. `source_id` and `url` are always
required identity fields, independent of whatever else you list in `required`.

`access.url`'s hostname must equal `adapter.host` (or be a subdomain of it) — this is a
provenance guarantee, not a formality: it's what makes a record's `source_host` trustworthy.

`fetch.pagination` (optional): `{ style: 'page-param', param, per_page?, per_page_param?,
max_pages?, allow_truncation? }`. Hitting `max_pages` on a still-full-looking page is a
hard failure unless `allow_truncation: true`.

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
`canary.status === "stale"`. Full v2 schema: [MIGRATION-0.2.md](MIGRATION-0.2.md).

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
  indefinitely or OOM the runner on a single misbehaving or hostile response.
- **A UA-only bot gate shows up as a 403 with a default agent, 200 with a browser UA** —
  probe both when writing a new adapter.
- **No cross-source fuzzy dedupe** (within-source only, by design — see Non-goals).

## Non-goals

Not a general-purpose scraper, not a dashboard/analytics/storage product, not a hosted
service. Doesn't own what a consuming app does with ingested data. No cross-source fuzzy
dedupe (within-source only, v1). No unattended LLM regeneration — a stale canary alerts; a
human re-runs whatever generated the adapter. No distributed/networked locking — one local
store, one physical lock file, cooperative single-machine exclusion only. No POST/GraphQL/
auth/OAuth (JSON GET only, this release).

---

## Developing this repo

The sections below are about *this* repository's own worked examples, dev tooling, and
release process — none of it is required to use the published package.

This repo carries two worked-example adapters (`adapters/`, `fixtures/`, `filters/`) that
are **not** part of the npm package — `npm pack`'s file allowlist (`package.json`'s
`"files"`) ships only `src/`, `README.md`, `NOTES-generalization.md`, and
`MIGRATION-0.2.md`; verified by `scripts/verify-package.mjs` (packs the real tarball,
installs it into a disposable consumer, and runs a consumer script that imports only the
installed package). The CLI entry point (`node src/run.mjs <adapter.json> [--since
YYYY-MM-DD]`) is this repo's own dev convenience, not a published `bin`/`npx` command —
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

`scripts/verify-earthquake-adapter.mjs` and `scripts/run-earthquake-offline.mjs` are
reusable patterns (not project-specific despite the name) for checking an adapter against
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
