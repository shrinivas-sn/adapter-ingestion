---
"@shrinivas-sn/adapter-ingestion": minor
---

New advice notice `A_TOP_LEVEL_KEY_TYPO`: a top-level adapter key one edit away from
`fetch`, `records_path`, `required` or `canary` (such as `record_path`) is no longer
ignored without a word.

No changes needed:
- `doctor` and run reports of valid adapters name the misspelled key and the key it
  probably meant. Notices never change `outcome` or an exit code.
- Top-level keys that start with `_` are reserved for your own metadata: never
  flagged, never given a meaning.
