# Brainstorm: from personal tool to a product other devs install

Date: 2026-10-01 · Branch: `feat/github-advisories-adapter` · Baseline: `0.2.0` on npm (`face358`)
Status: **draft verdict, waiting for the owner's decisions** (see "Open decisions" at the end).
Inputs: the owner's wishlist (this session), `RFC-0.3.md`, the gaps in `STATUS.md`,
`validation/validation-2026-10-01.md`, and the two real consumers (`govt-job-platform`,
`model-bench`).

## Verdict

**Build it into a product, in steps, with upgrades before features.**

1. **The upgrade story is only half built.** Today an upgrade is safe, but it does nothing
   useful by itself and is easy to miss. That is the first thing to fix. Every feature added
   later reaches users through upgrades, so this foundation must come first.
2. **The goal should be "one-stop for the scheduled ingestion job", not "one-stop for all
   data needs".** The job is fetch, store, health check, alert. Everything else gets a clean
   extension point instead of built-in code. Breadth at dlt or Airbyte scale would take
   years and would break the zero-dependency core.
3. **Devs, AI agents and non-coders are served by the same thing:** a package that
   describes itself. That means types, a JSON Schema for adapters, a CLI with JSON output,
   error codes you can look up, and an agent guide shipped inside the package. A non-coder
   is served through their AI agent, not through a GUI.
4. **The two-real-sources rule (`plan.md` §11) still applies to every new capability.**
   Platform features such as types, CLI, schema and upgrade tooling are not source
   capabilities, so they are not gated by it. They are gated by real consumer evidence
   instead.

Proposed sequence: **0.3.0 self-describing and upgrade-safe → 0.4.0 extension points →
0.5.0 ecosystem → 1.0.0 frozen contract.** Details are below.

---

## Wishlist item 1: what happens when I release a new version?

### Honest answer: partly thought through, not finished

**What already exists (verified in code):**

| Mechanism | Where | What it gives a consumer |
|---|---|---|
| Semver + Changesets + CHANGELOG | `.changeset/`, `CHANGELOG.md` | A version number and a written changelog |
| Migration guide per breaking minor | `MIGRATION-0.2.md` | Human-readable upgrade steps |
| Strict adapter validation | `src/config.mjs:41` rejects unknown keys; `:294` requires `version: 1` | A bad or too-new adapter fails loudly before any network call, never silently |
| Versioned report shape | `src/report.mjs:29` `report_version: 2` | Report readers can detect the shape |
| Installed-tarball smoke test | `scripts/verify-package.mjs` | The packed package installs and imports |

**What is missing:**

1. **npm never pushes updates.** A project gets a new version only when someone runs
   `npm update`/`npm install`, or when a bot (Dependabot, Renovate) opens a PR.
2. **In 0.x, a caret range does not cross a minor version.** `^0.2.0` means
   `>=0.2.0 <0.3.0`. So every 0.x minor release needs a manual bump in every consumer.
   This is already happening: `govt-job-platform` is stuck on `^0.1.0` and maintains its
   own copies of features that 0.2.0 already has (`fetch-guard.mjs` retries).
3. **An upgrade does nothing visible.** New capabilities sit unused until the developer
   reads the changelog and edits their adapters by hand. Nothing tells a project "you are
   on 0.4 now, and your adapter could use X".
4. **No per-record store format version.** `contract.mjs:120-125` writes `id`,
   `source_host`, `fetched_at`, `content_hash`, … with no version field. The store is the
   one upgrade risk that holds user data.
5. **No adapter upgrade path.** Adapter `version` is pinned to `1`, and no tool rewrites
   an old adapter into a new shape.
6. **No real-consumer upgrade test before a release.** `plan.md` §11 already names
   "real consumer upgrade evidence" as a 1.0 requirement.
7. **The error for a too-new adapter is misleading.** An adapter that uses a newer field on
   an older engine gets "unknown key (typo?)", not "this needs engine ≥ X".

