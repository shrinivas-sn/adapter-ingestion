# @shrinivas-sn/adapter-ingestion

## 0.2.0

### Minor Changes

- 55db8d0: Harden JSON ingestion with strict adapter and record validation, bounded fetches,
  retries, explicit pagination completeness, local store locking, streaming history
  reads, and final run reports. Require Node 22.15.0 or newer. See MIGRATION-0.2.md
  for stricter configuration, fetch injection, pagination, and recovery behavior.

### Patch Changes

- 4997013: Fix the `text` normalizer deleting numeric HTML character references
  (`&#8211;`, `&#038;`, `&#x...;`) instead of decoding them -- found
  integrating a real WordPress source, where every title containing an en
  dash or an ampersand was silently mangled.

## 0.1.0

### Minor Changes

- c9b813a: Initial release: generic fetch -> extract -> dedupe -> store pipeline for adapter-driven
  ingestion from sites with no API, a declarative read-time relevance filter, and a canary
  that flags a stale adapter when a source changes shape. The published package ships only
  the engine (src/); this repo also carries the earthquake.usgs.gov and
  www.karnatakacareers.org adapters as worked examples, not part of the npm package itself.
