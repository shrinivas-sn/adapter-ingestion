import { IngestionError } from './errors.mjs';

// Reads a Response body while enforcing an actual, observed byte cap --
// Content-Length is only ever an early rejection hint upstream (fetch.mjs),
// never trusted here: it can be absent, wrong, or describe the compressed
// size while Fetch already hands us decompressed bytes. Rejects as soon as
// the cap is crossed, before the rest of the body is read into memory.
//
// `budget`, when supplied, is one mutable { bytes, maxBytes } object the
// caller reuses across every attempt/page of a single fetchAll invocation,
// so max_total_bytes is enforced across the whole run, not per response.
export async function readJsonBody(response, { signal, maxResponseBytes, budget } = {}) {
  if (!response.body) {
    // A response with no body stream (some minimal doubles, a 204) has
    // nothing to bound-read; treat it as an empty body rather than crashing
    // on a null getReader() call.
    return { json: JSON.parse('null'), bytes: 0 };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      if (signal?.aborted) {
        throw new IngestionError('E_ABORTED', 'aborted while reading response body');
      }
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (maxResponseBytes !== undefined && bytes > maxResponseBytes) {
        throw new IngestionError('E_RESPONSE_LIMIT',
          `response exceeded max_response_bytes (${maxResponseBytes})`);
      }
      if (budget !== undefined) {
        budget.bytes += value.byteLength;
        if (budget.bytes > budget.maxBytes) {
          throw new IngestionError('E_TOTAL_BYTES_LIMIT',
            `response exceeded max_total_bytes (${budget.maxBytes}) across attempts/pages`);
        }
      }
      chunks.push(value);
    }
  } finally {
    // Release/cancel unconditionally so an early rejection (over budget,
    // aborted) tears the connection down instead of leaving it dangling —
    // cancelling an already-finished reader is a harmless no-op.
    try { await reader.cancel(); } catch { /* already closed or errored */ }
  }

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  let json;
  try {
    json = text.length === 0 ? null : JSON.parse(text);
  } catch {
    throw new IngestionError('E_RESPONSE_JSON', 'response body is not valid JSON');
  }
  return { json, bytes };
}

// Retry-After is either an integer count of seconds or an HTTP-date (RFC
// 7231 section 7.1.3). A past date collapses to 0 (retry now); anything that
// is neither a valid integer nor a parseable date returns null so the caller
// falls back to local exponential backoff instead of guessing.
function parseRetryAfterMs(value, nowMs) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

// Pure -- computes a delay without waiting, so it can be exhaustively unit
// tested with injected nowMs/random. retryNumber starts at 1 for the first
// retry (the attempt that just failed was attempt 1; this call is deciding
// the wait before attempt 2).
//
// Full jitter: a random delay uniformly in [0, ceiling] rather than always
// waiting the full exponential ceiling -- this is what actually prevents a
// thundering herd of retrying clients from re-synchronizing on the same
// wall-clock instants.
//
// A server-supplied Retry-After is a floor, never a ceiling this function
// silently shortens ("never retry earlier than requested"): the returned
// delay is max(jitter, retryAfterMs). If honoring it would need more time
// than retry.max_delay_ms allows, the caller must fail loudly
// (E_RETRY_DEFERRED) instead of either ignoring the server or waiting past
// the configured ceiling.
export function retryDelay({ retryNumber, backoffMs, maxDelayMs, retryAfter, nowMs = Date.now(), random = Math.random }) {
  const ceiling = Math.min(maxDelayMs, backoffMs * 2 ** (retryNumber - 1));
  const jitter = random() * ceiling;
  const retryAfterMs = parseRetryAfterMs(retryAfter, nowMs);

  if (retryAfterMs === null) {
    return { delayMs: jitter, deferred: false, retryAfterMs: null };
  }
  if (retryAfterMs > maxDelayMs) {
    return { delayMs: null, deferred: true, retryAfterMs };
  }
  return { delayMs: Math.max(jitter, retryAfterMs), deferred: false, retryAfterMs };
}

// Abortable delay for actual retry/pacing waits (as opposed to retryDelay's
// pure arithmetic). Always removes its timer/listener on the way out so a
// long-lived AbortSignal never accumulates dangling listeners across many
// waits in one fetchAll call.
export function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new IngestionError('E_ABORTED', 'aborted while waiting'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new IngestionError('E_ABORTED', 'aborted while waiting'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort);
  });
}
