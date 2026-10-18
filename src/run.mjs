import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateAdapter } from './adapter.mjs';
import { validateFetchConfig } from './config.mjs';
import { validateKindsOption } from './kinds/index.mjs';
import { canonicalize } from './contract.mjs';
import { fetchAll } from './fetch.mjs';
import { extractAll } from './extract.mjs';
import { readIndex, appendRecords, withStoreLock } from './store.mjs';
import { splitByIndex } from './dedupe.mjs';
import { buildReport, writeReport, readEligibleHistory } from './report.mjs';
import { checkCanary } from './canary.mjs';
import { collectNotices } from './notices.mjs';
import { historySummary, readHistoryFile, appendHistory } from './history.mjs';
import { resolve } from 'node:path';
import { IngestionError, safeFailure, addSecondaryError } from './errors.mjs';

const MAX_WARNING_SAMPLES = 20;

function newestValueOf(records, fieldName) {
  if (!fieldName) return null;
  let best = null;
  for (const r of records) {
    const v = r.fields?.[fieldName];
    if (v === null || v === undefined) continue;
    const t = new Date(v).getTime();
    if (!Number.isFinite(t)) continue;
    if (best === null || t > new Date(best).getTime()) best = v;
  }
  return best;
}

// Excludes metadata/since/clock -- the fingerprint identifies the adapter's
// *behavioral contract* (what it fetches and how records are shaped), not
// incidental bookkeeping. Explicit defaults vs. omitted ones can produce a
// different fingerprint even for equivalent configs; documented, not fixed,
// since normalizing that away would need its own validated defaulting pass.
function computeAdapterFingerprint(adapter) {
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

function emptyStages() {
  return { fetched: 0, parsed: 0, fresh: 0, changed: 0, unchanged: 0, written: 0 };
}

function notEvaluatedCanary() {
  return { status: 'not_evaluated', breaches: [], skipped: [] };
}

// A median candidate must be a genuinely comparable, trustworthy past
// snapshot run of *this exact adapter behavior* on *this exact host* --
// never a legacy (pre-v2), incremental, different-fingerprint, failed, or
// (defensively) future-dated report. Repeated failures must never train the
// baseline downward: only outcome 'ok' counts.
function isEligibleForMedian(candidate, { host, fingerprint, startedAtIso }) {
  return candidate.report_version === 2
    && candidate.outcome === 'ok'
    && candidate.host === host
    && candidate.adapter_fingerprint === fingerprint
    && candidate.mode === 'snapshot'
    && typeof candidate.started_at === 'string'
    && candidate.started_at < startedAtIso;
}

// One finalize path for every exit -- success, a fatal mid-run failure, a
// pre-lock validation failure, and a lock-acquisition failure all build a
// report on this state and go through the exact same publish/precedence
// logic, rather than duplicating it per branch (section 6.2).
//
// - No primaryError, write succeeds -> returns {report, canary}.
// - No primaryError, write fails -> the write failure becomes primary
//   (E_REPORT_WRITE), report still attached so the caller has the data.
// - primaryError exists, write succeeds -> primaryError is rethrown,
//   report attached.
// - primaryError exists, write also fails -> primaryError is still what's
//   rethrown (never replaced); the write failure rides along as a safe
//   secondary detail.
//
// `history` ({ file, keep }) is passed only by in-lock exits: the history
// file is appended after the report, under the same lock, and a failure to
// append follows exactly the same precedence as a failed report write.
async function finalizeReport(runsDir, reportFields, primaryError, history = null) {
  const report = buildReport(reportFields);
  let writeErr = null;
  try {
    await writeReport(runsDir, report);
    if (history) await appendHistory(history.file, historySummary(report), { keep: history.keep });
  } catch (err) {
    writeErr = err;
  }

  if (primaryError) {
    if (writeErr) addSecondaryError(primaryError, safeFailure(writeErr, 'report'));
    primaryError.report = report;
    throw primaryError;
  }

  if (writeErr) {
    const err = new IngestionError('E_REPORT_WRITE', `failed to write report: ${writeErr.message}`, { cause: writeErr });
    err.report = report;
    throw err;
  }

  return { report, canary: reportFields.canary };
}

// Step 1: paths/now/signal are validated before anything else. An invalid
// storeFile/runsDir means there's no reliable place to even attempt a
// report, so this is the one case with no report at all -- not even an
// in-memory one.
function validateRunOptions({ paths, now, signal, kinds }) {
  if (typeof paths?.storeFile !== 'string' || paths.storeFile.length === 0) {
    throw new IngestionError('E_OPTIONS', 'paths.storeFile must be a nonempty string');
  }
  if (typeof paths?.runsDir !== 'string' || paths.runsDir.length === 0) {
    throw new IngestionError('E_OPTIONS', 'paths.runsDir must be a nonempty string');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new IngestionError('E_OPTIONS', 'now must be a valid Date');
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new IngestionError('E_OPTIONS', 'signal must be an AbortSignal');
  }
  if (paths.historyFile !== undefined) {
    if (typeof paths.historyFile !== 'string' || paths.historyFile.length === 0) {
      throw new IngestionError('E_OPTIONS', 'paths.historyFile must be a nonempty string');
    }
    if (resolve(paths.historyFile) === resolve(paths.storeFile)) {
      throw new IngestionError('E_OPTIONS', 'paths.historyFile must differ from paths.storeFile');
    }
  }
  validateKindsOption(kinds);
}

// Step 2: allocate run identity, logical start, and a monotonic elapsed
// clock -- finished_at is derived from logical start + elapsed, never a
// second independent wall-clock read, so it can't run backwards relative
// to started_at even if the system clock is adjusted mid-run.
function startRunClock(now) {
  const runId = randomUUID();
  const startedAtIso = now.toISOString();
  const monoStart = process.hrtime.bigint();
  const finishedAtIso = () => new Date(now.getTime() + Number(process.hrtime.bigint() - monoStart) / 1e6).toISOString();
  return { runId, startedAtIso, finishedAtIso };
}

// Per-run mutable state shared by the in-lock stages. ctx.stage is tracked
// explicitly rather than guessed from an error's shape after the fact --
// the safe `failure.stage` field should say where in the pipeline things
// actually stopped, not a heuristic approximation.
function newRunContext(base) {
  const ctx = {
    ...base,
    stage: 'fetch',
    stages: emptyStages(),
    warnings: [],
    warningCount: 0,
    errors: [],
    errorCount: 0,
    fetchDiagnostics: null,
    storage: { status: 'not_started', written: 0 },
    newestStalenessValue: null,
  };
  ctx.pushWarning = (w) => {
    ctx.warningCount++;
    if (ctx.warnings.length < MAX_WARNING_SAMPLES) ctx.warnings.push(w);
  };
  return ctx;
}

async function fetchStage(ctx) {
  ctx.stage = 'fetch';
  const { items, diagnostics } = await fetchAll(ctx.adapter,
    { since: ctx.since, fetchImpl: ctx.fetchImpl, signal: ctx.signal, kinds: ctx.kinds });
  ctx.fetchDiagnostics = diagnostics;
  ctx.stages.fetched = items.length;
  for (const w of diagnostics.warnings ?? []) ctx.pushWarning(w);
  return items;
}

function extractStage(ctx, items) {
  ctx.stage = 'extract';
  const extracted = extractAll(items, ctx.adapter, { fetchedAt: ctx.startedAtIso });
  ctx.errors = extracted.errors;
  ctx.errorCount = extracted.errorCount;
  ctx.stages.parsed = extracted.records.length;
  ctx.newestStalenessValue = newestValueOf(extracted.records, ctx.adapter.canary?.staleness_field);
  return extracted.records;
}

async function storeStage(ctx, records) {
  ctx.stage = 'store';
  const { stages } = ctx;
  const index = await readIndex(ctx.canonicalStoreFile, { onWarning: ctx.pushWarning });
  const { fresh, changed, unchanged } = splitByIndex(records, index);
  stages.fresh = fresh.length;
  stages.changed = changed.length;
  stages.unchanged = unchanged.length;

  if (ctx.signal?.aborted) {
    throw new IngestionError('E_ABORTED', 'aborted before store append');
  }

  const toWrite = [...fresh, ...changed];
  if (toWrite.length === 0) {
    ctx.storage = { status: 'unchanged', written: 0 };
    stages.written = 0;
    return;
  }
  try {
    const written = await appendRecords(ctx.canonicalStoreFile, toWrite, { maxLineBytes: ctx.store.max_line_bytes ?? 64_000_000 });
    ctx.storage = { status: 'committed', written };
    stages.written = written;
  } catch (appendErr) {
    // The batch may have partially landed -- a disk failure mid-write
    // is not an atomic transaction (section 5.1). Storage state is
    // genuinely unknown, not zero.
    ctx.storage = { status: 'uncertain', written: null };
    stages.written = null;
    throw appendErr;
  }
}

async function canaryStage(ctx) {
  ctx.stage = 'canary';
  const { adapter, mode, host, fingerprint, startedAtIso } = ctx;
  const medianWindow = adapter.canary?.median_window ?? 5;
  const isEligible = (candidate) => isEligibleForMedian(candidate, { host, fingerprint, startedAtIso });
  // With a history file, it is the only history source: runs/ may be a
  // fresh, empty checkout, and mixing both could count a run twice.
  let eligibleHistory = [];
  if (mode === 'snapshot') {
    eligibleHistory = ctx.historyFile
      ? await readHistoryFile(ctx.historyFile, medianWindow, isEligible, { onWarning: ctx.pushWarning })
      : await readEligibleHistory(ctx.runsDir, medianWindow, isEligible);
  }

  ctx.historyCount = eligibleHistory.length;
  const canaryInput = { stages: ctx.stages, mode, newest_staleness_value: ctx.newestStalenessValue };
  return checkCanary(canaryInput, eligibleHistory, adapter.canary ?? {}, { now: ctx.now });
}

// The report fields every in-lock exit shares; outcome, failure and canary
// are what differ between a completed run and a fatal one.
function inLockReportFields(ctx) {
  return {
    runId: ctx.runId, host: ctx.host, adapterFingerprint: ctx.fingerprint, mode: ctx.mode,
    startedAt: ctx.startedAtIso, finishedAt: ctx.finishedAtIso(),
    stages: ctx.stages, errors: ctx.errors, errorCount: ctx.errorCount,
    warnings: ctx.warnings, warningCount: ctx.warningCount,
    newestStalenessValue: ctx.newestStalenessValue, fetchDiagnostics: ctx.fetchDiagnostics,
    storage: ctx.storage,
  };
}

// Everything from fetch through the final report publish, inside the store
// lock. A failure anywhere in here -- including the success report's own
// write -- is finalized as a fatal report at the stage it reached.
async function lockedRun(ctx) {
  const history = ctx.historyFile
    ? { file: ctx.historyFile, keep: Math.max(50, 2 * (ctx.adapter.canary?.median_window ?? 5)) }
    : null;
  try {
    const items = await fetchStage(ctx);
    const records = extractStage(ctx, items);
    await storeStage(ctx, records);
    const canary = await canaryStage(ctx);
    return await finalizeReport(ctx.runsDir, {
      ...inLockReportFields(ctx),
      outcome: canary.status === 'stale' ? 'stale' : 'ok',
      canary,
      notices: collectNotices(ctx.adapter, { mode: ctx.mode, historyCount: ctx.historyCount, usesHistoryFile: Boolean(ctx.historyFile) }),
    }, null, history);
  } catch (err) {
    return finalizeReport(ctx.runsDir, {
      ...inLockReportFields(ctx),
      outcome: err.code === 'E_ABORTED' ? 'aborted' : 'error',
      failure: safeFailure(err, ctx.stage),
      canary: notEvaluatedCanary(),
      // No run facts survive a fatal run, so only adapter-level rules apply.
      notices: collectNotices(ctx.adapter, null),
    }, err, history);
  }
}

export async function runIngest({ adapter, paths, since, fetchImpl, signal, kinds, now = new Date(), store = { max_line_bytes: 64_000_000 } }) {
  validateRunOptions({ paths, now, signal, kinds });

  const { runId, startedAtIso, finishedAtIso } = startRunClock(now);
  const mode = since !== undefined ? 'incremental' : 'snapshot';
  const runsDir = paths.runsDir;

  // Step 3: validate the adapter (and, if supplied, since) within the
  // reportable lifecycle -- runsDir is already known-usable, so an invalid
  // adapter still gets a persisted error report, with null host/fingerprint
  // since neither can be trusted from an invalid config.
  const adapterCheck = validateAdapter(adapter, { kinds });
  const sinceCheck = since !== undefined ? validateFetchConfig(adapter, { since, kinds }) : { ok: true, errors: [] };
  const allErrors = [...new Set([...adapterCheck.errors, ...sinceCheck.errors])];
  if (allErrors.length > 0) {
    const err = new IngestionError('E_ADAPTER_INVALID', `invalid adapter: ${allErrors.join('; ')}`);
    return finalizeReport(runsDir, {
      runId, host: typeof adapter?.host === 'string' ? adapter.host : null, adapterFingerprint: null,
      mode, outcome: 'error', failure: safeFailure(err, 'validate'),
      startedAt: startedAtIso, finishedAt: finishedAtIso(), stages: emptyStages(),
      canary: notEvaluatedCanary(),
    }, err);
  }

  const host = adapter.host;
  const fingerprint = computeAdapterFingerprint(adapter);

  // Step 4: acquire the store lock; everything from fetch through the final
  // report publish happens inside it, so an older slow run can never write
  // after a newer one has already started.
  let capturedResult = null;
  try {
    return await withStoreLock(paths.storeFile, { runId }, async (canonicalStoreFile) => {
      const ctx = newRunContext({
        adapter, since, fetchImpl, signal, kinds, now, store, runsDir, historyFile: paths.historyFile,
        runId, host, fingerprint, mode, startedAtIso, finishedAtIso, canonicalStoreFile,
      });
      const finalized = await lockedRun(ctx);
      capturedResult = finalized;
      return finalized;
    });
  } catch (err) {
    if (err.report) throw err; // already fully finalized inside the lock above

    if (err.code === 'E_LOCK_RELEASE' && capturedResult) {
      // The in-lock work (including publishing its own report) already
      // succeeded; only the lock's own release failed afterward. Section
      // 5.2: "attempt to update this run's report to error; further report
      // failure stays secondary" -- republished under the same run_id, so
      // it replaces the same file rather than adding a second one.
      const updated = { ...capturedResult.report, outcome: 'error', failure: safeFailure(err, 'lock_release') };
      try {
        await writeReport(runsDir, updated);
      } catch (writeErr) {
        addSecondaryError(err, safeFailure(writeErr, 'report'));
      }
      err.report = updated;
      throw err;
    }

    // The callback never ran at all -- a lock-acquisition failure
    // (E_STORE_LOCKED, a symlinked store file, or a lock-init failure).
    // Gets its own unique error report with zero stages, since no store
    // mutation was ever attempted.
    return finalizeReport(runsDir, {
      runId, host, adapterFingerprint: fingerprint, mode,
      outcome: err.code === 'E_ABORTED' ? 'aborted' : 'error',
      failure: safeFailure(err, 'lock'),
      startedAt: startedAtIso, finishedAt: finishedAtIso(), stages: emptyStages(),
      canary: notEvaluatedCanary(),
    }, err);
  }
}

// CLI: node src/run.mjs <adapter.json> [--since YYYY-MM-DD]
// import.meta.url is always an absolute file:// URL; process.argv[1] is a
// plain path that Node does NOT absolutize, and on Windows uses backslashes
// with no leading slash -- a naive `file://${argv[1]}` comparison never
// matches there, or for any relative invocation. pathToFileURL normalizes
// both platforms and both relative/absolute forms the same way import.meta
// already does.
//
// Exit codes (section 6.2): 0 outcome ok; 1 stale/operational error/aborted;
// 2 usage/configuration (the run never got past validating options/adapter).
const CONFIG_ERROR_CODES = new Set(['E_OPTIONS', 'E_ADAPTER_INVALID']);
const USAGE = 'usage: node src/run.mjs <adapter.json> [--since YYYY-MM-DD]';

// Exactly one positional path plus an optional --since <value>. Everything
// else (missing path, extra positional, duplicate/valueless --since, any
// unrecognized flag) is a usage error, not silently ignored.
function parseCliArgs(args) {
  let adapterPath;
  let since;
  let sinceSeen = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--since') {
      if (sinceSeen) return { usageError: '--since may only be given once' };
      sinceSeen = true;
      i++;
      if (i >= args.length) return { usageError: '--since requires a value' };
      since = args[i];
    } else if (arg.startsWith('--')) {
      return { usageError: `unknown flag: ${arg}` };
    } else if (adapterPath !== undefined) {
      return { usageError: `unexpected extra argument: ${arg}` };
    } else {
      adapterPath = arg;
    }
  }
  if (adapterPath === undefined) return { usageError: 'an adapter.json path is required' };
  return { adapterPath, since };
}

