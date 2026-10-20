import { applyNormalizer } from '../normalize.mjs';

// access.kind "feed" (since 0.9): RSS 2.0, RSS 1.0 (RDF) and Atom 1.0, read
// into one item shape so one adapter map works for any feed. Nothing here
// knows any site.

// RFC 822 as RSS uses it: optional weekday, D Mon YYYY HH:MM[:SS] zone.
// Two-digit years and military zones are refused rather than guessed.
const RFC822_RE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+(GMT|UTC|UT|Z|EST|EDT|CST|CDT|MST|MDT|PST|PDT|[+-]\d{4})$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONES = Object.freeze({
  gmt: '+00:00', utc: '+00:00', ut: '+00:00', z: '+00:00',
  est: '-05:00', edt: '-04:00', cst: '-06:00', cdt: '-05:00',
  mst: '-07:00', mdt: '-06:00', pst: '-08:00', pdt: '-07:00',
});

/**
 * An item date as ISO 8601 UTC, or null. RFC 822 is rewritten as an ISO
 * string with an offset and handed to iso-datetime, so every range check
 * (day in month, hour, minute, second, offset) is the normalizer's own.
 * The weekday is not checked against the date.
 * @param {unknown} value
 * @returns {string | null}
 */
export function feedDate(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  const m = RFC822_RE.exec(s);
  if (!m) return applyNormalizer('iso-datetime', s);
  const [, day, mon, year, hour, minute, second = '00', zone] = m;
  const month = String(MONTHS.indexOf(mon.toLowerCase()) + 1).padStart(2, '0');
  const offset = ZONES[zone.toLowerCase()] ?? `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return applyNormalizer('iso-datetime', `${year}-${month}-${day.padStart(2, '0')}T${hour}:${minute}:${second}${offset}`);
}
