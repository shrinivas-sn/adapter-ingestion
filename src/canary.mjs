// The point of this module: notice when a source changed shape and the pipeline
// quietly stopped meaning anything. A cron that reports success while returning
// nothing is the failure this exists to prevent.
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function checkCanary(report, history, cfg) {
  const breaches = [];
  const { fetched = 0, parsed = 0 } = report.stages ?? {};

  if (parsed < (cfg.min_records ?? 1)) breaches.push(`min_records: parsed ${parsed}`);

  if (fetched > 0 && parsed / fetched < (cfg.required_field_ratio ?? 0.9)) {
    breaches.push(`required_field_ratio: ${parsed}/${fetched} parsed — required fields may have been renamed`);
  }

  const past = history.slice(0, cfg.median_window ?? 5).map((h) => h.stages?.parsed ?? 0);
  const med = median(past);
  if (med !== null && med > 0 && parsed < med * (cfg.count_drop_ratio ?? 0.4)) {
    breaches.push(`count_drop_ratio: parsed ${parsed} vs trailing median ${med}`);
  }

  // Count-based checks above can't catch a source that freezes: an
  // unpaginated feed, or an incremental cursor that silently stops
  // advancing, keeps serving a full page of records forever, and every
  // count check keeps passing while the data underneath goes stale.
  if (cfg.max_staleness_days && cfg.staleness_field) {
    const newest = report.newest_staleness_value;
    if (newest === null || newest === undefined) {
      breaches.push(`staleness: no value found for staleness_field "${cfg.staleness_field}" in this run`);
    } else {
      const ageMs = Date.now() - new Date(newest).getTime();
      const ageDays = ageMs / 86_400_000;
      if (!Number.isFinite(ageDays)) {
        breaches.push(`staleness: staleness_field "${cfg.staleness_field}" value "${newest}" is not a valid date`);
      } else if (ageDays > cfg.max_staleness_days) {
        breaches.push(
          `staleness: newest ${cfg.staleness_field} is ${ageDays.toFixed(1)} days old, exceeds max_staleness_days ${cfg.max_staleness_days}`,
        );
      }
    }
  }

  return { status: breaches.length ? 'stale' : 'ok', breaches };
}
