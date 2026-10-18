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
