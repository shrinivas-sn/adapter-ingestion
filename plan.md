# Production-Grade Audit & Gap Analysis: `@shrinivas-sn/adapter-ingestion`

## Executive Summary

This document presents an evidence-based technical audit of `@shrinivas-sn/adapter-ingestion` (v0.1.0). The audit reveals that while the package excels at deterministic, zero-recurring-cost ingestion for **simple, unauthenticated JSON APIs**, it suffers from critical architectural gaps, logic bugs, and error-handling vulnerabilities that prevent it from being production-ready for general web ingestion.

By drawing architectural inspiration from established ingestion engines (**Scrapy**, **Crawlee**, **Airbyte**, and **BullMQ**) while retaining this library's core philosophy—**zero-dependency, lightweight, declarative JSON schema**—this document details the exact gaps, provides code evidence, and defines a production-grade evolution path.

---

## 1. Concrete Code Bugs & Logic Flaws (With Evidence)

### 1.1 Premature Loop Termination in `fetch.mjs` (Pagination Bug)
* **Location**: `src/fetch.mjs`, Lines 18 & 69
* **The Code**:
  ```javascript
  18: const perPage = p?.per_page ?? Infinity;
  ...
  69: if (batch.length < perPage) break;
  ```
* **The Defect**: If an adapter configures pagination (e.g. `max_pages: 5, param: "page"`) but omits `per_page`, `perPage` defaults to `Infinity`. On page 1, any returned batch has `batch.length < Infinity` (`true`). The loop executes `break` immediately after page 1, silently ignoring `max_pages`.
* **Impact**: Multi-page pagination fails silently whenever `per_page` is not explicitly declared.

### 1.2 Unimplemented `access.kind` Promises
* **Location**: `src/adapter.mjs`, Line 4 vs `src/fetch.mjs`, Line 53
* **The Code**:
  ```javascript
  // adapter.mjs:4
  const KINDS = new Set(['json-api', 'feed', 'html', 'browser']);

  // fetch.mjs:53
  const body = await res.json();
  ```
* **The Defect**: `validateAdapter` permits `kind` values of `'feed'`, `'html'`, and `'browser'`. However, `fetch.mjs` hardcodes `await res.json()`.
* **Impact**: Supplying an RSS/Atom XML feed (`kind: 'feed'`) or an HTML table (`kind: 'html'`) passes schema validation but crashes with an unhandled `SyntaxError: Unexpected token < in JSON at position 0`.

### 1.3 Memory Exhaustion (OOM) via `readFile` in `store.mjs`
* **Location**: `src/store.mjs`, Lines 39 & 72
* **The Code**:
  ```javascript
  39: text = await readFile(filePath, 'utf8');
  ...
  42: for (const line of text.split('\n')) {
  ```
* **The Defect**: `readRecords()` and `readIndex()` load the entire `.jsonl` file into a single in-memory V8 string and run `.split('\n')`.
* **Impact**: A store accumulating 200MB–1GB of data over months will exceed V8 string length limits or trigger Out-Of-Memory (`ERR_STRING_TOO_LONG` / `heap out of memory`), permanently breaking subsequent cron runs.

### 1.4 Rigid Date Normalizer Rejects Standard Web Dates
* **Location**: `src/normalize.mjs`, Lines 30–45
* **The Defect**: `isoDate()` only parses `YYYY-MM-DD`, `DD-Mon-YYYY`, and `DD/MM/YYYY`. It cannot parse:
  - RFC 2822 / RFC 822 format (e.g., `Sat, 12 Sep 2026 13:00:37 GMT` — universal in RSS/web feeds)
  - ISO timestamps with timezone offsets (`2026-09-12T13:00:37+05:30`)
  - UNIX epoch seconds (only epoch milliseconds are handled if passed through `number`)
* **Impact**: Web feeds produce `null` for published dates, causing required field checks or staleness canaries to fail.

### 1.5 Total Lack of Transient Error Resilience
* **Location**: `src/fetch.mjs`, Lines 29–35
* **The Defect**: A single network blip, DNS lookup delay, 502/503/504 Bad Gateway, or 429 Too Many Requests instantly throws `fetch failed` and terminates the pipeline.
* **Impact**: In unattended cron setups (e.g. GitHub Actions, AWS EventBridge), transient network flickers cause false-positive pipeline failures.

### 1.6 Blind Error Context in `extractAll`
* **Location**: `src/extract.mjs`, Line 27
* **The Code**:
  ```javascript
  if (missing.length) { errors.push({ index, missing }); return; }
  ```
* **The Defect**: The error log reports `{ index: 42, missing: ["title"] }`. In a raw feed of 1,000 items, the user cannot identify which upstream record failed because no identifier, URL, or raw key snippet is attached.

---

## 2. Structural & Architectural Gaps

| Capability | Current Package State | Production Requirement | Commercial Reference |
| :--- | :--- | :--- | :--- |
| **Data Ingestion Formats** | Hardcoded JSON only (`res.json()`). | Pluggable parsing layer: JSON, XML/RSS/Atom, HTML (CSS selectors), CSV. | **Scrapy** (Selectors / Parsers) |
| **Retry & Backoff** | 0 retries. Single failure aborts run. | Configurable retry strategy with exponential backoff and jitter on 408/429/5xx and network dropouts. | **Scrapy** `RetryMiddleware`, **BullMQ** backoff |
| **Rate Limiting** | Fires requests in rapid succession. | Configurable request pacing (`delay_ms`, jitter, concurrency limit). | **Scrapy** `DOWNLOAD_DELAY` & `AutoThrottle` |
| **State Persistence** | Stateless; relies on manual CLI `--since`. | Automatic state/cursor checkpointing saved alongside the store. | **Airbyte** `AirbyteStateMessage` |
| **Concurrency / Process Safety** | No file locking. Concurrent runs produce duplicate lines. | Advisory file locking (`flock` / lockfile) around the store file. | **Linux `flock`**, SQLite WAL |
| **Storage Scaling** | Buffers entire `.jsonl` file in RAM via `fs.readFile`. | Stream-based line reader (`node:readline` / `node:stream`). | **Node.js Streams** |
| **Pagination Paradigms** | Page parameter only (`?page=N`). | Support for Cursor (`next_cursor`), Offset/Limit, and Link Headers. | **Airbyte CDK**, **Stripe API** |
| **HTTP Methods & Payloads** | GET only; URL search parameters only. | POST with JSON body (required for GraphQL and modern search endpoints). | **Crawlee HttpCrawler** |
| **Field Extraction Syntax** | Dot-separated object keys only (`a.b.c`). | Support for key escaping (e.g. `dc:creator`), regex extraction, and array transformations. | **JSONPath / jq** |

