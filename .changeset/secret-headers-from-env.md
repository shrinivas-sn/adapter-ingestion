---
"@shrinivas-sn/adapter-ingestion": minor
---

A `fetch.headers` value can now be `{ "env": "NAME" }`, so an API key or token comes
from an environment variable instead of the adapter JSON. The value never appears in
errors, run reports, the history file or CLI output.

- An unset or empty variable fails the run with the new `E_HEADER_ENV` code (CLI exit 2)
  before any request. Add `"optional": true` to send no header instead.
- No changes needed for existing adapters.
