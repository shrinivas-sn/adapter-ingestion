# Upgrading

One section per minor version, newest first. Each section has the same three parts:

- **Free with no changes:** what you get just by bumping the version.
- **Opt in:** new capabilities, each with the one change that turns it on.
- **Action needed:** what you must change. This is only ever a removal after its
  deprecation window (see [VERSIONING.md](VERSIONING.md)), with a migration guide.

On 0.x, npm never moves you across a minor version by itself (`^0.3.0` stops before
0.4.0), so bump the range in `package.json` yourself, or let a bot do it.

**Dependabot** (`.github/dependabot.yml`), with `increase` so the range itself is raised:

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    versioning-strategy: "increase"
```

[Renovate](https://docs.renovatebot.com/) also opens pull requests for new versions; see its
docs for range handling.

After bumping, read `notices` in the first run report, or run
`npx adapter-ingestion doctor <adapter.json>`.

## 0.9 → 0.10

### Free with no changes

- Nothing changes for valid adapters, records, stores or reports.
- `doctor` now checks `cheerio` for `feed` adapters too. It exits 2 when `cheerio` is
  missing, as `run` already failed for that setup.
- An upper-case `host` now also says "host must be lower case". Such an adapter never
  passed validation.
- `explain` knows the four `W_*` warning codes.
- The JSON Schema accepts `HTTPS://` URLs, and flags an upper-case `host`, numbers above
  2^53 − 1 and `records_path` on html `select` adapters, as the engine does.
- README has full adapter key and run report references.

### Opt in

- `adapter-ingestion --version` prints the installed version (`--json`: `{"version": …}`).
- New TypeScript type names: `AdapterFetch`, `AdapterCanary`, `AdapterHtml`, `MapRule`,
  `HeaderRef`.

### Action needed

- None for JavaScript.
- TypeScript only: report fields such as `failure.stage` and `fetch.stop_reason` are now
  unions, and adapter sections are typed, so code that compares a field with a value it can
  never hold, or builds an adapter literal with an unknown key, now fails to compile. Both
  were already wrong at run time. `html` is now a union on `mode`: check `html.mode` before
  reading `rows`, `fields` or `script`.

## 0.8 → 0.9

### Free with no changes

- Nothing changes for existing adapters.
- A kind you registered yourself as `feed` keeps being used exactly as before; the new
  built-in `feed` applies only when no kind of that name is registered.
- The "not supported by this engine" message now lists `feed` among the supported kinds.

### Opt in

- `access.kind: "feed"` reads an RSS 2.0, RSS 1.0 or Atom feed: one record per item, with
  the keys `id`, `url`, `title`, `summary`, `content`, `published`, `updated`, `author` and
  `categories` whatever the format. Dates are converted to ISO 8601 UTC. Needs the optional
  `cheerio` package, as `html` does. See README "Source kinds".
- If you read feeds through the `html` kind or a parser of your own, one `feed` adapter can
  replace it. Check one run first: record ids come from `guid`/`id`, so the store starts
  new records under the new ids.

### Action needed

- None.

## 0.7 → 0.8

### Free with no changes

- Nothing changes for existing adapters.
- A kind you registered yourself as `csv` keeps being used exactly as before; the new
  built-in `csv` applies only when no kind of that name is registered.
- The "not supported by this engine" message now lists `csv` among the supported kinds.

### Opt in

- `access.kind: "csv"` reads a CSV file with a header row: one record per row, cells as
  strings, empty cells as `null`. No extra package needed. See README "Source kinds".
- `{ "template": "..." }` in place of `path` in a `map` rule builds a value from several
  fields, such as `"{entity}:{year}"` or `"https://example.org/item/{id}"`. A missing value
  makes the field `null`. Useful for any kind, and needed for a CSV with no URL column.
- To move a parser you registered as `csv` onto the built-in, drop it from `kinds`. Check
  one run first: cells become `null` when empty, and the built-in is strict about quoting.

### Action needed

- None.

## 0.6 → 0.7

### Free with no changes

- Nothing changes for existing adapters; `iso-date` output is the same.

### Opt in

