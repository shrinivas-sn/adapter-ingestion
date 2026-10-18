import { jsonKind } from './json.mjs';

// A kind turns a response's raw bytes into the body that records_path walks:
//   { name, validate(adapter, need), parse({ bytes, contentType, url, adapter }) }
// It runs after the bounded read, so every kind inherits the same timeouts,
// byte caps, retries, redirect policy and pagination checks.
export const BUILTIN_KINDS = Object.freeze(new Map([
  [jsonKind.name, jsonKind],
]));

export function builtinKindNames() {
  return [...BUILTIN_KINDS.keys()].sort();
}

// Built-ins always win, so a caller can never swap out json-api behind an
// adapter's back. Caller kinds are looked up as own properties only: a kind
// named "constructor" must not resolve to Object.prototype.constructor.
export function resolveKind(name, callerKinds = undefined) {
  if (BUILTIN_KINDS.has(name)) return BUILTIN_KINDS.get(name);
  if (callerKinds === null || typeof callerKinds !== 'object') return null;
  if (typeof name !== 'string' || !Object.hasOwn(callerKinds, name)) return null;
  const kind = callerKinds[name];
  if (kind === null || typeof kind !== 'object' || typeof kind.parse !== 'function') return null;
  return {
    name,
    validate: (adapter, need) => kind.validate?.(adapter, need),
    parse: (input) => kind.parse(input),
  };
}
