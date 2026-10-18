// Shared JSDoc types for the public API. This module has no runtime code;
// it exists so `tsc` can emit them into the shipped .d.mts files. Import a
// type with: @typedef {import('./types.mjs').Report} Report

/**
 * One source's adapter (see schema/adapter.schema.json for every key).
 * @typedef {object} Adapter
 * @property {1} version
 * @property {string} host
 * @property {{ tier: number, kind: string, url: string }} access
 * @property {Record<string, any>} [fetch]
 * @property {string} [records_path]
 * @property {Record<string, { path: string, normalize?: 'text'|'number'|'iso-date'|'bool' }>} map
 * @property {string[]} [required]
 * @property {Record<string, any>} [canary]
 * @property {Record<string, any>} [html]
 */

/**
 * A source kind: turns a response body into records.
 * @typedef {object} Kind
 * @property {string} [name]
 * @property {(input: { bytes: Buffer, contentType: string|null, url: string, adapter: Adapter, limits?: any }) => any} parse
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
 * @property {{ check: string, reason: string }[]} skipped
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
 * @property {any[]} errors
 * @property {string|null} fatal_error
 * @property {{ code: string, message: string, stage: string, details?: any }|null} failure
 * @property {any[]} secondary_errors
 * @property {any[]} warnings
 * @property {number} warning_count
 * @property {any} newest_staleness_value
 * @property {CanaryResult} canary
 * @property {{ pages: number, attempts: number, retries: number, statuses: number[], status_count: number, bytes: number, complete: boolean, stop_reason: string|null }} fetch
 * @property {{ status: string, written: number|null }} storage
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