### How an upgrade should improve a project, not just sit there

Adapters are **JSON data, not code**. This is the package's biggest advantage: the engine
can read a user's adapter and reason about it. That makes these five mechanisms possible:

1. **Notices in every run report** (`report.notices[]`, additive to report v2), with two
   kinds:
   - *Advice* (`A_*`): "field `modified_at` maps a value with a time part through
     `iso-date`, so the time is lost. `iso-datetime` (since 0.4) keeps it."
   - *Deprecation* (`D_*`): "`X` is deprecated since 0.5 and is removed in 1.0. Run
     `adapter-ingestion migrate`."

   After an upgrade, the very next cron run tells the project what is newly available for
   *its own adapters*.
2. **`adapter-ingestion doctor`**: the same rules run offline in the terminal or CI, with
   `--json` output for agents.
3. **`adapter-ingestion migrate`**: a deterministic rewrite of adapter JSON from schema
   version N to N+1. It is a dry run with a diff by default and writes only with `--write`.
   It is built when the first breaking adapter change lands, not before.
4. **Safer defaults reach everyone automatically, under a written policy.** A default may
   change inside a release line only when it is strictly safer (as the 0.2.0 retries were),
   and the change is announced in the changelog's "you get this without changing anything"
   section.
5. **Release gate on real consumers.** Before publishing, install the candidate tarball
   into `govt-job-platform` and `model-bench` and run their test suites. A red consumer
   blocks the release.

Plus documentation for consumers: a Renovate/Dependabot snippet in the README, and a
versioning policy page stating what may change in a patch, a minor and a major.

**Why 1.0 matters for auto-update:** after 1.0, `^1.0.0` takes every 1.x release
automatically. That is real auto-update, but it means every 1.x minor *must* be safe to
take blindly. The mechanisms above are what make that promise keepable. Reaching 1.0
without them would make auto-update dangerous.

---

## Wishlist item 2: a one-stop, self-explaining, scalable, production-grade package

### What `npm install` gives a developer today

- Files in `node_modules/@shrinivas-sn/adapter-ingestion/src/` plus the README.
- **No types**, so the editor shows `any` for everything.
- **No CLI**, so `npx` does nothing.
- **No adapter schema**, so writing adapter JSON means reading the README and guessing.
  An adapter's `$schema` key would currently be *rejected* as an unknown key.
- An AI agent only learns the API if it thinks to open the README inside `node_modules`.
- The adapter-writing skill (`generate-adapter`) is private to the owner's machine.

### How devs and AI agents would learn the package

| Surface | Serves | Notes |
|---|---|---|
| TypeScript `.d.ts` (`types` / `exports.types`) | Editors, TS users, agents | Generated from JSDoc with `tsc --declaration --allowJs`, so the core stays plain `.mjs` |
| `adapter.schema.json` exported from the package | Editors (autocomplete in VS Code via `$schema`), agents, `validate` | The engine must accept a `$schema` key |
| CLI `bin`: `init`, `validate`, `test` (against fixtures), `run`, `doctor`, `explain <E_CODE>` | Humans, CI, agents | Each command takes `--json`; exit codes are stable and documented |
| `AGENTS.md` + `llms.txt` shipped in the tarball | Every coding agent | Task recipes: add a source, debug a stale canary, upgrade, plus the error-code table |
| Public adapter-authoring skill (open-source `generate-adapter`) | Agent users, non-coders through their agent | Installable with the `npx skills` flow the owner already uses |
| `examples/` run in CI | Everyone | Examples cannot rot |

**Non-coders:** the honest answer is that a library cannot be used directly by someone who
does not code. The realistic path is: the non-coder tells their AI agent "track this
source"; the agent uses the skill, the schema and the CLI; then `doctor` and `run` confirm
it works. So the package's job is to be **unambiguous to an agent**. A GUI or hosted
service is out of scope (see Non-goals).

