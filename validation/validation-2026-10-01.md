# Validation: @shrinivas-sn/adapter-ingestion

Date: 2026-10-01 · Subject: `E:\adapter-ingestion` (branch `feat/github-advisories-adapter`, v0.2.0 on npm)

## Verdict

**KEEP AS PERSONAL TOOL** — The owner relies on it in two active Node projects, where it fits better than the Python/hosted tools that already serve everyone else, but no one outside uses it yet.

Top 3 reasons:
1. **Real, current own use.** `model-bench` (`^0.2.0`, last commit 2026-09-30) and `govt-job-platform` (`^0.1.0`, last commit 2026-09-28) both import `runIngest`. The owner's `generate-adapter` skill and `dev-recipes` template are also built on it [S1, S2, S3]. The owner says they use it for most of their personal work.
2. **Others are already served.** dlt's REST API source covers the core job: declarative config, paginators, incremental cursors, and `primary_key` + `merge` dedupe. It ran here, and three runs left 14 rows with 14 distinct ids [S6, local:H1]. Huginn, Airbyte's declarative CDK and Spidermon cover the polling, connector and monitoring parts. All of them are maintained and far more widely adopted [S4–S12].
3. **It fits the owner's stack better than any of them.** It is Node-native with zero runtime dependencies, and stores data in a flat JSONL file that works on GitHub Actions cron. Its built-in canary checks for zero records, a drop in count, required-field ratio and staleness. dlt's schema contracts catch structural changes only, not empty or collapsing data [S7]. The no-DB, no-Python setup matters to this owner. Nothing shows that it matters to anyone else.

## Builder's goal

- Goal: **personal tool**. The owner said in this run that they use the package for most of their personal work. The README frames it as "keeps any app supplied", which is a product-for-others framing, but the evidence below supports personal tool.
- Own use (how the builder uses it, with evidence):
  - `E:\model-bench\package.json` depends on `^0.2.0`. `ingestion/run-all.mjs` runs 5 adapters through `runIngest` (artificial-analysis, livebench-cost, livebench-scores, openrouter, terminal-bench) [S1].
  - `E:\govt-job-platform\ingestion\package.json` depends on `^0.1.0`. Its `src/run.mjs` imports `runIngest`, `readLatestRecords` and `applyFilter` [S2].
  - The owner's `generate-adapter` Claude skill and the `dev-recipes/generated-adapter-ingestion/templates` template both target it [S3].
  - Commits are steady: 46 commits from 2026-08-28 to 2026-10-01 across 6 active days, and 3 npm versions [S13, S14].
- Would an existing tool do the builder's job with less effort than maintaining this?
  - **For a new project, partly yes.** dlt + duckdb gives pagination, incremental loading, merge-dedupe and HTTP retries for free.
  - The cost is a Python runtime and a database inside Node/Next.js projects. dlt also has no zero-record or count-drop canary, so the owner would rebuild that part anyway.
  - **For the two existing projects, no.** Switching means rewriting their adapters and the code around them (`fetch-guard.mjs`, `canary-baseline.mjs`, the CSV transforms) into Python.

## What it actually is

- Problem it solves: unattended, scheduled pulls of records from a JSON HTTP endpoint into a local store. It skips unchanged records and raises an alert when the source silently changes shape or stops returning data.
- Who it is for: a Node developer (in practice the owner) feeding small personal apps from cron jobs, typically on GitHub Actions.
- What it does (from the code):
  - Validates a JSON adapter config (`src/config.mjs`).
  - Fetches over **HTTP GET only**, with optional `page-param` pagination, a timeout and size caps (`src/fetch.mjs`, `src/http.mjs`).
  - Parses the body as JSON only: `http.mjs:54` calls `JSON.parse(text)`.
  - Maps fields by dot-path through 4 normalizers: `text`, `number`, `iso-date`, `bool` (`src/extract.mjs`, `src/normalize.mjs`).
  - Hashes the content and splits records into fresh, changed and unchanged (`src/dedupe.mjs`).
  - Appends to a JSONL store behind a file lock (`src/store.mjs`, `src/lock.mjs`).
  - Writes one atomic run report per invocation (`src/report.mjs`).
  - Runs a canary for `min_records`, `count_drop_ratio` (trailing median), `required_field_ratio` and `staleness` (`src/canary.mjs`).
  - Offers a declarative read-time filter (`src/filter.mjs`).
  - Size: about 2,400 lines in `src/`, with no runtime dependencies (`package.json` lists only `devDependencies`).
