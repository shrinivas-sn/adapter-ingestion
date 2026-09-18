export class IngestionError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'IngestionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// E_FETCH is the one code whose message can legitimately embed text from an
// arbitrary injected fetchImpl/underlying network library (fetch.mjs folds
// err.message into it so an in-memory/CLI-adjacent reader still sees *why*,
// e.g. "DNS lookup failed") -- every other code is a message this package
// authored itself. The safe projection below must not re-serialize that
// untrusted text, so it is the one code always replaced with a generic
// phrase here; everything else passes through.
const UNSAFE_MESSAGE_CODES = new Set(['E_FETCH']);

// Projects an error down to fields safe to serialize into a report or CLI
// output: a stable code, a bounded message, the stage it failed at, and
// only the details a call site explicitly attached (fetch.mjs attaches
// origin + page/attempt, never a full URL/query/headers/credentials). An
// error that isn't one of ours (e.g. an arbitrary throw from an injected
// fetchImpl) is never trusted to carry a safe message of its own.
export function safeFailure(error, stage) {
  const isIngestion = error instanceof IngestionError;
  const code = isIngestion ? error.code : 'E_FETCH';
  const message = (isIngestion && !UNSAFE_MESSAGE_CODES.has(code))
    ? String(error.message).slice(0, 1000)
    : 'an unexpected error occurred';
  const out = { code, message, stage };
  if (isIngestion && error.details !== undefined) out.details = error.details;
  return out;
}

// Appends a safe secondary-failure projection onto an IngestionError without
// ever replacing its own code/message/details -- used wherever a cleanup or
// report-write step fails alongside (never instead of) the error that
// actually caused the run to fail. A plain non-IngestionError primary error
// is returned unchanged: there's no safe, typed place to attach the detail.
export function addSecondaryError(error, secondaryFailure) {
  if (!(error instanceof IngestionError)) return error;
  const existing = error.details?.secondary_errors ?? [];
  error.details = { ...(error.details ?? {}), secondary_errors: [...existing, secondaryFailure] };
  return error;
}
