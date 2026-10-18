import { createHash } from 'node:crypto';
import { canonicalize } from './contract.mjs';

// Internal (not a package subpath): shared by runIngest and the CLI's
// doctor, so both judge "comparable past runs" exactly the same way.

// Excludes metadata/since/clock -- the fingerprint identifies the adapter's
// *behavioral contract* (what it fetches and how records are shaped), not
// incidental bookkeeping. Explicit defaults vs. omitted ones can produce a
// different fingerprint even for equivalent configs; documented, not fixed,
// since normalizing that away would need its own validated defaulting pass.
export function computeAdapterFingerprint(adapter) {
  const canonicalInput = {
    version: adapter.version, host: adapter.host, access: adapter.access,
    fetch: adapter.fetch ?? {}, records_path: adapter.records_path ?? '$',
    map: adapter.map, required: adapter.required ?? [], canary: adapter.canary ?? {},
    // html decides what a record is, so it is part of the contract; added only
    // when present so every json-api fingerprint stays byte-identical.
    ...(adapter.html !== undefined ? { html: adapter.html } : {}),
  };
  return createHash('sha256').update(canonicalize(canonicalInput)).digest('hex');
}

// A median candidate must be a genuinely comparable, trustworthy past
// snapshot run of *this exact adapter behavior* on *this exact host* --
// never a legacy (pre-v2), incremental, different-fingerprint, failed, or
// (defensively) future-dated report. Repeated failures must never train the
// baseline downward: only outcome 'ok' counts.
export function isEligibleForMedian(candidate, { host, fingerprint, startedAtIso }) {
  return candidate.report_version === 2
    && candidate.outcome === 'ok'
    && candidate.host === host
    && candidate.adapter_fingerprint === fingerprint
    && candidate.mode === 'snapshot'
    && typeof candidate.started_at === 'string'
    && candidate.started_at < startedAtIso;
}