An MCP server is **deferred**. A CLI with `--json` covers the same need with less to
maintain. Revisit only if an agent platform cannot run shell commands.

### A framework that scales: extension points, not built-ins

Keep the core zero-dependency. Grow through **declared extension points**, each with a
written contract and tests. Larger pieces ship later as separate packages
(`@shrinivas-sn/adapter-ingestion-csv`, `-html`).

| Extension point | What it does | Real evidence today | Rule met? |
|---|---|---|---|
| **History provider** for the canary | Load and save the run baseline anywhere (file, git, KV), so `count_drop_ratio` works on stateless CI | `govt-job-platform/ingestion/src/canary-baseline.mjs`: "has never actually been able to fire on the real schedule"; it affects every scheduled source there | **Yes** (platform gap, many sources) |
| **Body transform / parse hook** | A declared `(Response) → items[]` step, replacing today's `fetchImpl` hijack | CSV (`model-bench` livebench), HTML table (`govt-job-platform` `html-table-fetch.mjs`), Next.js flight data (`model-bench` terminal-bench), envelope + URL building (`model-bench` openrouter) | **Yes** (4 sources, 3 sites) |
| **Secret headers from env** (`{"x-api-key": {"env": "AA_KEY"}}`, redacted in reports) | Keep secrets out of adapter JSON | `model-bench` artificial-analysis (`x-api-key`), `govt-job-platform` Hugging Face (`Authorization: Bearer HF_TOKEN`) | **Yes** (2 sources) |
| **Full-precision datetime normalizer** (`iso-datetime`) | Keep the time of day; `iso-date` truncates it | WordPress `modified_gmt` (`govt-job-platform` `wp-time.mjs`) and the github advisories `published_at` (truncated today) | **Probably**: confirm the second source needs the time |
| **URL template** (RFC-0.3 Gap B) | Build `url` from an id | `model-bench` openrouter (`https://openrouter.ai/${m.id}`) | **No, 1 of 2.** The transform hook covers it meanwhile |
| **Object-values records** (RFC-0.3 Gap A) | Records keyed by id instead of an array | None found | **No, 0 of 2.** Park it |
| **Store interface** (JSONL default, others pluggable) | Write to SQLite or Postgres | `govt-job-platform` writes to Postgres through its own `db.mjs` | **No, 1 of 2** |
| **Hooks** (`onStale`, `onError`) | Alerting without wrapper code | Not checked yet | **Unproven** |
| **Custom normalizers** in code | Owner-specific value cleaning | `wp-time.mjs` | Covered by `iso-datetime` if that ships |

### What "production-grade" means here: have vs missing

**Already in place:** 281 tests (279 pass, 2 documented platform skips); a CI matrix across
Ubuntu and Windows and Node 22.15/22/24; an install test against the packed tarball; a
memory scale proof; OIDC publishing with provenance; strict config validation; stable
`E_*` error codes; atomic reports; a store lock; bounded fetches; retries.

**Missing:**

- **Contract freeze tests:** a snapshot of the public exports, the `E_*` code list and the
  report schema. Changing any of them fails CI unless the change is intentional.
- **Types and schema checks in CI:** `publint` and `@arethetypeswrong/cli` on the packed
  tarball.
- **Property and fuzz tests** for `getPath`, the normalizers and the config validator. These
  take hostile input from strangers' adapters.
- **Consumer upgrade gate** (see item 1).
- **Policy files:** `SECURITY.md`, a versioning and deprecation policy, the supported Node
  window, and `CONTRIBUTING.md`.
- **Edge-case audit:** check `TEST-MATRIX.md` against the full list below and add tests
  where a class has none:
  - **Network:** timeouts, resets, 429/5xx with `Retry-After`, a **redirect to a
    different host** (provenance), gzip, chunked responses, huge bodies, slow drip.
  - **Data:** missing, null, wrong type, unicode, HTML entities, timezones, duplicate ids
    within one batch, id collisions across hosts.
  - **Source behaviour:** empty response, sudden shrink, envelope change, pagination
    loops, pages that repeat.
  - **Environment:** Windows paths, concurrent runs, a crash mid-write, a full disk, a
    read-only file system, clock skew.
  - **Upgrades:** old store lines, old reports and old adapters read by the new engine.

