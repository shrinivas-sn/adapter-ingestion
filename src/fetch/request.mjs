import { readBodyBytes, retryDelay, waitFor } from '../http.mjs';
import { IngestionError } from '../errors.mjs';

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

// One page: every attempt, retry, Retry-After decision and the bounded body
// read. Parsing is deliberately not here -- the caller hands the bytes to the
// adapter's kind -- so every format gets the same transport guarantees.
//
// `statuses` and `counters` are the caller's own array/object, mutated in
// place: fetchAll's diagnostics and every fetchContext() snapshot must see
// attempts made here exactly as they did when this loop lived inline.
export async function requestPage({
  url, adapter, headers, fetchImpl, signal, timeoutMs, maxResponseBytes, budget,
  retry: { maxAttempts, backoffMs, maxRetryDelayMs },
  deadline: { startedAt, maxDurationMs },
  fetchContext, counters, statuses,
}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    counters.totalAttempts++;
    const attemptSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    let res;
    let failure;
    let buffer;

    try {
      res = await fetchImpl(url, {
        method: adapter.fetch?.method ?? 'GET',
        // Resolved once by fetchAll (src/fetch/headers.mjs); may hold secrets.
        headers,
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
        ({ buffer } = await readBodyBytes(res, { signal: attemptSignal, maxResponseBytes, budget }));
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

    if (!failure) {
      return { buffer, contentType: res.headers?.get?.('content-type') ?? null };
    }

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

    counters.totalRetries++;
    await waitFor(waitMs, signal);
  }
}
