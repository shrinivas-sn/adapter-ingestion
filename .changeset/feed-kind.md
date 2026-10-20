---
"@shrinivas-sn/adapter-ingestion": minor
---

New `feed` source kind: `access.kind: "feed"` reads an RSS 2.0, RSS 1.0 or Atom feed, one
record per item, with the same keys whatever the format: `id`, `url`, `title`, `summary`,
`content`, `published`, `updated`, `author`, `categories`. Needs the optional `cheerio`
package, as `html` does.

- RSS dates (`Tue, 06 Oct 2026 17:00:00 +0000`) and Atom dates become ISO 8601 UTC; a date
  that cannot be read exactly is `null`.
- The format is detected from the root element, so a feed served as
  `application/octet-stream` still works; any other document is `E_PARSE`.
- DTD entities are never expanded and external entities are never read.
- Like `csv`, the new built-in yields to a kind you registered as `feed`.
- Nothing changes for existing adapters.
