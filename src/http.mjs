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
