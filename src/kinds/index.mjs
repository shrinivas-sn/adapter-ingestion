import { IngestionError } from '../errors.mjs';
import { jsonKind } from './json.mjs';
import { htmlKind } from './html.mjs';

// A kind turns a response's raw bytes into the body that records_path walks:
//   { name, validate(adapter, need), parse({ bytes, contentType, url, adapter }) }
// It runs after the bounded read, so every kind inherits the same timeouts,
// byte caps, retries, redirect policy and pagination checks.
export const BUILTIN_KINDS = Object.freeze(new Map([
  [jsonKind.name, jsonKind],
  [htmlKind.name, htmlKind],
]));

export function builtinKindNames() {
  return [...BUILTIN_KINDS.keys()].sort();
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// The `kinds` option is caller code, not adapter content, so a mistake in it
// is E_OPTIONS (like a bad `paths`), thrown before any report exists.
export function validateKindsOption(kinds) {
  if (kinds === undefined) return;
  if (!isPlainObject(kinds)) {
    throw new IngestionError('E_OPTIONS', 'kinds must be a plain object of name -> kind');
  }
  for (const [name, kind] of Object.entries(kinds)) {
    if (BUILTIN_KINDS.has(name)) {
      throw new IngestionError('E_OPTIONS', `kinds.${name} shadows a built-in kind`);
    }
    if (kind === null || typeof kind !== 'object' || typeof kind.parse !== 'function') {
      throw new IngestionError('E_OPTIONS', `kinds.${name} must be an object with a parse function`);
    }
    if (kind.validate !== undefined && typeof kind.validate !== 'function') {
      throw new IngestionError('E_OPTIONS', `kinds.${name}.validate must be a function when present`);
    }
  }
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
