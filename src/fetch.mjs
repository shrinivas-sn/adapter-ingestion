import { createHash } from 'node:crypto';
import { getPath } from './extract.mjs';
import { readJsonBody, retryDelay, waitFor } from './http.mjs';
import { IngestionError } from './errors.mjs';

export function buildUrl(adapter, { page, since } = {}) {
  const url = new URL(adapter.access.url);
  const p = adapter.fetch?.pagination;
  if (p?.style === 'page-param' && page !== undefined) {
    url.searchParams.set(p.param, String(page));
    if (p.per_page_param) url.searchParams.set(p.per_page_param, String(p.per_page));
  }
  const inc = adapter.fetch?.incremental;
  if (inc?.param && since) url.searchParams.set(inc.param, since);
  return url.toString();
}

// Classified from the shapes actually thrown by Node 22.15's native fetch
// (undici), not by pattern-matching arbitrary error text: AbortSignal.timeout
// firing names its error 'TimeoutError' even through AbortSignal.any;
// a manual AbortController firing names it 'AbortError'; redirect:'error'
// rejects with a TypeError whose .cause.message is exactly
// 'unexpected redirect'. Anything else is an undifferentiated E_FETCH.
function classifyFetchError(err) {
  if (err?.name === 'TimeoutError') return 'E_TIMEOUT';
  if (err?.name === 'AbortError') return 'E_ABORTED';
  if (err?.cause?.message === 'unexpected redirect') return 'E_REDIRECT';
  return 'E_FETCH';
}

async function drainQuietly(res) {
  try { await res.body?.cancel?.(); } catch { /* already closed or errored */ }
}

// Response-order-sensitive: a source that echoes different content because
// records were reordered is not a repeat, but two responses byte-identical
// as delivered means the page parameter almost certainly did nothing.
function digestBatch(batch) {
  return createHash('sha256').update(JSON.stringify(batch)).digest('hex');
}

// Only these are worth a second try. Caller abort, the total deadline,
// redirects, malformed JSON, shape/config errors, and size/record limits are
// all either not transient or not safe to repeat -- retrying them would
// either never succeed or duplicate an already-oversized request.
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
function isRetryableError(err) {
  if (err.code === 'E_FETCH' || err.code === 'E_TIMEOUT') return true;
  if (err.code === 'E_HTTP_STATUS') return RETRYABLE_STATUSES.has(err.details?.fetch?.status);
  return false;
}

