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

  return { status: breaches.length ? 'stale' : 'ok', breaches };
}
