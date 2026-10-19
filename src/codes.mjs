// One entry per public code: what it means, the usual cause, and the fix.
// The CLI's `explain` command and AGENTS.md's code table are both built from
// this. Keys are unquoted on purpose: the contract-freeze tests find codes by
// their quoted uses in src/, and this catalog must never count as a use.
// A test keeps it covering exactly the frozen E_* and notice codes.
export const CODES = Object.freeze({
  E_ABORTED: {
    kind: 'error',
    meaning: 'The run was cancelled through its AbortSignal.',
    cause: 'The process got SIGINT/SIGTERM, or the caller aborted the signal it passed in.',
    fix: 'Nothing is wrong with the source. Run again; nothing was appended to the store after the abort.',
  },
  E_ADAPTER_INVALID: {
    kind: 'error',
    meaning: 'The adapter failed validation, so nothing was fetched.',
    cause: 'A missing or wrongly typed field, an unknown key (a typo, or a field from a newer version), or an invalid selector.',
    fix: 'Run `adapter-ingestion validate <adapter.json>`; it lists every error. If a key is unknown, check whether it needs a newer engine version.',
  },
  E_FETCH: {
    kind: 'error',
    meaning: 'The request failed before a response arrived.',
    cause: 'DNS, connection or TLS failure, or an error thrown by an injected fetch implementation.',
    fix: 'Check the URL and network access. Connection failures are retried when fetch.retry allows it.',
  },
  E_FETCH_DEADLINE: {
    kind: 'error',
    meaning: 'The whole fetch took longer than fetch.max_duration_ms.',
    cause: 'A slow source, many pages, or long retry waits.',
    fix: 'Raise fetch.max_duration_ms, lower max_pages, or reduce retry delays.',
  },
  E_FILTER_INVALID: {
    kind: 'error',
    meaning: 'A filter definition failed validation.',
    cause: 'An unknown operator, a malformed rule, or a reserved field name.',
    fix: 'Fix the filter JSON; the message lists each problem.',
  },
  E_HEADER_ENV: {
    kind: 'error',
    meaning: 'A fetch header reads an environment variable that is unset, empty, or not a valid header value.',
    cause: 'The variable is not set in this shell or CI step, or its value has a line break or another character a header cannot hold.',
    fix: 'Set the variable where the run happens (in CI, as a secret). Mark the header "optional": true to send no header when it is unset.',
  },
  E_HTTP_STATUS: {
    kind: 'error',
    meaning: 'The server answered with a status that is not a success.',
    cause: 'The URL moved, needs headers or auth, is rate-limited, or the server is failing.',
    fix: 'Open the URL by hand. 429 and 5xx are retried when fetch.retry allows it; other statuses need an adapter change.',
  },
  E_KIND_DEPENDENCY: {
    kind: 'error',
    meaning: 'A source kind needs an optional package that is not installed.',
    cause: 'An html adapter without the optional cheerio peer dependency.',
    fix: 'Install it next to this package: `npm install cheerio`.',
  },
  E_LOCK_RELEASE: {
    kind: 'error',
    meaning: 'The run finished but its store lock file could not be removed.',
    cause: 'A file-system permission or I/O problem on the store directory.',
    fix: 'Check the store directory, then remove the leftover `.lock` file once no run is active.',
  },
  E_OPTIONS: {
    kind: 'error',
    meaning: 'An option passed to the API or CLI is invalid.',
    cause: 'A missing path, a wrong type, or a malformed kinds option.',
    fix: 'Fix the named option. No report is written when the paths themselves are invalid.',
  },
  E_PAGE_LIMIT: {
    kind: 'error',
    meaning: 'Pagination reached max_pages while pages were still full.',
    cause: 'The source has more data than max_pages covers, so the result would be silently truncated.',
    fix: 'Raise fetch.pagination.max_pages, or set allow_truncation: true to accept a bounded window.',
  },
  E_PAGINATION_REPEAT: {
    kind: 'error',
    meaning: 'A page was an exact repeat of the previous one.',
    cause: 'The endpoint ignores the page parameter, or the parameter name is wrong.',
    fix: 'Check fetch.pagination.param against the API docs.',
  },
  E_PARSE: {
    kind: 'error',
    meaning: 'A source kind could not turn the response into records.',
    cause: 'A caller-registered kind threw, or returned values that cannot be serialised.',
    fix: 'Debug the kind\'s parse function against the saved response.',
  },
  E_PARSE_NO_MATCH: {
    kind: 'error',
    meaning: 'An html selector that must match found nothing.',
    cause: 'The page layout changed, or the selector is wrong.',
    fix: 'Re-check the selector against the current page and update the adapter.',
  },
  E_RECORD_INVALID: {
    kind: 'error',
    meaning: 'A record could not be built in the store contract shape.',
    cause: 'An invalid id, URL or timestamp reached record building.',
    fix: 'Check the map rules for source_id and url.',
  },
  E_RECORD_LIMIT: {
    kind: 'error',
    meaning: 'The fetch produced more records than fetch.max_records.',
    cause: 'The source grew, or pagination returns more than expected.',
    fix: 'Raise fetch.max_records if the growth is real.',
  },
  E_REDIRECT: {
    kind: 'error',
    meaning: 'The server answered with a redirect, which is never followed.',
    cause: 'The URL moved, or http redirects to https.',
    fix: 'Put the final URL in the adapter.',
  },
  E_REPORT_READ: {
    kind: 'error',
    meaning: 'Past run reports or the history file could not be read.',
    cause: 'A permission or I/O error on the runs directory or history file.',
    fix: 'Check that the path is readable.',
  },
  E_REPORT_WRITE: {
    kind: 'error',
    meaning: 'The run report or history file could not be written.',
    cause: 'A permission, disk-space or I/O error on the runs directory or history file.',
    fix: 'Check that the path is writable. The in-memory report is still attached to the error.',
  },
  E_RESPONSE_JSON: {
    kind: 'error',
    meaning: 'The response body is not valid JSON.',
    cause: 'The server sent HTML (an error page or a login wall) or a truncated body.',
    fix: 'Open the URL by hand; if it is an HTML page, use access.kind "html".',
  },
  E_RESPONSE_LIMIT: {
    kind: 'error',
    meaning: 'One response was larger than fetch.max_response_bytes.',
    cause: 'The source grew, or the URL returns more than expected.',
    fix: 'Raise fetch.max_response_bytes if the size is expected.',
  },
  E_RESPONSE_SHAPE: {
    kind: 'error',
    meaning: 'records_path did not resolve to an array.',
    cause: 'The response envelope changed, or records_path is wrong.',
    fix: 'Compare records_path with a current response.',
  },
  E_RETRY_DEFERRED: {
    kind: 'error',
    meaning: 'The server asked for a retry delay longer than the configured budget.',
    cause: 'A long Retry-After header on a 429 or 503.',
    fix: 'Run later, or raise fetch.retry.max_delay_ms and fetch.max_duration_ms.',
  },
  E_STORE_LINE_LIMIT: {
    kind: 'error',
    meaning: 'One record is larger than the store line limit.',
    cause: 'A huge raw payload in a single record.',
    fix: 'Map fewer fields, or raise the store max_line_bytes option.',
  },
  E_STORE_LOCKED: {
    kind: 'error',
    meaning: 'Another run holds this store\'s lock.',
    cause: 'Two runs at once on the same store, or a crashed run left its `.lock` file.',
    fix: 'Let the other run finish. Remove the `.lock` file only after confirming no run is active.',
  },
  E_STORE_READ: {
    kind: 'error',
    meaning: 'The store file could not be read.',
    cause: 'A permission or I/O error on the store file.',
    fix: 'Check that the path is readable.',
  },
  E_STORE_WRITE: {
    kind: 'error',
    meaning: 'Records could not be appended to the store.',
    cause: 'A permission, disk-space or I/O error, or a value that cannot be serialised.',
    fix: 'Check the store directory. The report\'s storage.status says whether the batch may have partly landed.',
  },
  E_TIMEOUT: {
    kind: 'error',
    meaning: 'One request took longer than fetch.timeout_ms.',
    cause: 'A slow or stalled server.',
    fix: 'Raise fetch.timeout_ms. Timeouts are retried when fetch.retry allows it.',
  },
  E_TOTAL_BYTES_LIMIT: {
    kind: 'error',
    meaning: 'All responses together exceeded fetch.max_total_bytes.',
    cause: 'Many large pages.',
    fix: 'Raise fetch.max_total_bytes, or lower max_pages.',
  },
  A_CANARY_NO_HISTORY: {
    kind: 'advice',
    meaning: 'count_drop_ratio could not run: no comparable past runs were found.',
    cause: 'A first run, or a CI job that starts from a fresh checkout without the runs directory.',
    fix: 'Set paths.historyFile (CLI: --history) to a file you commit with the store.',
  },
  A_TOP_LEVEL_KEY_TYPO: {
    kind: 'advice',
    meaning: 'A top-level key is one edit away from fetch, records_path, required or canary, so that setting is probably misspelled and is being ignored.',
    cause: 'Top-level keys are free for your own metadata, so the validator cannot reject a misspelled one.',
    fix: 'Rename it to the suggested key. If it is your own metadata, start its name with _ so it is never flagged.',
  },
});