- `"normalize": "iso-datetime"` keeps the time and returns UTC
  (`2026-10-19T15:23:15.000Z`). Switching an existing field changes its stored value, so
  every record shows as changed once, and the fingerprint changes (`count_drop_ratio`
  starts a new history).
- `"assume_zone": "Z"` on an `iso-datetime` rule reads a time with no zone as UTC. Use it
  only when the source documents UTC (WordPress `date_gmt`).

### Action needed

- None.

## 0.5 → 0.6

### Free with no changes

- Nothing changes for existing adapters.

### Opt in

- Read a secret header from an environment variable:
  `"headers": { "x-api-key": { "env": "MY_API_KEY" } }`. An unset or empty variable fails
  the run with the new `E_HEADER_ENV` (exit 2); add `"optional": true` to send no header
  instead. If you wrapped `fetchImpl` only to add a key, you can drop the wrapper. Moving a
  literal header value into a reference changes the adapter fingerprint once
  (`count_drop_ratio` starts a new history).

### Action needed

- None.

## 0.4 → 0.5

### Free with no changes

- New advice notice `A_TOP_LEVEL_KEY_TYPO`. A top-level key one edit away from `fetch`,
  `records_path`, `required` or `canary` (such as `record_path` or `canry`) used to be
  ignored without a word. `doctor` and every run report of a valid adapter now name it and
  the key it probably meant. Like every notice, it never changes `outcome` or an exit code;
  in text mode it prints on stderr.
- Fixing a flagged key turns that setting on, so the next run can differ (for example,
  `required` starts rejecting records that miss a field). The adapter fingerprint also
  changes, so `count_drop_ratio` starts a new history.

### Opt in

- Start your own top-level metadata keys with `_` (`_notes`): they are never flagged, and no
  release will give them a meaning.

### Action needed

- None.

## 0.3 → 0.4

### Free with no changes

- Every run report has a new `notices` array: advice (`A_*`) about what this version offers
  your adapter, and deprecations (`D_*`). Notices never change a run's outcome or exit code.
  `report_version` stays `2`. The first advice code is `A_CANARY_NO_HISTORY`: the
  `count_drop_ratio` check had no past runs to compare with.
- TypeScript types for every subpath, plus type exports (`RunIngestOptions`, `Report`,
  `Notice`, ...) from the root module. The runtime is unchanged plain JavaScript.
- New docs shipped in the package: `AGENTS.md` (recipes for coding agents), `llms.txt`,
  `VERSIONING.md` (what each release may change) and this file.

### Opt in

- **Canary history on CI:** set `paths.historyFile` (for example
  `store/<host>.history.jsonl`) and commit it with the store, so `count_drop_ratio` works
  when `runs/` does not survive between runs. See the README section "Canary history on CI".
- **Command line:** `npx adapter-ingestion validate|run|explain|doctor`, each with
  `--json`. `doctor --check-updates` tells you when a newer version is out.
- **Editor support for adapters:** add
  `"$schema": "./node_modules/@shrinivas-sn/adapter-ingestion/schema/adapter.schema.json"`
  to an adapter. It does not change the adapter's fingerprint, so canary history is kept.

### Action needed

None.

## 0.2 → 0.3

### Free with no changes

- Existing JSON adapters behave identically; `json-api` parses exactly as before.
- The core still has no runtime dependencies.
- An unknown kind or unknown key now says the adapter may need a newer engine version.

### Opt in

- **HTML pages:** `access.kind: "html"` with an `html` block, in `select` mode (CSS
  selectors to one record per row) or `script_json` mode (the JSON inside a `<script>`,
  such as JSON-LD or `__NEXT_DATA__`). Install the optional peer first:
  `npm install cheerio`.
- **Your own formats:** the `kinds` option on `runIngest`, `fetchAll` and `validateAdapter`
  registers a custom parser that gets every transport guarantee (timeouts, byte caps,
  retries, pagination checks, the canary).

### Action needed

None. New error codes: `E_PARSE`, `E_PARSE_NO_MATCH`, `E_KIND_DEPENDENCY`.

## 0.1 → 0.2

See [MIGRATION-0.2.md](MIGRATION-0.2.md).