- Claims not backed by the code:
  - **"from websites that have no API"** (README line 3, `package.json` description, keyword `web-scraping`). The code accepts exactly one source kind: `KINDS = new Set(['json-api'])` (`src/config.mjs:7`). It can only reach "no-API" sites through a hidden JSON endpoint, as in the `karnatakacareers` adapter on `/wp-json/wp/v2/posts`, or through a caller-written `fetchImpl` that turns other formats into JSON. `model-bench/ingestion/sources/livebench.mjs` does exactly that for CSV and says so in a comment: "adapter-ingestion is JSON-only by design" [S1].
  - **"A canary flags a stale adapter — loudly"** only holds when `runs/` history persists between runs. On a fresh CI checkout, `count_drop_ratio` never has history. `govt-job-platform/ingestion/src/canary-baseline.mjs` records that the check "has never actually been able to fire on the real schedule" and adds a git-tracked baseline to work around it [S2].
  - *Correction (same day):* `govt-job-platform/ingestion/src/fetch-guard.mjs` adds bounded retry and a pagination-truncation signal [S2], but it was written against 0.1.x. **0.2.0 already has both**: `RETRYABLE_STATUSES` with exponential backoff and `Retry-After` (`src/fetch.mjs:46-68`), and `W_PAGE_LIMIT` / `allow_truncation` (`src/fetch.mjs:58,259-267`). This is an upgrade gap in that project, not a gap in the package.

## Is the problem real?

| Evidence of the pain | Source (URL, date) |
|---|---|
| A scraper was "green for eleven weeks", then 40% of products turned out to have no price; decisions had been made on bad data for a week | https://dev.to/votiakov/your-scraper-isnt-broken-the-site-changed-and-it-didnt-tell-you-ba (accessed 2026-10-01) [snippet] |
| A congressional-trading scraper "was quietly losing half its data" while runs finished green | https://dev.to/fatihbuilds/my-congressional-trading-scraper-was-quietly-losing-half-its-data-4hog (accessed 2026-10-01) [snippet] |
| "HTTP 200 is a lie": the author hand-wrote a 30-line drift canary (missing key, wrong type, empty, unexpected key, drift ratio), published 2026-05-30 | https://dev.to/0012303/http-200-is-a-lie-a-30-line-schema-canary-for-source-drift-4m74 (accessed 2026-10-01) |
| Paid Apify actors exist only to detect silent scraper failure and dataset drift, which shows people will pay for this | https://apify.com/broomwagon/scraper-output-monitor, https://apify.com/checksmithcats/dataset-drift-monitor (accessed 2026-10-01) [snippet] |
| The owner's own pain: `govt-job-platform` found its count-drop canary had been silently dead in production | local: `head -15 E:/govt-job-platform/ingestion/src/canary-baseline.mjs` |
| No posts found asking for a **Node** declarative JSON-ingestion library specifically. Searches for one returned only Python (dlt) results | WebSearch "npm declarative REST API extract load library typescript … alternative to dlt" (2026-10-01): none found |

## Competitors

