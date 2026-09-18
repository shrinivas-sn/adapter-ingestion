import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateAdapter } from './adapter.mjs';
import { validateFetchConfig } from './config.mjs';
import { canonicalize } from './contract.mjs';
import { fetchAll } from './fetch.mjs';
import { extractAll } from './extract.mjs';
import { readIndex, appendRecords, withStoreLock } from './store.mjs';
import { splitByIndex } from './dedupe.mjs';
import { buildReport, writeReport, readEligibleHistory } from './report.mjs';
import { checkCanary } from './canary.mjs';
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
async function finalizeReport(runsDir, reportFields, primaryError) {
  const report = buildReport(reportFields);
  let writeErr = null;
  try {
    await writeReport(runsDir, report);
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

export async function runIngest({ adapter, paths, since, fetchImpl, signal, now = new Date(), store = { max_line_bytes: 64_000_000 } }) {
  // Step 1: paths/now/signal are validated before anything else. An invalid
  // storeFile/runsDir means there's no reliable place to even attempt a
  // report, so this is the one case with no report at all -- not even an
  // in-memory one.
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

  // Step 2: allocate run identity, logical start, and a monotonic elapsed
  // clock -- finished_at is derived from logical start + elapsed, never a
  // second independent wall-clock read, so it can't run backwards relative
  // to started_at even if the system clock is adjusted mid-run.
  const runId = randomUUID();
  const startedAtIso = now.toISOString();
  const monoStart = process.hrtime.bigint();
  const finishedAtIso = () => new Date(now.getTime() + Number(process.hrtime.bigint() - monoStart) / 1e6).toISOString();
  const mode = since !== undefined ? 'incremental' : 'snapshot';
  const runsDir = paths.runsDir;

  // Step 3: validate the adapter (and, if supplied, since) within the
  // reportable lifecycle -- runsDir is already known-usable, so an invalid
  // adapter still gets a persisted error report, with null host/fingerprint
  // since neither can be trusted from an invalid config.
  const adapterCheck = validateAdapter(adapter);
  const sinceCheck = since !== undefined ? validateFetchConfig(adapter, { since }) : { ok: true, errors: [] };
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
      const stages = emptyStages();
      const warnings = [];
      let warningCount = 0;
      const pushWarning = (w) => {
        warningCount++;
        if (warnings.length < MAX_WARNING_SAMPLES) warnings.push(w);
      };

      let fetchDiagnostics = null;
      let storage = { status: 'not_started', written: 0 };
      let newestStalenessValue = null;
      let errors = [];
      let errorCount = 0;
      // Tracked explicitly rather than guessed from an error's shape after
      // the fact -- the safe `failure.stage` field should say where in the
      // pipeline things actually stopped, not a heuristic approximation.
      let stage = 'fetch';

      const buildFatalFields = (err) => ({
        runId, host, adapterFingerprint: fingerprint, mode,
        outcome: err.code === 'E_ABORTED' ? 'aborted' : 'error',
        failure: safeFailure(err, stage),
        startedAt: startedAtIso, finishedAt: finishedAtIso(),
        stages, errors, errorCount, warnings, warningCount,
        newestStalenessValue, fetchDiagnostics, storage,
        canary: notEvaluatedCanary(),
      });

      try {
        const { items, diagnostics } = await fetchAll(adapter, { since, fetchImpl, signal });
        fetchDiagnostics = diagnostics;
        stages.fetched = items.length;
        for (const w of diagnostics.warnings ?? []) pushWarning(w);

        stage = 'extract';
        const extracted = extractAll(items, adapter, { fetchedAt: startedAtIso });
        errors = extracted.errors;
        errorCount = extracted.errorCount;
        stages.parsed = extracted.records.length;
        newestStalenessValue = newestValueOf(extracted.records, adapter.canary?.staleness_field);

        stage = 'store';
        const index = await readIndex(canonicalStoreFile, { onWarning: pushWarning });
        const { fresh, changed, unchanged } = splitByIndex(extracted.records, index);
        stages.fresh = fresh.length;
        stages.changed = changed.length;
        stages.unchanged = unchanged.length;

        if (signal?.aborted) {
          throw new IngestionError('E_ABORTED', 'aborted before store append');
        }

        const toWrite = [...fresh, ...changed];
        if (toWrite.length === 0) {
          storage = { status: 'unchanged', written: 0 };
          stages.written = 0;
        } else {
          try {
            const written = await appendRecords(canonicalStoreFile, toWrite, { maxLineBytes: store.max_line_bytes ?? 64_000_000 });
            storage = { status: 'committed', written };
            stages.written = written;
          } catch (appendErr) {
            // The batch may have partially landed -- a disk failure mid-write
            // is not an atomic transaction (section 5.1). Storage state is
            // genuinely unknown, not zero.
            storage = { status: 'uncertain', written: null };
            stages.written = null;
            throw appendErr;
          }
        }

        stage = 'canary';

        const medianWindow = adapter.canary?.median_window ?? 5;
        const eligibleHistory = mode === 'snapshot'
          ? await readEligibleHistory(runsDir, medianWindow,
            (candidate) => isEligibleForMedian(candidate, { host, fingerprint, startedAtIso }))
          : [];

        const canaryInput = { stages, mode, newest_staleness_value: newestStalenessValue };
        const canary = checkCanary(canaryInput, eligibleHistory, adapter.canary ?? {}, { now });

        const finalized = await finalizeReport(runsDir, {
          runId, host, adapterFingerprint: fingerprint, mode,
          outcome: canary.status === 'stale' ? 'stale' : 'ok',
          startedAt: startedAtIso, finishedAt: finishedAtIso(),
          stages, errors, errorCount, warnings, warningCount,
          newestStalenessValue, fetchDiagnostics, storage, canary,
        }, null);
        capturedResult = finalized;
        return finalized;
      } catch (err) {
        return finalizeReport(runsDir, buildFatalFields(err), err);
      }
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

// CLI: node src/run.mjs adapters/<HOST>.adapter.json [--since YYYY-MM-DD]
// import.meta.url is always an absolute file:// URL; process.argv[1] is a
// plain path that Node does NOT absolutize, and on Windows uses backslashes
// with no leading slash -- a naive `file://${argv[1]}` comparison never
// matches there, or for any relative invocation. pathToFileURL normalizes
// both platforms and both relative/absolute forms the same way import.meta
// already does.
//
// Exit codes (section 6.2): 0 outcome ok; 1 stale/operational error/aborted;
// 2 usage/configuration (the run never got past validating options/adapter).
// Full argv hardening and signal handling are Task 11's job -- this is the
// outcome-to-exit-code mapping this task's lifecycle model requires.
const CONFIG_ERROR_CODES = new Set(['E_OPTIONS', 'E_ADAPTER_INVALID']);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const adapterPath = process.argv[2];
  if (!adapterPath) { console.error('usage: node src/run.mjs <adapter.json> [--since YYYY-MM-DD]'); process.exit(2); }
  const sinceIdx = process.argv.indexOf('--since');
  const adapter = JSON.parse(await readFile(adapterPath, 'utf8'));
  try {
    const { report, canary } = await runIngest({
      adapter,
      paths: { storeFile: `store/${adapter.host}.jsonl`, runsDir: `runs/${adapter.host}` },
      since: sinceIdx > -1 ? process.argv[sinceIdx + 1] : undefined,
    });
    console.log(JSON.stringify({ report: { outcome: report.outcome, stages: report.stages }, canary }, null, 2));
    process.exit(report.outcome === 'ok' ? 0 : 1);
  } catch (err) {
    console.error(`ingest failed: ${err.message}`);
    process.exit(CONFIG_ERROR_CODES.has(err.code) ? 2 : 1);
  }
}
