# Versioning and deprecation policy

This package follows [Semantic Versioning](https://semver.org/). This page says exactly
what each kind of release may change, so you can decide how much checking an upgrade needs.

## The public surface

Everything below is public. Each item is pinned by a test, so a change to it can only land
on purpose, with a changeset that announces it.

| Surface | Pinned by |
|---|---|
| Exported names, per package subpath (`.`, `./adapter`, `./report`, ...) | `test/contract-freeze.test.mjs` (EXPORTS) |
| `E_*` error codes | `test/contract-freeze.test.mjs` (ERROR_CODES) |
| `A_*` advice and `D_*` deprecation notice codes | `test/contract-freeze.test.mjs` (NOTICE_CODES) |
| Run report top-level keys and `report_version` | `test/contract-freeze.test.mjs` (REPORT_KEYS) |
| Store record keys | `test/contract-freeze.test.mjs` (RECORD_KEYS) |
| Adapter shape (`version: 1`) and `adapter.schema.json` | repo-adapter and schema tests |
| CLI commands, flags, exit codes and `--json` keys | CLI contract tests |
| Supported Node versions (`engines.node`) | the CI matrix |

Anything not listed (internal modules under `src/` that are not package subpaths, the
wording of error messages, the layout of files in `runs/`) may change in any release.

**Source kind names.** `json-api` and `html` can never be replaced by a kind you register
with the `kinds` option (`E_OPTIONS`). A built-in kind added in a later minor (since 0.8:
`csv`; since 0.9: `feed`) yields to a kind you registered under the same name, so a new built-in never takes
over a name you already use.

## What each release may change

| Change | Patch `0.x.y` | Minor `0.x` (while 0.x) | Major (after 1.0) |
|---|---|---|---|
| Bug fix | yes | yes | yes |
| New optional adapter key, option, export, code or report key | no | yes | yes |
| A default that is strictly safer (fails louder, tighter bounds, never changes a valid record) | yes, announced | yes, announced | yes |
| Any other default change | no | only as opt-in | yes |
| Deprecate something | no | yes | yes |
| Remove or rename anything on the public surface | no | only after its deprecation window, with a migration guide | yes |
| Raise the minimum Node version | no | yes, announced one minor ahead | yes |

"Announced" means it appears in the changelog and in [UPGRADING.md](UPGRADING.md) under
"Free with no changes".

## Deprecations

1. A deprecation is announced in three places at once: a `D_*` notice in every run report
   whose adapter or options use the deprecated thing, the changelog, and
   [UPGRADING.md](UPGRADING.md).
2. While on 0.x, something deprecated in `0.N` keeps working through `0.N+1`. It may be
   removed no earlier than `0.N+2`, and only together with a `MIGRATION-0.N+2.md` guide.
3. After 1.0, something deprecated is removed only in the next major version.
4. Each `D_*` notice says when it was deprecated (`since`) and when it may be removed
   (`removed_in`).

## Report and store compatibility

- New report keys are additive and never bump `report_version`. A removed or renamed key
  does. Code that reads reports must ignore keys it does not know.
- A store written by an older version is read unchanged by a newer one. The store line
  format is part of the public surface (record keys above).
- The adapter `version` field changes only for a breaking adapter change, and then a
  migration tool ships with it.
- Top-level adapter keys that start with `_` are reserved for your own use: no release will
  give one a meaning, and `A_TOP_LEVEL_KEY_TYPO` never flags one.

## Node support

The supported range is `engines.node` in `package.json`, tested by CI on the lowest
supported version and on current releases. Raising the minimum is announced one minor
release ahead.

## Staying current on 0.x

npm's caret range does not cross a minor version while the major is `0`: `^0.3.0` means
`>=0.3.0 <0.4.0`. So `npm update` never moves you from 0.3 to 0.4; each minor upgrade is a
deliberate change to `package.json`. To be told when one is out:

- use a dependency bot (setup in [UPGRADING.md](UPGRADING.md));
- read the version's section in [UPGRADING.md](UPGRADING.md) before bumping;
- after bumping, read `notices` in the first run report (or run
  `npx adapter-ingestion doctor <adapter.json>`): it lists what the new version offers your
  adapters and anything they use that is deprecated.

After 1.0, `^1.x` takes every 1.x release automatically, and this policy is what makes that
safe.