| Tool | What it does | License | Free? | Last release | Adoption | Same goal? | Source |
|---|---|---|---|---|---|---|---|
| dlt — REST API source (Python) | Declarative REST extraction with paginators, incremental cursors, `primary_key` + `merge` dedupe, many destinations (duckdb, filesystem…); schema contracts freeze on structural change | Apache-2.0 | yes | 1.30.0, 2026-08-11 (PyPI); push 2026-09-30 | 5,919 stars; PyPI downloads unavailable (pypistats 500/429) | **partial**: same job, maintained, free; Python plus a destination; no zero-record/count-drop canary | S6, S7, S8 |
| Airbyte declarative (low-code) CDK | YAML-manifest connectors with pagination, incremental sync and dedupe; runs via the Airbyte platform or PyAirbyte | MIT (CDK) | yes (OSS) | airbyte-cdk 7.32.0, 2026-09-28 | 27 stars (CDK repo); the Airbyte platform is far larger | partial: much heavier setup, aimed at data teams | S8, S9 |
| Singer `tap-rest-api-msdk` | Generic config-driven REST tap for Singer/Meltano | Apache-2.0 | yes | 1.4.2, 2025-04-22 | 26 stars | no: **not maintained** (no release in the last 12 months) | S8, S9 |
| Huginn — Website Agent | Self-hosted agents that poll JSON/HTML on a schedule, extract with JSONPath, dedupe (`mode: on_change`, `uniqueness_look_back`), and flag "not working" if no event arrives within `expected_update_period_in_days` | MIT | yes (self-host) | v2026.09.22, 2026-09-21 | 50,017 stars | **partial**: closest on goal (personal feeds and alerts) but a Rails app plus database, not a library | S4, S9 |
| Spidermon (Scrapy) | Monitors scraper output: item counts, field coverage, validation, alerts | BSD-3-Clause | yes | 1.27.0, 2026-08-10 | 562 stars | partial: covers the canary half only, and only for Scrapy (Python) | S8, S9 |
| changedetection.io | Watches pages and JSON (with filters) for changes and sends notifications | Apache-2.0 | yes (self-host); paid hosted | 0.60.8, 2026-09-28 | 34,723 stars | no: change alerts, not record ingestion into a store | S9 |
| n8n | Workflow automation: cron + HTTP node + dedupe ("Remove Duplicates" across executions) | Sustainable Use License (fair-code, `NOASSERTION` on GitHub) | free self-host, with restrictions | n8n@2.41.5, 2026-10-01 | 206,432 stars; 439,851 npm downloads/month | partial: can do the job visually; not a library, and the license is not OSI | S9, S10 |
| Node-RED | Flow-based automation; cron inject + HTTP request + `node-red-contrib-jsondeduplicate` | Apache-2.0 | yes | 5.0.7, 2026-09-08 | 23,699 stars; 215,585 npm downloads/month | partial: runtime/editor, not an embeddable library; no canary | S9, S10, S11 |
| RSSHub | Node routes that turn no-API sites into RSS feeds | AGPL-3.0 | yes | no GitHub release (404); push 2026-10-01 | 46,387 stars | no: produces feeds, not a record store or canary; AGPL | S9 |
| Apify Scraper Output Monitor / Dataset Drift Monitor | Hosted actors that check scraper output for drift, empty fields and volume collapse | proprietary actors | paid platform (free tier) | unavailable (Apify store page not fetched) | unavailable | no: hosted, not free/OSS | S12 [snippet] |

Same goal = same problem, same users, free, maintained. Mark yes / partial / no.

## Hands-on check

- Tool run: dlt 1.30.0 REST API source → duckdb, in a scratch venv (Python 3.13.5).
- Command (`scratchpad/dlt_usgs.py`, run with `dltvenv/Scripts/python dlt_usgs.py`):
  ```python
  rest_api_source({"client": {"base_url": "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/"},
    "resources": [{"name": "quakes", "primary_key": "id", "write_disposition": "merge",
      "endpoint": {"path": "4.5_day.geojson", "data_selector": "features", "paginator": "single_page"}}]})
  dlt.pipeline(pipeline_name="usgs_probe", destination="duckdb", dataset_name="probe").run(src)
  ```
- Result (local:H1, 2026-10-01):
  - First attempt failed at `step=extract` with `ConnectionResetError(10054)` from USGS. This is the same intermittent reset `NOTES-generalization.md` records for this host.
  - The next three runs succeeded. Each normalized `quakes: 14 row(s)`, and `select count(*), count(distinct id)` returned `(14, 14)` every time, so merge-dedupe works.
  - dlt also split `geometry.coordinates` into a child table, `quakes__geometry__coordinates` with 42 rows.
  - Setup took about 2 minutes (venv + `pip install "dlt[duckdb]"`) and 13 lines of config.
  - dlt did **not** report fresh/changed/unchanged counts or any health signal for an empty or collapsing source. The package's run report does both.

## Differentiator

