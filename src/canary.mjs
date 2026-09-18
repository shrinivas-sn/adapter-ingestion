import { isValidDateOnly } from './normalize.mjs';

// The point of this module: notice when a source changed shape and the pipeline
// quietly stopped meaning anything. A cron that reports success while returning
// nothing is the failure this exists to prevent.
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// staleness_field values may be a strict date-only string, an explicit-zone
// ISO timestamp, or finite epoch milliseconds -- never a bare/zone-less
// timestamp (ambiguous local-vs-UTC) and never locale-dependent Date
// parsing. Reuses isValidDateOnly (normalize.mjs) for the calendar check
// rather than writing a second one; only the offset/instant arithmetic here
// is new, since the normalizer deliberately never computes an instant.
const EXPLICIT_ZONE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseStalenessInstant(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;

  if (isValidDateOnly(value)) return Date.parse(`${value}T00:00:00Z`);

  const m = value.match(EXPLICIT_ZONE_TIMESTAMP_RE);
  if (!m) return null;
  const [, datePart, hh, mm, ss, offset] = m;
  if (!isValidDateOnly(datePart)) return null;
  if (Number(hh) > 23 || Number(mm) > 59 || (ss !== undefined && Number(ss) > 59)) return null;
  if (offset !== 'Z') {
    const [, offH, offMin] = offset.match(/^([+-]\d{2}):(\d{2})$/);
    if (Number(offH) > 23 || Number(offMin) > 59) return null;
  }
  const parsedMs = Date.parse(value);
  return Number.isNaN(parsedMs) ? null : parsedMs;
}

// A defensive, best-effort filter for direct/standalone callers that pass
// raw history without pre-filtering: excludes an entry only when it *has*
// outcome metadata saying it failed/was stale. A legacy or hand-built test
// report with no `outcome` field at all is still counted -- runIngest's own
// eligible-history scan (report.mjs) is what does the heavy, complete
// filtering (fingerprint/host/mode/version/recency) before calling here.
function eligibleForMedian(history) {
  return history.filter((h) => h.outcome === undefined || h.outcome === 'ok');
}

export function checkCanary(report, history, cfg, { now = new Date() } = {}) {
  const breaches = [];
  const skipped = [];
  const { fetched = 0, parsed = 0 } = report.stages ?? {};
  const isIncremental = report.mode === 'incremental';

  // min_records -- snapshot mode always evaluates this, including an empty
  // [] batch (which is exactly how a genuine source collapse is caught).
  if (isIncremental) {
    skipped.push({ check: 'min_records', reason: 'incremental_batch' });
  } else if (parsed < (cfg.min_records ?? 1)) {
    breaches.push(`min_records: parsed ${parsed}`);
  }

  // required_field_ratio -- an empty incremental batch can't compute a
  // ratio at all (0/0); a snapshot batch of 0 simply has nothing to check
  // here (min_records above already covers that case).
  if (isIncremental && fetched === 0) {
    skipped.push({ check: 'required_field_ratio', reason: 'empty_batch' });
  } else if (fetched > 0 && parsed / fetched < (cfg.required_field_ratio ?? 0.9)) {
    breaches.push(`required_field_ratio: ${parsed}/${fetched} parsed — required fields may have been renamed`);
  }

  // count_drop_ratio -- an incremental cursor's batch size is expected to
  // vary with upstream activity, so a trailing-median comparison would be
  // meaningless; skip it outright rather than false-alarming on a quiet day.
  if (isIncremental) {
    skipped.push({ check: 'count_drop_ratio', reason: 'incremental_batch' });
  } else {
    const past = eligibleForMedian(history).slice(0, cfg.median_window ?? 5).map((h) => h.stages?.parsed ?? 0);
    const med = median(past);
    if (med === null) {
      skipped.push({ check: 'count_drop_ratio', reason: 'no_history' });
    } else if (med > 0 && parsed < med * (cfg.count_drop_ratio ?? 0.4)) {
      breaches.push(`count_drop_ratio: parsed ${parsed} vs trailing median ${med}`);
    }
  }

  // staleness -- catches a source that freezes (an unpaginated feed, or an
  // incremental cursor that silently stops advancing) and keeps serving
  // data that looks fine by every count-based check above.
  const hasStalenessCfg = Boolean(cfg.max_staleness_days && cfg.staleness_field);
  if (isIncremental) {
    skipped.push({ check: 'staleness', reason: 'incremental_batch' });
  } else if (!hasStalenessCfg) {
    skipped.push({ check: 'staleness', reason: 'not_configured' });
  } else {
    const newest = report.newest_staleness_value;
    if (newest === null || newest === undefined) {
      breaches.push(`staleness: no value found for staleness_field "${cfg.staleness_field}" in this run`);
    } else {
      const instant = parseStalenessInstant(newest);
      if (instant === null) {
        breaches.push(`staleness: staleness_field "${cfg.staleness_field}" value "${newest}" is not a valid date`);
      } else {
        const ageDays = (now.getTime() - instant) / 86_400_000;
        if (ageDays > cfg.max_staleness_days) {
          breaches.push(
            `staleness: newest ${cfg.staleness_field} is ${ageDays.toFixed(1)} days old, exceeds max_staleness_days ${cfg.max_staleness_days}`,
          );
        }
      }
    }
  }

  return { status: breaches.length ? 'stale' : 'ok', breaches, skipped };
}
