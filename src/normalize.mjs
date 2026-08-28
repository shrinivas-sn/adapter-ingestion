const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function text(v) {
  if (v === null || v === undefined) return null;
  return String(v)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function number(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function isoDate(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ymd(m[1], Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[-\/\s]([A-Za-z]{3,})[-\/\s](\d{4})/);
  if (m) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mm) return ymd(m[3], mm, Number(m[1]));
  }
  // Day-first. Unambiguous formats are handled above; this branch is the documented
  // default for DD/MM/YYYY sources and must be stated in the adapter's notes.
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) return ymd(m[3], Number(m[2]), Number(m[1]));
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