async function runCli(argv) {
  const parsed = parseCliArgs(argv);
  if (parsed.usageError) {
    console.error(`${USAGE}\n${parsed.usageError}`);
    return 2;
  }
  const { adapterPath, since } = parsed;

  let adapter;
  try {
    adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
  } catch (err) {
    // Never a raw stack trace, and never a snippet of the file's own content
    // (a JSON SyntaxError's message can otherwise embed one) -- just which
    // of the two things failed.
    const reason = err.code === 'ENOENT' ? 'file not found'
      : err.code === 'EACCES' ? 'permission denied'
      : err instanceof SyntaxError ? 'not valid JSON'
      : 'could not be read';
    console.error(`failed to load adapter "${adapterPath}": ${reason}`);
    return 2;
  }

  // A safe host is required before any path is derived from it -- an
  // invalid/missing host must never produce a fabricated `runs/undefined`
  // (or similar) report location. The full hostname-safety check still
  // belongs to validateAdapter/runIngest; this only guards the CLI's own
  // string interpolation into a default path.
  if (typeof adapter?.host !== 'string' || adapter.host.length === 0) {
    console.error(`adapter "${adapterPath}" has no usable "host" -- refusing to derive a store/report path from it`);
    return 2;
  }

  // Registered only for the duration of this run, never at module import --
  // a library consumer importing run.mjs must never get process-wide signal
  // handlers installed as a side effect.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { report, canary } = await runIngest({
      adapter,
      paths: { storeFile: `store/${adapter.host}.jsonl`, runsDir: `runs/${adapter.host}` },
      since,
      signal: ac.signal,
    });
    console.log(JSON.stringify({ report: { outcome: report.outcome, stages: report.stages }, canary }, null, 2));
    return report.outcome === 'ok' ? 0 : 1;
  } catch (err) {
    console.error(`ingest failed: ${err.message}`);
    return CONFIG_ERROR_CODES.has(err.code) ? 2 : 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exitCode, not exit() -- lets any already-scheduled I/O (a report write in
  // flight) finish draining naturally instead of being truncated, on every
  // exit path including a SIGINT/SIGTERM-triggered abort above.
  process.exitCode = await runCli(process.argv.slice(2));
}
