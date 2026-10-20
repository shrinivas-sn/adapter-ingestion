import { IngestionError } from '../errors.mjs';
import { jsonKind } from './json.mjs';
import { htmlKind } from './html.mjs';
import { csvKind } from './csv.mjs';

// A kind turns a response's raw bytes into the body that records_path walks:
//   { name, validate(adapter, need), parse({ bytes, contentType, url, adapter }) }
// It runs after the bounded read, so every kind inherits the same timeouts,
// byte caps, retries, redirect policy and pagination checks.
export const BUILTIN_KINDS = Object.freeze(new Map(/** @type {Array<[string, import('../types.mjs').Kind]>} */ ([
  [jsonKind.name, jsonKind],
  [htmlKind.name, htmlKind],
  [csvKind.name, csvKind],
])));

// The kinds that existed before 0.8 can never be replaced by a caller kind.
// A built-in added later yields to a kind the caller registers under the
// same name, so a new built-in never breaks an existing registration (the
// README taught `kinds: { csv }` before csv was built in).
const PROTECTED_KINDS = Object.freeze(new Set(['json-api', 'html']));

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
    if (PROTECTED_KINDS.has(name)) {
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

// Protected built-ins always win, so a caller can never swap out json-api
// behind an adapter's back; a newer built-in is used only when the caller
// registered nothing under its name. Caller kinds are looked up as own
// properties only: a kind named "constructor" must not resolve to
// Object.prototype.constructor.
/**
 * @param {any} name
 * @param {Record<string, import('../types.mjs').Kind>} [callerKinds]
 * @returns {import('../types.mjs').Kind | null}
 */
export function resolveKind(name, callerKinds = undefined) {
  if (PROTECTED_KINDS.has(name)) return BUILTIN_KINDS.get(name);
  const builtin = BUILTIN_KINDS.get(name) ?? null;
  if (callerKinds === null || typeof callerKinds !== 'object') return builtin;
  if (typeof name !== 'string' || !Object.hasOwn(callerKinds, name)) return builtin;
  const kind = callerKinds[name];
  // A registration that is not a kind fails as on 0.7, never quietly
  // falling back to a built-in the caller did not ask for.
  if (kind === null || typeof kind !== 'object' || typeof kind.parse !== 'function') return null;
  return {
    name,
    validate: (adapter, need) => kind.validate?.(adapter, need),
    parse: (input) => kind.parse(input),
  };
}
