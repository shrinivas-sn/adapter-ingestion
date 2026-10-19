---
"@shrinivas-sn/adapter-ingestion": minor
---

New `iso-datetime` normalizer: keeps the time of day and returns UTC
(`2026-10-19T20:53:15+05:30` → `2026-10-19T15:23:15.000Z`). A value with no zone, no time
or an impossible date gives `null`.

- New optional map rule key `assume_zone: "Z"` (with `iso-datetime` only) reads a time
  that has no zone as UTC.
- No changes needed for existing adapters; `iso-date` is unchanged.
