// Shared JSDoc types for the public API. This module has no runtime code;
// it exists so `tsc` can emit them into the shipped .d.mts files. Import a
// type with: @typedef {import('./types.mjs').Report} Report

/**
 * A fetch header value read from an environment variable (since 0.6).
 * @typedef {object} HeaderRef
 * @property {string} env
 * @property {boolean} [optional]
 */

/**
 * @typedef {object} AdapterPagination
 * @property {'page-param'} style
 * @property {string} param
 * @property {number} [max_pages]
 * @property {number} [per_page]
 * @property {string} [per_page_param]
 * @property {boolean} [allow_truncation]
 */

/**
 * The adapter's fetch section.
 * @typedef {object} AdapterFetch
 * @property {'GET'} [method]
 * @property {Record<string, string | HeaderRef>} [headers]
 * @property {number} [timeout_ms]
 * @property {number} [max_duration_ms]
 * @property {number} [max_records]
 * @property {number} [max_response_bytes]
 * @property {number} [max_total_bytes]
 * @property {number} [delay_ms]
 * @property {AdapterPagination} [pagination]
 * @property {{ param: string, type: 'iso-date' }} [incremental]
 * @property {{ max_attempts?: number, backoff_ms?: number, max_delay_ms?: number }} [retry]
 */

/**
 * One map rule: where an output field comes from.
 * @typedef {{ path?: string, template?: string, normalize?: 'text'|'number'|'iso-date'|'iso-datetime'|'bool', assume_zone?: 'Z' }} MapRule
 */

/**
 * The adapter's canary section.
 * @typedef {object} AdapterCanary
 * @property {number} [min_records]
 * @property {number} [required_field_ratio]
 * @property {number} [median_window]
 * @property {number} [count_drop_ratio]
 * @property {number} [max_staleness_days]
 * @property {string} [staleness_field]
 */

/**
 * The adapter's html section (access.kind "html").
 * @typedef {{ mode: 'select', rows: string, fields: Record<string, { selector?: string, attr?: string, resolve_url?: boolean }> } | { mode: 'script_json', script: string }} AdapterHtml
 */

/**
 * One source's adapter (see schema/adapter.schema.json for every key). The
 * engine also allows top-level keys of your own (start them with `_`); they
 * are left out here on purpose, because an index signature would stop an
 * adapter typed with your own interface from matching.
 * @typedef {object} Adapter
 * @property {string} [$schema]
 * @property {1} version
 * @property {string} host
 * @property {{ tier: number, kind: string, url: string }} access
 * @property {AdapterFetch} [fetch]
 * @property {string} [records_path]
 * @property {Record<string, MapRule>} map
 * @property {string[]} [required]
 * @property {AdapterCanary} [canary]
 * @property {AdapterHtml} [html]
 */

/**
 * A source kind: turns a response body into records.
 * @typedef {object} Kind
 * @property {string} [name]
 * @property {(input: { bytes: Buffer, contentType: string|null, url: string, adapter: Adapter, limits?: { maxRecords: number, remainingRecords: number } }) => any} parse
 * @property {(adapter: Adapter, need: (cond: any, message: string) => void) => void} [validate]
 * @property {{ max_response_bytes?: number }} [defaults]
 */

/**
 * @typedef {object} RunPaths
 * @property {string} storeFile JSONL store file for this source.
 * @property {string} runsDir Directory for this source's run reports.
 * @property {string} [historyFile] Optional committed canary history file (since 0.4).
 */

/**
 * @typedef {object} RunIngestOptions
 * @property {Adapter} adapter
 * @property {RunPaths} paths
 * @property {string} [since] YYYY-MM-DD; switches to incremental mode.
 * @property {typeof fetch} [fetchImpl]
 * @property {AbortSignal} [signal]
 * @property {Record<string, Kind>} [kinds] Caller-registered source kinds.
 * @property {Date} [now]
 * @property {{ max_line_bytes?: number }} [store]
 */

/**
 * Advice (A_*) or a deprecation (D_*) about an adapter.
 * @typedef {object} Notice
 * @property {string} code
 * @property {'advice'|'deprecation'} kind
 * @property {string} message
 * @property {string} since
 * @property {string} docs
 * @property {string} [removed_in]
 * @property {string} [path]
 */

/**
 * @typedef {object} CanaryResult
 * @property {'ok'|'stale'|'not_evaluated'} status
 * @property {string[]} breaches
 * @property {{ check: 'min_records'|'required_field_ratio'|'count_drop_ratio'|'staleness', reason: 'incremental_batch'|'empty_batch'|'no_history'|'not_configured' }[]} skipped
 */

/**
 * Where a run failed: a report's failure.stage, or "options" in `run --json`
 * when the options were rejected before any report.
 * @typedef {'validate'|'fetch'|'extract'|'store'|'canary'|'lock'|'lock_release'|'options'} FailureStage
 */

/**
 * @typedef {object} Stages
 * @property {number} fetched
 * @property {number} parsed
 * @property {number} fresh
 * @property {number} changed
 * @property {number} unchanged
 * @property {number|null} written
 */

/**
 * A run report (report_version 2).
 * @typedef {object} Report
 * @property {2} report_version
 * @property {string} run_id
 * @property {string|null} adapter_fingerprint
 * @property {'snapshot'|'incremental'} mode
 * @property {'ok'|'stale'|'error'|'aborted'} outcome
 * @property {string|null} host
 * @property {string} started_at
 * @property {string} finished_at
 * @property {number} duration_ms
 * @property {Stages} stages
 * @property {number} error_count
 * @property {{ index: number, code: string, missing: string[], invalid: string[], source_id: any, source_url: any }[]} errors
 * @property {string|null} fatal_error
 * @property {{ code: string, message: string, stage: FailureStage, details?: any }|null} failure
 * @property {{ code: string, message: string, stage: string, details?: any }[]} secondary_errors
 * @property {{ code: 'W_PAGE_LIMIT'|'W_STORE_CORRUPT_LINE'|'W_STORE_INVALID_RECORD'|'W_HISTORY_CORRUPT_LINE', message?: string, line?: number }[]} warnings
 * @property {number} warning_count
 * @property {any} newest_staleness_value
 * @property {CanaryResult} canary
 * @property {{ pages: number, attempts: number, retries: number, statuses: number[], status_count: number, bytes: number, complete: boolean, stop_reason: 'single_page'|'empty_page'|'short_page'|'max_pages'|null }} fetch
 * @property {{ status: 'not_started'|'unchanged'|'committed'|'uncertain', written: number|null }} storage
 * @property {Notice[]} notices
 */

/**
 * @typedef {object} RunResult
 * @property {Report} report
 * @property {CanaryResult} canary
 */

/**
 * One stored record (one JSONL line).
 * @typedef {object} StoreRecord
 * @property {string} id
 * @property {string} source_host
 * @property {string} source_url
 * @property {string} fetched_at
 * @property {string} content_hash
 * @property {Record<string, any>} fields
 * @property {any} raw
 */

export {};