- What this does that the best match (dlt) does not:
  - Health checks in every run: `min_records` (an empty batch counts as a failure), a trailing-median `count_drop_ratio`, `required_field_ratio`, and date `staleness`. Every run writes an atomic report, even one that crashed. dlt's schema contracts raise only on new tables, new columns or type changes; per its docs they do not detect empty results or rising nulls [S7].
  - Node-native, embeddable, zero runtime dependencies. The store is a JSONL file, with no database or Python. That suits the owner's Node/Next.js projects on GitHub Actions.
  - Fresh/changed/unchanged split by content hash, a declarative read-time filter, and a strict host↔URL provenance check.
- Evidence that users care about that difference:
  - The canary half is a real, widely reported pain (see the table above).
  - "Node, no DB, no Python" matters to the owner and is shown by their two projects.
  - **No evidence that anyone else wants this as a library.** No outside users, issues or stars were found (see Switching and reach).

## Switching and reach

- Cost for a user to switch from today's tool:
  - From dlt/Airbyte: a language change, Python to Node, plus losing destinations, auth, POST and nested-table handling. For anyone already in Python, it is high and unjustified.
  - From hand-written Node fetch scripts: low, since you write one adapter JSON and call `runIngest`.
- How users would find this:
  - Only npm search: keywords `web-scraping`, `ingestion`, `adapter`, `etl`, `cron`, `json-api`.
  - The GitHub repo `shrinivas-sn/adapter-ingestion` is **private** (`gh api` reports `private: true`, 0 stars, 0 forks, 0 issues), so the npm page's repository link does not resolve for others [S14].
  - It is not listed on any awesome-list.
- Own adoption so far:
  - 493 npm downloads from 2026-08-31 to 2026-09-29 [S13].
  - In that window the owner published 0.1.0/0.2.0 and ran CI installs for two dependent projects. Registry mirrors also download new packages. So this figure is **not** evidence of outside users [assumption].
  - No external issues, stars or dependents were found.

## Risks

- Legal / terms / licensing:
  - The package is MIT, with no issue there.
  - Each adapter's source carries its own terms. The repo handles this per source; see the legal gate in `NOTES-generalization.md`.
  - Scraping hidden JSON endpoints, such as `wp-json`, sits in a grey area that depends on each site's ToS.
