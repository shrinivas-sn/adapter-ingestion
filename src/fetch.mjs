import { getPath } from './extract.mjs';
import { readJsonBody } from './http.mjs';
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

export async function fetchAll(adapter, { since, fetchImpl = fetch, signal } = {}) {
  const p = adapter.fetch?.pagination;
  const maxPages = p?.max_pages ?? 1;
  const perPage = p?.per_page ?? Infinity;
  const timeoutMs = adapter.fetch?.timeout_ms ?? 30_000;
  const maxDurationMs = adapter.fetch?.max_duration_ms ?? 120_000;
  const maxRecords = adapter.fetch?.max_records ?? 5000;
  const maxResponseBytes = adapter.fetch?.max_response_bytes ?? 20_000_000;
  const maxTotalBytes = adapter.fetch?.max_total_bytes ?? 100_000_000;

  // Origin only -- path/query segments may carry secrets (an API key query
  // param, a signed path), so no diagnostic below ever includes the full URL.
  const origin = new URL(adapter.access.url).origin;
  const startedAt = Date.now();
  const budget = { bytes: 0, maxBytes: maxTotalBytes };

  const items = [];
  const statuses = [];
  let pages = 0;
  let totalBytes = 0;

  for (let page = 1; page <= maxPages; page++) {
    const fetchContext = () => ({ fetch: { origin, page, pages, statuses: [...statuses] } });

    if (Date.now() - startedAt > maxDurationMs) {
      throw new IngestionError('E_FETCH_DEADLINE', `fetch exceeded max_duration_ms (${maxDurationMs})`,
        { details: fetchContext() });
    }
    if (signal?.aborted) {
      throw new IngestionError('E_ABORTED', 'fetch aborted', { details: fetchContext() });
    }

    const url = buildUrl(adapter, { page, since });
    const attemptSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);

    let res;
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
      throw new IngestionError(code, `fetch failed: ${reason}`, { cause: err, details: fetchContext() });
    }
    statuses.push(res.status);

    // Fail loudly. A UA-only bot gate shows up here as a 403 and must never be
    // swallowed into an empty result that looks like "no new records".
    if (!res.ok) {
      await drainQuietly(res);
      throw new IngestionError('E_HTTP_STATUS', `unexpected HTTP status ${res.status}`,
        { details: fetchContext() });
    }

    // Content-Length is only an early rejection hint; actual bytes are
    // counted as the body streams in below, which is what actually enforces
    // the cap against a chunked response or a lying/absent header.
    const contentLength = res.headers?.get?.('content-length');
    if (contentLength && Number(contentLength) > maxResponseBytes) {
      await drainQuietly(res);
      throw new IngestionError('E_RESPONSE_LIMIT',
        `response too large: declared ${contentLength} bytes > max_response_bytes ${maxResponseBytes}`,
        { details: fetchContext() });
    }

    let body;
    let bytes;
    try {
      ({ json: body, bytes } = await readJsonBody(res, { signal: attemptSignal, maxResponseBytes, budget }));
    } catch (err) {
      if (err instanceof IngestionError) {
        err.details = { ...(err.details ?? {}), ...fetchContext() };
        throw err;
      }
      // A stall mid-body (not just mid-header) aborts the same attemptSignal,
      // and the underlying stream read rejects with the raw TimeoutError/
      // AbortError, not one of ours -- classify it the same way a
      // connection-phase failure is classified, so callers see one
      // consistent error shape regardless of which phase the abort landed in.
      const code = classifyFetchError(err);
      const reason = code === 'E_TIMEOUT' ? `timed out after ${timeoutMs}ms`
        : code === 'E_ABORTED' ? 'aborted'
        : (err?.message ?? String(err));
      throw new IngestionError(code, `fetch failed: ${reason}`, { cause: err, details: fetchContext() });
    }
    totalBytes += bytes;

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
    if (items.length + batch.length > maxRecords) {
      throw new IngestionError('E_RECORD_LIMIT', `fetch exceeded max_records (${maxRecords})`,
        { details: fetchContext() });
    }
    // Not `items.push(...batch)` -- spreading an arbitrarily large batch as
    // call arguments risks blowing the engine's argument-count limit.
    for (const record of batch) items.push(record);
    if (batch.length < perPage) break;
  }

  return { items, pages, statuses, diagnostics: { bytes: totalBytes, pages, statuses: [...statuses] } };
}