export async function fetchAll(adapter, { since, fetchImpl = fetch, signal } = {}) {
  const p = adapter.fetch?.pagination;
  const hasPagination = p !== undefined;
  const maxPages = p?.max_pages ?? 1;
  const perPage = p?.per_page; // undefined means "unknown" -- never infer a short page without it
  const allowTruncation = p?.allow_truncation ?? false;
  const timeoutMs = adapter.fetch?.timeout_ms ?? 30_000;
  const maxDurationMs = adapter.fetch?.max_duration_ms ?? 120_000;
  const maxRecords = adapter.fetch?.max_records ?? 5000;
  const maxResponseBytes = adapter.fetch?.max_response_bytes ?? 20_000_000;
  const maxTotalBytes = adapter.fetch?.max_total_bytes ?? 100_000_000;
  const delayMs = adapter.fetch?.delay_ms ?? 0;
  const retryCfg = adapter.fetch?.retry ?? {};
  const maxAttempts = retryCfg.max_attempts ?? 3;
  const backoffMs = retryCfg.backoff_ms ?? 500;
  const maxRetryDelayMs = retryCfg.max_delay_ms ?? 10_000;

  // Origin only -- path/query segments may carry secrets (an API key query
  // param, a signed path), so no diagnostic below ever includes the full URL.
  const origin = new URL(adapter.access.url).origin;
  const startedAt = Date.now();
  const budget = { bytes: 0, maxBytes: maxTotalBytes };

  const items = [];
  const statuses = [];
  const warnings = [];
  let pages = 0;
  let complete = true;
  let stopReason = hasPagination ? null : 'single_page';
  let lastBatchDigest = null;
  let totalAttempts = 0;
  let totalRetries = 0;

  for (let page = 1; page <= maxPages; page++) {
    const fetchContext = (extra = {}) => ({ fetch: { origin, page, pages, statuses: [...statuses], ...extra } });

    if (Date.now() - startedAt > maxDurationMs) {
      throw new IngestionError('E_FETCH_DEADLINE', `fetch exceeded max_duration_ms (${maxDurationMs})`,
        { details: fetchContext() });
    }
    if (signal?.aborted) {
      throw new IngestionError('E_ABORTED', 'fetch aborted', { details: fetchContext() });
    }

    const url = buildUrl(adapter, { page, since });

    let body;
    let attempt = 0;
    for (;;) {
      attempt++;
      totalAttempts++;
      const attemptSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
      let res;
      let failure;

      try {
        res = await fetchImpl(url, {
          method: adapter.fetch?.method ?? 'GET',
          headers: adapter.fetch?.headers ?? {},
          redirect: 'error',
          signal: attemptSignal,
        });
      } catch (err) {
        const code = classifyFetchError(err);
        // The old implementation concatenated the *full* request URL (query
        // string and all) straight into this message -- that's B14: an API
        // key or signed path landing in a report or CLI log. Only the
        // underlying reason travels in the message now; origin-only context
        // lives in .details.fetch, and the full cause stays in-memory only.
        const reason = code === 'E_TIMEOUT' ? `timed out after ${timeoutMs}ms`
          : code === 'E_ABORTED' ? 'aborted'
          : code === 'E_REDIRECT' ? 'unexpected redirect (redirects are not followed)'
          : (err?.message ?? String(err));
        failure = new IngestionError(code, `fetch failed: ${reason}`, { cause: err, details: fetchContext() });
      }

      if (!failure) {
        statuses.push(res.status);
        // Fail loudly. A UA-only bot gate shows up here as a 403 and must
        // never be swallowed into an empty result that looks like "no new
        // records", and a 400/404 on a later page is never treated as a
        // normal end-of-list -- only an actually empty or short batch
        // signals completion.
        if (!res.ok) {
          await drainQuietly(res);
          failure = new IngestionError('E_HTTP_STATUS', `unexpected HTTP status ${res.status}`,
            { details: fetchContext({ status: res.status }) });
        }
      }

      if (!failure) {
        // Content-Length is only an early rejection hint; actual bytes are
        // counted as the body streams in below, which is what actually
        // enforces the cap against a chunked response or a lying/absent
        // header.
        const contentLength = res.headers?.get?.('content-length');
        if (contentLength && Number(contentLength) > maxResponseBytes) {
          await drainQuietly(res);
          failure = new IngestionError('E_RESPONSE_LIMIT',
            `response too large: declared ${contentLength} bytes > max_response_bytes ${maxResponseBytes}`,
            { details: fetchContext() });
        }
      }

      if (!failure) {
        try {
          ({ json: body } = await readJsonBody(res, { signal: attemptSignal, maxResponseBytes, budget }));
        } catch (err) {
          if (err instanceof IngestionError) {
            err.details = { ...(err.details ?? {}), ...fetchContext() };
            failure = err;
          } else {
            // A stall mid-body (not just mid-header) aborts the same
            // attemptSignal, and the underlying stream read rejects with the
            // raw TimeoutError/AbortError, not one of ours -- classify it the
            // same way a connection-phase failure is classified, so callers
            // see one consistent error shape regardless of which phase the
            // abort landed in.
            const code = classifyFetchError(err);
            const reason = code === 'E_TIMEOUT' ? `timed out after ${timeoutMs}ms`
              : code === 'E_ABORTED' ? 'aborted'
              : (err?.message ?? String(err));
            failure = new IngestionError(code, `fetch failed: ${reason}`, { cause: err, details: fetchContext() });
          }
        }
      }

      if (!failure) break; // this attempt succeeded -- fall through to per-page processing

      if (!isRetryableError(failure) || attempt >= maxAttempts) throw failure;

      const retryAfterHeader = res?.headers?.get?.('retry-after') ?? undefined;
      const { delayMs: waitMs, deferred, retryAfterMs } = retryDelay({
        retryNumber: attempt, backoffMs, maxDelayMs: maxRetryDelayMs, retryAfter: retryAfterHeader, nowMs: Date.now(),
      });
      const remainingBudget = maxDurationMs - (Date.now() - startedAt);

      // A server-specified Retry-After that we can't honor -- either it's
      // past what retry.max_delay_ms allows, or past what's left of
      // max_duration_ms -- must fail loudly with the requested wait attached,
      // never silently shortened or silently ignored.
      if (deferred || (retryAfterMs !== null && retryAfterMs > remainingBudget)) {
        throw new IngestionError('E_RETRY_DEFERRED',
          'the server-requested retry delay exceeds the configured retry/fetch budget',
          { details: { ...fetchContext(), retry_after_ms: retryAfterMs } });
      }
      // No server directive involved (pure exponential backoff) and there
      // isn't enough budget left to wait and still attempt again -- give up
      // quietly with the failure that actually happened, rather than turning
      // a used-up retry budget into a distinct deadline error.
      if (waitMs > remainingBudget) throw failure;

      totalRetries++;
      await waitFor(waitMs, signal);
    }

    if (Date.now() - startedAt > maxDurationMs) {
      throw new IngestionError('E_FETCH_DEADLINE', `fetch exceeded max_duration_ms (${maxDurationMs})`,
        { details: fetchContext() });
    }

    // A path that resolves to a string is the sharpest edge case here: a
    // string is iterable, so an unguarded spread below would silently
    // consume it character-by-character and paginate to max_pages on
    // fabricated "records" instead of failing.
    const batch = getPath(body, adapter.records_path ?? '$') ?? [];
    if (!Array.isArray(batch)) {
      throw new IngestionError('E_RESPONSE_SHAPE',
        `records_path "${adapter.records_path ?? '$'}" resolved to ${typeof batch}, expected an array`,
        { details: fetchContext() });
    }
    pages++;

    if (batch.length > 0) {
      const digest = digestBatch(batch);
      if (lastBatchDigest !== null && digest === lastBatchDigest) {
        throw new IngestionError('E_PAGINATION_REPEAT',
          'pagination returned an exact repeat of the previous page — the endpoint may be ignoring the page parameter',
          { details: fetchContext() });
      }
      lastBatchDigest = digest;
    }

    if (items.length + batch.length > maxRecords) {
      throw new IngestionError('E_RECORD_LIMIT', `fetch exceeded max_records (${maxRecords})`,
        { details: fetchContext() });
    }
    // Not `items.push(...batch)` -- spreading an arbitrarily large batch as
    // call arguments risks blowing the engine's argument-count limit.
    for (const record of batch) items.push(record);

    if (!hasPagination) {
      complete = true; stopReason = 'single_page';
      break;
    }
    if (batch.length === 0) {
      complete = true; stopReason = 'empty_page';
      break;
    }
    if (perPage !== undefined && batch.length < perPage) {
      complete = true; stopReason = 'short_page';
      break;
    }
    if (page === maxPages) {
      // The batch still looks "full" (or per_page is unknown, so we can't
      // tell) and there is no next page left to request -- this is a
      // truncation, not a natural end, unless the adapter explicitly opted
      // into a bounded window.
      if (!allowTruncation) {
        throw new IngestionError('E_PAGE_LIMIT',
          `reached max_pages (${maxPages}) on a non-terminal page; set fetch.pagination.allow_truncation to accept a bounded window`,
          { details: fetchContext() });
      }
      complete = false; stopReason = 'max_pages';
      warnings.push({ code: 'W_PAGE_LIMIT', message: `stopped at max_pages (${maxPages}) with allow_truncation` });
      break;
    }

    // Reached only when the loop is actually continuing to another page.
    // delay_ms is a minimum pause between successful pages, not a per-attempt
    // or retry delay -- retries have their own backoff above.
    if (delayMs > 0) await waitFor(delayMs, signal);
  }

  return {
    items, pages, statuses,
    diagnostics: {
      // budget.bytes accumulates every byte actually read from the wire in
      // this call, including attempts that were later retried/failed --
      // not just the bytes belonging to whichever attempt finally succeeded.
      bytes: budget.bytes, pages, statuses: [...statuses], complete, stop_reason: stopReason, warnings,
      attempts: totalAttempts, retries: totalRetries,
    },
  };
}