---

## Proposed versions (smallest working step each)

### 0.3.0: self-describing and upgrade-safe (foundation)

- **Must have:**
  - `.d.ts` types and `adapter.schema.json`; the engine accepts `$schema`.
  - A CLI `bin` with `validate`, `run` and `explain`, all with `--json`.
  - `report.notices[]` (additive), plus one or two real advice rules.
  - The canary history provider, which closes the CI gap.
  - A clear error for an adapter that is too new.
  - `AGENTS.md` and `llms.txt` in the tarball.
  - A corrected `description` and keywords.
  - A versioning policy section.
  - Contract freeze tests.
  - The consumer upgrade gate script, plus actually moving `govt-job-platform` to the new
    version as evidence.
- **Optional:** `doctor` (it reuses the notice rules), and `publint`/`attw` in CI.
- **Exit criteria:**
  - Both real consumers run the new version green.
  - An agent given only the installed package can write and validate a new adapter.
  - `count_drop_ratio` fires on a fresh CI checkout.

### 0.4.0: extension points (each one gated by the two-source rule)

- **Must have:** the body transform hook, secret headers from env, and `iso-datetime`
  (once the second source is confirmed).
- **Options:** URL template and the store interface. Each needs a second real source first.
- **Exit criteria:** `model-bench` and `govt-job-platform` delete their `fetchImpl`
  workarounds (`csv.mjs` wiring, `html-table-fetch.mjs` wiring, `wp-time.mjs`,
  `canary-baseline.mjs`).

### 0.5.0: ecosystem

- `init` (an interactive or flag-driven scaffold), `test` against fixtures, and `doctor`
  if it was not done in 0.3.
- The public adapter-authoring skill.
- `examples/` run in CI.
- First official plugin packages, only where the evidence holds.
- `migrate` plus adapter `version: 2`, **only if** a breaking adapter change has piled up.

### 1.0.0: frozen contract

- The public API, the adapter schema, the report schema, the store line format and the
  `E_*` codes are frozen under the written policy.
- At least one minor-version upgrade has been taken by both real consumers with no manual
  edits.
- Owner decision: whether at least one outside user is required before 1.0.

## Non-goals (kept)

- No GUI and no hosted service. Non-coders are reached through agents.
- No unattended LLM regeneration of adapters. A stale canary alerts a human.
- No built-in HTML/RSS/CSV parsers in the core. They ship as plugins after the two-source
  evidence.
- No distributed locking.
- No cross-source fuzzy dedupe.

## RFC-0.3 disposition

- **Gap A, `records_shape: "object_values"`:** parked. No real source found.
- **Gap B, `template`:** parked at 1 of 2 sources (openrouter). Meanwhile the transform
  hook covers it. When it ships, a missing variable must produce `null`, not an empty
  string (the RFC's draft uses `''`, which would build a wrong URL silently).
- **"Does 0.2.0 reject unknown adapter fields?"** Yes: `src/config.mjs:41`. New *optional*
  adapter keys therefore need no adapter `version` bump, but an older engine must say
  "needs a newer engine" instead of "typo?". That fix is in 0.3.0.

## Open decisions for the owner

1. **Order:** foundation first (0.3.0 as above), or the extension points first?
   *Recommended: foundation first.*
2. **Types:** generate them from JSDoc (keeps `.mjs`), or migrate the source to TypeScript?
   *Recommended: JSDoc.*
3. **1.0 gate:** do we require an outside user, or only the two real consumers?
4. **CLI name:** `adapter-ingestion` (the package name), or something shorter?