---

## 3. Commercial Scraping & Ingestion Methodologies (Inspirations)

To evolve this package without bloating it with massive dependencies (avoiding heavy frameworks like Puppeteer or JVM runtimes), we can adapt core methodologies from industry standards:

### 3.1 From Scrapy: Declarative Retries & Spider Contracts
* **Mechanism**: Scrapy isolates retries into a clean middleware layer handling `[408, 429, 500, 502, 503, 504]` and connection drops with priority adjustment.
* **Adaptation for this package**: Add an optional `retry` section to the adapter schema:
  ```json
  "retry": {
    "max_attempts": 3,
    "status_codes": [429, 500, 502, 503, 504],
    "backoff_ms": 1000
  }
  ```
  Implement zero-dependency exponential backoff:
  $$\text{delay} = \text{backoff\_ms} \times 2^{(\text{attempt} - 1)} \pm \text{jitter}$$

### 3.2 From Crawlee: Session State & Error Scoring
* **Mechanism**: Crawlee evaluates session health; repeated 403/429 blocks mark a session bad and trigger dynamic cool-downs.
* **Adaptation for this package**: Enhance the Canary. If intermediate pages return 429 or 403, record them under `report.stages.blocked` rather than crashing blindly.

### 3.3 From Airbyte: Stream State Checkpointing
* **Mechanism**: Airbyte emits an `AirbyteStateMessage` recording cursor positions (e.g., `updated_at: "2026-09-13T10:00:00Z"`). On subsequent runs, it loads this state automatically.
* **Adaptation for this package**: Automatically save a lightweight state file (`store/<host>.state.json`) recording the newest extracted timestamp or cursor ID. On the next run, automatically supply this value to the incremental parameter without requiring manual CLI `--since` arguments.

### 3.4 From BullMQ: Backoff & Worker Resilience
* **Mechanism**: Exponential delay curves calculated deterministically before scheduling re-attempts.
* **Adaptation for this package**: When a feed endpoint responds with a `Retry-After` header, honor it explicitly before retrying.

---

## 4. The Unserved Market Gap

### Current Ecosystem Void
1. **Airbyte / Meltano**: Robust, but heavy enterprise tools requiring Docker, databases, or complex Python environments. Overkill for lightweight apps.
2. **Scrapy**: Powerful, but Python-only. Unavailable to Node.js / TypeScript codebases.
3. **Crawlee / Playwright**: Excellent for browser scraping, but imperative (requires writing custom crawler scripts) and computationally heavy.
4. **Ad-hoc fetch scripts**: What 90% of developers write—brittle, lacking deduplication, lacking crash recovery, with zero drift detection.

### The Opportunity: A "One-Stop Declarative Ingestion Engine for Node.js"
A lightweight, zero-dependency Node.js engine where **one JSON adapter definition** gives developers:
- Multi-format ingestion (**JSON**, **RSS/XML**, **HTML via CSS selectors**)
- Automated extraction & field normalization
- Built-in content hashing & SHA-256 deduplication
- Crash-safe append-only local JSONL storage
- Self-healing recovery against truncated writes
- Built-in Canary health monitoring that flags schema drift and frozen feeds
- Automated cursor/state checkpointing

---

## 5. Prioritized Production-Grade Roadmap

### Phase 1: Stability & Bug Fixes (Immediate)
1. **Fix Pagination Termination**: Correct `p?.per_page ?? Infinity` logic in `fetch.mjs`.
2. **Stream-based Store Reading**: Replace `readFile` in `readRecords` and `readIndex` with `node:readline` / streaming chunks to prevent OOM on large datasets.
3. **Robust Date Normalizer**: Upgrade `isoDate` to support RFC 2822 dates (`new Date(str)` validation with UTC normalization).
4. **Actionable Extraction Errors**: Include record identifier candidates (or raw snippets) in `errors` array.

### Phase 2: Resilience & Network Robustness (High Priority)
1. **Built-in Retries with Exponential Backoff**: Implement retries on transient network errors, timeouts, and 429/5xx status codes.
2. **Pacing / Rate Limiting**: Introduce `delay_ms` between paginated page fetches to prevent anti-bot IP bans.
3. **Automated State Checkpointing**: Persist `state.json` containing the newest record timestamp/cursor to enable autonomous incremental syncing.
4. **File Locking**: Implement advisory file locking during store write operations.

### Phase 3: Format Generalization (Market Differentiation)
1. **XML / RSS / Atom Ingestion**: Add a lightweight XML parser for `kind: "feed"` so public feeds (e.g. WordPress, FreeJobAlert, government portals) ingest natively.
2. **HTML Table / List Extraction**: Add CSS selector support (`selector: "table.jobs tr"`) for `kind: "html"`.
3. **POST / GraphQL Support**: Support JSON request bodies and cursor-based pagination.
