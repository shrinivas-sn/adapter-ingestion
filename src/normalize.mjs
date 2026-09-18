const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

// Shared calendar-component validation. Reused by config.mjs (validating
// `since`) and isoDate below -- one place that knows what a real date is,
// not a second date parser per caller.
function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

export function isValidDateOnly(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  return isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

// Decode a single numeric character reference safely. String.fromCodePoint
// throws a RangeError for an out-of-range or lone-surrogate code point --
// upstream content is untrusted, so an adapter author's title normalizer
// must never be able to abort the whole ingestion run over one bad &#...;.
// Zero, lone surrogates, and anything beyond the Unicode range become the
// standard replacement character instead.
function decodeCodePoint(cp) {
  if (!Number.isSafeInteger(cp) || cp <= 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) {
    return '�';
  }
  return String.fromCodePoint(cp);
}

function text(v) {
  if (v === null || v === undefined) return null;
  return String(v)
    .replace(/<[^>]*>/g, '')
    // Numeric character references (&#8211; an en dash, &#038; a
    // double-encoded ampersand -- both routine in WordPress titles) must be
    // decoded to the character they represent, not deleted: dropping them
    // silently mangled every title containing one into readable-looking but
    // wrong text (a missing dash reads as a stray double space, not an
    // obvious defect) -- found integrating a real WordPress source. Each
    // entity family gets exactly one pass (no recursive re-decoding of the
    // result), so a double-encoded "&amp;#38;" stays as literal text rather
    // than silently unwrapping twice.
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => decodeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => decodeCodePoint(Number(dec)))
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function number(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  // A very long digit string (or one crafted just under/over an engine
  // limit) parses to Infinity, not a throw -- must be caught explicitly,
  // the same way the typeof-number branch above already is.
  return Number.isFinite(n) ? n : null;
}

const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_FULL = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
];

function monthNumberFromName(word) {
  const w = word.toLowerCase();
  const shortIdx = MONTH_SHORT.indexOf(w);
  if (shortIdx !== -1) return shortIdx + 1;
  const fullIdx = MONTH_FULL.indexOf(w);
  return fullIdx === -1 ? null : fullIdx + 1;
}

// Grammar (after outer whitespace trimming), all anchored start-to-end so
// trailing garbage fails rather than being silently ignored:
//   ISO:      YYYY-MM-DD, optional T HH:mm[:ss[.fraction]] [Z|±HH:mm]
//   English:  D[D] <-|/|space> MonthName <same sep> YYYY
//   Numeric:  D[D] <-|/> M[M] <same sep> YYYY            (day-first)
// No unrestricted Date parsing anywhere -- every component is validated by
// hand against isValidCalendarDate plus explicit hour/minute/second/offset
// ranges, so epoch numbers/seconds are never accidentally accepted here.
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const ENGLISH_DMY_RE = /^(\d{1,2})([-/\s])([A-Za-z]+)\2(\d{4})$/;
const NUMERIC_DMY_RE = /^(\d{1,2})([-/])(\d{1,2})\2(\d{4})$/;

function isoDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();

  let m = s.match(ISO_DATE_RE);
  if (m) {
    const [, yStr, moStr, dStr, hStr, miStr, secStr, , offStr] = m;
    const year = Number(yStr);
    const month = Number(moStr);
    const day = Number(dStr);
    if (year < 1 || !isValidCalendarDate(year, month, day)) return null;
    if (hStr !== undefined) {
      // A valid offset describes when the instant occurred elsewhere, not
      // which day it is here -- retain the date as written, never shift it
      // to UTC, so this normalizer stays a pure text->text transform.
      if (Number(hStr) > 23 || Number(miStr) > 59) return null;
      if (secStr !== undefined && Number(secStr) > 59) return null;
      if (offStr && offStr !== 'Z') {
        const [, offH, offMin] = offStr.match(/^[+-](\d{2}):(\d{2})$/);
        if (Number(offH) > 23 || Number(offMin) > 59) return null;
      }
    }
    return ymd(year, month, day);
  }

  m = s.match(ENGLISH_DMY_RE);
  if (m) {
    const day = Number(m[1]);
    const month = monthNumberFromName(m[3]);
    const year = Number(m[4]);
    if (month === null || !isValidCalendarDate(year, month, day)) return null;
    return ymd(year, month, day);
  }

  // Day-first. Unambiguous formats are handled above; this branch is the documented
  // default for DD/MM/YYYY sources and must be stated in the adapter's notes.
  m = s.match(NUMERIC_DMY_RE);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[3]);
    const year = Number(m[4]);
    if (!isValidCalendarDate(year, month, day)) return null;
    return ymd(year, month, day);
  }

  return null;
}

function bool(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['yes', 'true', '1', 'y'].includes(s)) return true;
  if (['no', 'false', '0', 'n'].includes(s)) return false;
  return null;
}

const NORMALIZERS = { text, number, 'iso-date': isoDate, bool };

export function applyNormalizer(name, value) {
  const fn = NORMALIZERS[name];
  if (!fn) throw new Error(`unknown normalizer: ${name}`);
  return fn(value);
}