- Dependency on outside services:
  - None at runtime beyond the sources themselves.
  - Release publishing depends on npm OIDC trusted publishing, which has a known scoped-package E404 issue (README: npm/cli#8976).
- Maintenance load:
  - Moderate and already visible. `govt-job-platform` is still on `^0.1.0`, which semver will not move to 0.2.x, so the owner already maintains two versions in production.
  - Both dependent projects carry their own patch code: canary baseline persistence (`canary-baseline.mjs`) and CSV→JSON transforms (`livebench.mjs`, `csv.mjs`) are gaps the package still leaves open. The retry wrapper (`fetch-guard.mjs`) is covered by 0.2.0 and becomes obsolete once that project upgrades.
  - Treating this as a public product would add support for issues, docs and more source kinds on top.

## If the verdict holds, next step

- **KEEP AS PERSONAL TOOL — invest only in what the owner needs.** Scope v0.3.0 (`RFC-0.3.md`) to gaps the owner's own projects have already hit and patched around:
  1. **Canary history on stateless CI.** Make `count_drop_ratio` work without a persistent `runs/`, either through a small baseline the caller can store or an injectable history source. This upstreams `govt-job-platform/ingestion/src/canary-baseline.mjs`.
  2. ~~Bounded retry with backoff~~: already in 0.2.0 (`src/fetch.mjs:46-68`). Instead, upgrade `govt-job-platform` (item 4) and delete its `fetch-guard.mjs` retry once its tests pass.
  3. **A documented transform hook for non-JSON input (CSV).** It would replace the `fetchImpl` workaround in `model-bench`, but per `plan.md` §11, add it only once 2 real sources need it. model-bench's livebench scores and cost CSVs are both one site, so they count as one.
  4. Move `govt-job-platform` to `^0.2.0` so only one version is in production.
  5. Narrow the README/`package.json` wording from "websites that have no API" to "JSON-over-GET sources (including hidden JSON endpoints)". The claim is wider than the code.
- Defer anything aimed at outside users: a public repo, awesome-list submission, auth/POST/HTML extraction. There is no evidence of demand. Revisit only if outside users appear.

## Sources

| # | URL or local command | Accessed | Note ([snippet] / [assumption] if applicable) |
|---|---|---|---|
| S1 | local: `grep -n adapter-ingestion E:/model-bench/package.json`; `sed -n 1,25p E:/model-bench/ingestion/sources/livebench.mjs`; `git -C E:/model-bench log -3` | 2026-10-01 | own use; JSON-only workaround |
| S2 | local: `grep -n adapter-ingestion E:/govt-job-platform/ingestion/package.json E:/govt-job-platform/ingestion/src/run.mjs`; `head -15 …/fetch-guard.mjs …/canary-baseline.mjs`; `git -C E:/govt-job-platform log -3` | 2026-10-01 | own use; canary-history gap; retry wrapper predates 0.2.0 |
| S3 | local: `grep -rl --include=package.json adapter-ingestion E:/` (dev-recipes template, model-bench, govt-job-platform) | 2026-10-01 | own use |
| S4 | https://github.com/huginn/huginn/blob/master/app/models/agents/website_agent.rb | 2026-10-01 | JSONPath, modes, `working?` |
| S5 | local: `cat src/config.mjs | grep KINDS`; `grep JSON.parse src/http.mjs` | 2026-10-01 | code scope |
| S6 | https://dlthub.com/docs/dlt-ecosystem/verified-sources/rest_api/basic | 2026-10-01 | dlt REST API features |
| S7 | https://dlthub.com/docs/general-usage/schema-contracts | 2026-10-01 | freeze mode; no empty/null-ratio detection |
| S8 | local: `curl https://pypi.org/pypi/{dlt,airbyte-cdk,spidermon,tap-rest-api-msdk}/json`; pypistats.org returned 500/429 | 2026-10-01 | release dates |
| S9 | local: `gh api repos/{dlt-hub/dlt,airbytehq/airbyte-python-cdk,scrapinghub/spidermon,huginn/huginn,n8n-io/n8n,node-red/node-red,DIYgod/RSSHub,dgtlmoon/changedetection.io,Widen/tap-rest-api-msdk}` and `/releases/latest` | 2026-10-01 | license, stars, last push/release |
| S10 | local: `curl https://api.npmjs.org/downloads/point/last-month/{n8n,node-red}` | 2026-10-01 | npm downloads |
| S11 | https://flows.nodered.org/node/node-red-contrib-jsondeduplicate | 2026-10-01 | [snippet] |
| S12 | https://apify.com/broomwagon/scraper-output-monitor, https://apify.com/checksmithcats/dataset-drift-monitor | 2026-10-01 | [snippet] |
| S13 | local: `curl https://api.npmjs.org/downloads/point/last-month/@shrinivas-sn%2Fadapter-ingestion`; `curl https://registry.npmjs.org/@shrinivas-sn%2Fadapter-ingestion` | 2026-10-01 | 493 downloads; versions 0.0.0/0.1.0/0.2.0 |
| S14 | local: `gh api repos/shrinivas-sn/adapter-ingestion`; `git log --format=%ad --date=short | sort | uniq -c` | 2026-10-01 | private repo, 0 stars; 46 commits |
| S15 | https://dev.to/0012303/http-200-is-a-lie-a-30-line-schema-canary-for-source-drift-4m74 | 2026-10-01 | pain evidence, published 2026-05-30 |
| S16 | https://dev.to/votiakov/your-scraper-isnt-broken-the-site-changed-and-it-didnt-tell-you-ba; https://dev.to/fatihbuilds/my-congressional-trading-scraper-was-quietly-losing-half-its-data-4hog | 2026-10-01 | [snippet] |
| S17 | WebSearch: "declarative JSON config REST API ingestion pipeline incremental dedupe library"; "detect when scraped data source changes shape schema drift alert cron scraper"; "node.js poll JSON API on cron store new items deduplicate append jsonl"; "npm declarative REST API extract load library typescript … alternative to dlt" | 2026-10-01 | problem-phrased searches; no Node equivalent of dlt found |
| H1 | local: `scratchpad/dltvenv/Scripts/python dlt_usgs.py` (4 runs: 1 ECONNRESET, 3 × `(14, 14)`) | 2026-10-01 | hands-on |
