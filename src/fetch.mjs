import { createHash } from 'node:crypto';
import { getPath } from './extract.mjs';
import { waitFor } from './http.mjs';
import { IngestionError } from './errors.mjs';
import { requestPage } from './fetch/request.mjs';
import { resolveKind, validateKindsOption, BUILTIN_KINDS } from './kinds/index.mjs';

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

// Response-order-sensitive: a source that echoes different content because
// records were reordered is not a repeat, but two responses byte-identical
// as delivered means the page parameter almost certainly did nothing.
function digestBatch(batch) {
  return createHash('sha256').update(JSON.stringify(batch)).digest('hex');
}

export async function fetchAll(adapter, { since, fetchImpl = fetch, signal, kinds } = {}) {
  validateKindsOption(kinds);
  const p = adapter.fetch?.pagination;
  const hasPagination = p !== undefined;
  const maxPages = p?.max_pages ?? 1;
  const perPage = p?.per_page; // undefined means "unknown" -- never infer a short page without it
  const allowTruncation = p?.allow_truncation ?? false;
  const timeoutMs = adapter.fetch?.timeout_ms ?? 30_000;
  const maxDurationMs = adapter.fetch?.max_duration_ms ?? 120_000;
  const maxRecords = adapter.fetch?.max_records ?? 5000;
  // fetchAll never validated the adapter itself (runIngest does), and it has
  // always parsed JSON whatever access.kind said; an unresolvable kind keeps
  // doing exactly that rather than crashing a direct caller.
  const kind = resolveKind(adapter.access?.kind, kinds) ?? BUILTIN_KINDS.get('json-api');
  const isBuiltinKind = BUILTIN_KINDS.get(kind.name) === kind;
  // A kind may set a tighter default than the global one (html does: its DOM
  // costs many times the page size); an explicit adapter value always wins.
  const maxResponseBytes = adapter.fetch?.max_response_bytes ?? kind.defaults?.max_response_bytes ?? 20_000_000;
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
  const counters = { totalAttempts: 0, totalRetries: 0 };

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

    const { buffer, contentType } = await requestPage({
      url, adapter, fetchImpl, signal, timeoutMs, maxResponseBytes, budget,
      retry: { maxAttempts, backoffMs, maxRetryDelayMs },
      deadline: { startedAt, maxDurationMs },
      fetchContext, counters, statuses,
    });

    // Parsed here, still before the deadline check below, exactly where the
    // JSON parse used to sit at the end of the attempt loop; a parse error
    // was never retryable, so lifting it out of the loop changes nothing.
    let body;
    try {
      body = await kind.parse({
        bytes: buffer, contentType, url, adapter,
        limits: { maxRecords, remainingRecords: maxRecords - items.length },
      });
    } catch (err) {
      // Built-in kinds throw our own typed errors, which pass through. Caller
      // kind code may throw anything -- even one of our errors carrying text
      // it chose -- that could hold a secret or a page fragment; like E_FETCH,
      // only our own message is reported, and the original stays as .cause.
      if (err instanceof IngestionError && isBuiltinKind) {
        err.details = { ...(err.details ?? {}), ...fetchContext() };
        throw err;
      }
      throw new IngestionError('E_PARSE', `kind "${kind.name}" failed to parse the response`,
        { cause: err, details: fetchContext() });
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
      let digest;
      try {
        digest = digestBatch(batch);
      } catch (err) {
        // Only a caller kind can get here: JSON.parse and html output always
        // serialise. A BigInt or a cycle is the kind's bug, not a network one.
        throw new IngestionError('E_PARSE', `kind "${kind.name}" returned records that cannot be serialised`,
          { cause: err, details: fetchContext() });
      }
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
      attempts: counters.totalAttempts, retries: counters.totalRetries,
    },
  };
}
