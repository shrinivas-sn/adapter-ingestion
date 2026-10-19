import { IngestionError } from '../errors.mjs';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

// Turns adapter.fetch.headers into the plain object every request sends. A
// { env, optional? } value is read from the environment here, once per run,
// so every page sends the same value. The value itself is a secret: it is
// never put in a message, `details` or `cause`. Node's own Headers error text
// quotes an invalid value, which is why that error is checked here and then
// dropped rather than attached.
//
// Anything that is not a reference is copied unchanged, so a caller of
// fetchAll that skipped validateAdapter keeps the 0.5 behaviour.
/**
 * @param {Record<string, any> | undefined} headers
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, any>}
 */
export function resolveHeaders(headers, env = process.env) {
  if (headers === undefined || headers === null) return {};
  if (!isPlainObject(headers)) return headers;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isPlainObject(value) || typeof value.env !== 'string') {
      out[name] = value;
      continue;
    }
    const details = { header: name, env: value.env };
    // Only a string counts: process.env also answers inherited names such as
    // toString or __proto__ with a function or object.
    const raw = env[value.env];
    if (typeof raw !== 'string' || raw === '') {
      if (value.optional === true) continue;
      throw new IngestionError('E_HEADER_ENV',
        `fetch.headers.${name} reads environment variable ${value.env}, which is not set`, { details });
    }
    let valid = true;
    try {
      // eslint-disable-next-line no-new -- native Headers decides what a valid value is.
      new Headers([[name, raw]]);
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new IngestionError('E_HEADER_ENV',
        `fetch.headers.${name}: environment variable ${value.env} does not hold a valid header value`, { details });
    }
    out[name] = raw;
  }
  return out;
}
