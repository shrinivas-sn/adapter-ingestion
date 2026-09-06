# @shrinivas-sn/adapter-ingestion

## 0.1.0

### Minor Changes

- c9b813a: Initial release: generic fetch -> extract -> dedupe -> store pipeline for adapter-driven
  ingestion from sites with no API, a declarative read-time relevance filter, and a canary
  that flags a stale adapter when a source changes shape. The published package ships only
  the engine (src/); this repo also carries the earthquake.usgs.gov and
  www.karnatakacareers.org adapters as worked examples, not part of the npm package itself.
