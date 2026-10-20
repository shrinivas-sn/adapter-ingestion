---
"@shrinivas-sn/adapter-ingestion": minor
---

New `csv` source kind: `access.kind: "csv"` reads a CSV file with a header row, one record
per row, cells as strings and empty cells as `null`. No extra package needed.

- New map rule `{ "template": "..." }` in place of `path` builds a value from several
  fields (`"{entity}:{year}"`, `"https://example.org/item/{id}"`); a missing value makes the
  field `null`.
- A built-in kind added from 0.8 on yields to a kind you registered under the same name, so
  a parser you registered as `csv` keeps being used. `json-api` and `html` stay protected.
- No changes needed for existing adapters.
