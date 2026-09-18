import { mkdir, open, rename, readdir, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { IngestionError } from './errors.mjs';

const MAX_SAMPLES = 20;

export function buildReport({
  host = null, startedAt, finishedAt, stages,
  errors = [], errorCount = errors.length,
  runId = randomUUID(),
  adapterFingerprint = null,
  mode = 'snapshot',
  outcome = 'ok',
  failure = null,
  // Legacy string mirror of failure -- kept for any consumer reading a
  // simple message rather than the structured {code,message,stage} shape.
  fatalError = failure?.message ?? null,
  secondaryErrors = [],
  warnings = [],
  warningCount = warnings.length,
  newestStalenessValue = null,
  canary = { status: 'not_evaluated', breaches: [], skipped: [] },
  fetchDiagnostics = null,
  storage = { status: 'not_started', written: 0 },
}) {
  const statuses = fetchDiagnostics?.statuses ?? [];
  return {
    report_version: 2,
    run_id: runId,
    adapter_fingerprint: adapterFingerprint,
    mode,
    outcome,
    host,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
    stages,
    error_count: errorCount,
    // Set only when the run threw before completing -- a cron with no
    // report artifact at all fails invisibly for weeks, but so does one
    // whose report never says *why* a run came up empty.
    errors: errors.slice(0, MAX_SAMPLES),
    fatal_error: fatalError,
    failure,
    secondary_errors: secondaryErrors,
    warnings: warnings.slice(0, MAX_SAMPLES),
    warning_count: warningCount,
    newest_staleness_value: newestStalenessValue,
    canary,
    fetch: {
      pages: fetchDiagnostics?.pages ?? 0,
      attempts: fetchDiagnostics?.attempts ?? 0,
      retries: fetchDiagnostics?.retries ?? 0,
      statuses: statuses.slice(0, MAX_SAMPLES),
      status_count: statuses.length,
      bytes: fetchDiagnostics?.bytes ?? 0,
      complete: fetchDiagnostics?.complete ?? false,
      stop_reason: fetchDiagnostics?.stop_reason ?? null,
    },
    storage,
  };
}

// A colon/period in an ISO timestamp is unsafe in a filename on at least one
// major platform (Windows) -- substituted uniformly, which preserves
// lexicographic (= chronological) ordering across filenames the same way
// the original ISO string did.
function safeTimestampFragment(iso) {
  return String(iso).replace(/[:.]/g, '-');
}

function reportFilename(report) {
  return `report-${safeTimestampFragment(report.started_at)}-${report.run_id}.json`;
}

// Published via an exclusive, uniquely-named temporary sibling, synced,
// closed, then renamed into place -- a crash mid-write can never leave a
// half-written file sitting at the final name a reader would pick up, and
// the run_id in the final name means two reports with the exact same
// started_at (a fast successive run, a clock with second resolution) still
// get distinct files rather than one silently overwriting the other.
export async function writeReport(dir, report) {
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw new IngestionError('E_REPORT_WRITE', `failed to create reports directory: ${err.message}`, { cause: err });
  }
  const finalPath = join(dir, reportFilename(report));
  const tempPath = `${finalPath}.${randomUUID()}.tmp`;

  const body = JSON.stringify(report, null, 2);
  let handle;
  try {
    handle = await open(tempPath, 'wx');
    await handle.write(body);
    await handle.sync();
  } catch (err) {
    try { await handle?.close(); } catch { /* already closed or errored */ }
    try { await unlink(tempPath); } catch { /* best-effort cleanup of our own temp file */ }
    throw new IngestionError('E_REPORT_WRITE', `failed to write report: ${err.message}`, { cause: err });
  }
  await handle.close();

  try {
    await rename(tempPath, finalPath);
  } catch (err) {
    throw new IngestionError('E_REPORT_WRITE', `failed to publish report: ${err.message}`, { cause: err });
  }
  return finalPath;
}

// A report file is `report-<...>.json`; a crash-left or in-flight temp
// sibling is `report-<...>.json.<uuid>.tmp` -- it doesn't end in `.json`,
// so this single check both selects real reports and ignores temp files,
// including ones cleanly readable if a previous writer crashed
// mid-publish, without needing a separate exclusion rule.
function isReportFilename(name) {
  return name.startsWith('report-') && name.endsWith('.json');
}

// Parses one report file, applying the same shape/skip rules readHistory
// and the eligible-history scanner both need: malformed JSON or a value
// that doesn't look like a report is skipped (returns null), but a genuine
// read failure (EACCES/EIO -- not ENOENT, which just means a raced
// delete/rename) is never silently treated as "this report doesn't exist".
async function readOneReport(dir, name) {
  let text;
  try {
    text = await readFile(join(dir, name), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new IngestionError('E_REPORT_READ', `failed to read report ${name}: ${err.message}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.started_at !== 'string' || Number.isNaN(Date.parse(parsed.started_at))) return null;
  if (parsed.stages === null || typeof parsed.stages !== 'object' || Array.isArray(parsed.stages)) return null;
  return parsed;
}

// Scans reports newest-first (filenames already sort chronologically: the
// safe-timestamp fragment preserves order, and the run_id suffix is a
// stable, if arbitrary, tie-breaker for two reports at the same instant),
// parsing bodies lazily and stopping as soon as `limit` reports satisfying
// `isEligible` are found. Never limits candidates by filename before
// checking eligibility -- a long run of recent ineligible reports must not
// starve out older eligible ones -- and never loads more bodies than
// necessary to decide.
export async function readEligibleHistory(dir, limit, isEligible = () => true) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new IngestionError('E_REPORT_READ', `failed to list reports in ${dir}: ${err.message}`, { cause: err });
  }
  const candidates = names.filter(isReportFilename).sort().reverse();

  const out = [];
  for (const name of candidates) {
    if (out.length >= limit) break;
    const parsed = await readOneReport(dir, name);
    if (parsed !== null && isEligible(parsed)) out.push(parsed);
  }
  return out;
}

// Kept for existing simple "newest N valid reports" callers -- no
// eligibility filter beyond the shape validation every report goes through.
export async function readHistory(dir, limit = 5) {
  return readEligibleHistory(dir, limit);
}
