import { IngestionError } from '../errors.mjs';

// access.kind "csv" (since 0.8): RFC 4180 text with a header row, one plain
// object per data row, keyed by the header. Nothing here knows any site;
// cells stay strings (or null when empty) and map's normalizers type them.
//
// Strict where data would otherwise be lost or misread (broken quoting, a
// value with no column name, a repeated header name); lenient where nothing
// is lost (a short row, trailing empty cells, a literal " inside a cell).
// Messages name a line and a rule, never cell text: cells can hold anything.

const MAX_COLUMNS = 1000;
// One run of ordinary characters in an unquoted cell.
const PLAIN_RUN = /[^,\r\n"]+/y;

function parseError(line, what) {
  return new IngestionError('E_PARSE', `csv line ${line}: ${what}`);
}

/**
 * @param {string} text
 * @param {{ maxRows?: number, maxRecords?: number }} [options]
 * @returns {Record<string, string | null>[]}
 */
export function parseCsv(text, { maxRows, maxRecords } = {}) {
  /** @type {string[] | null} */
  let header = null;
  /** @type {number[]} indexes of the columns that have a name */
  let named = [];
  /** @type {Record<string, null>} */
  let shape = {};
  /** @type {Record<string, string | null>[]} */
  const rows = [];
  /** @type {string[]} */
  let cells = [];
  let cell = '';
  let rowQuoted = false;
  let afterQuote = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const n = text.length;

  const finishRow = () => {
    cells.push(cell);
    const values = cells;
    const quoted = rowQuoted;
    cells = [];
    cell = '';
    rowQuoted = false;
    afterQuote = false;
    // An empty line, not a row of one empty cell.
    if (values.length === 1 && values[0] === '' && !quoted) return;

    if (header === null) {
      if (values.length > MAX_COLUMNS) throw parseError(rowLine, `the header has more than ${MAX_COLUMNS} columns`);
      const seen = new Set();
      values.forEach((name, k) => {
        if (name === '') return;
        if (seen.has(name)) throw parseError(rowLine, `the header repeats a column name (column ${k + 1})`);
        seen.add(name);
      });
      header = values;
      named = [];
      values.forEach((name, k) => { if (name !== '') named.push(k); });
      // fromEntries defines own properties, so a "__proto__" column is data,
      // never the prototype. Spreading the shape copies it as own data too,
      // and a later assignment then hits that own property. Much faster than
      // building every row with fromEntries.
      shape = Object.fromEntries(named.map((k) => [values[k], null]));
      return;
    }

    for (let k = 0; k < values.length; k++) {
      if (values[k] !== '' && (k >= header.length || header[k] === '')) {
        throw parseError(rowLine, `a value has no column name (column ${k + 1})`);
      }
    }
    if (maxRows !== undefined && rows.length >= maxRows) {
      throw new IngestionError('E_RECORD_LIMIT', `fetch exceeded max_records (${maxRecords})`);
    }
    /** @type {Record<string, string | null>} */
    const row = { ...shape };
    for (const k of named) {
      if (k < values.length && values[k] !== '') row[header[k]] = values[k];
    }
    rows.push(row);
  };

  while (i < n) {
    const c = text[i];
    if (c === ',') {
      cells.push(cell);
      cell = '';
      afterQuote = false;
      i++;
    } else if (c === '\n' || c === '\r') {
      finishRow();
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      rowLine = line;
    } else if (afterQuote) {
      throw parseError(rowLine, 'text after a closing quote');
    } else if (c === '"' && cell === '') {
      // A quoted cell: read to its closing quote, "" being one quote.
      rowQuoted = true;
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) throw parseError(rowLine, 'a quoted value is never closed');
        const chunk = text.slice(i, q);
        cell += chunk;
        for (let k = 0; k < chunk.length; k++) {
          if (chunk[k] === '\n' || (chunk[k] === '\r' && chunk[k + 1] !== '\n')) line++;
        }
        if (text[q + 1] === '"') {
          cell += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      afterQuote = true;
    } else if (c === '"') {
      cell += c;
      i++;
    } else {
      PLAIN_RUN.lastIndex = i;
      PLAIN_RUN.exec(text);
      cell += text.slice(i, PLAIN_RUN.lastIndex);
      i = PLAIN_RUN.lastIndex;
    }
  }
  // The last row, when the text does not end with a line end.
  if (cell !== '' || cells.length > 0 || rowQuoted) finishRow();
  return rows;
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function parse({ bytes, limits }) {
  let text;
  try {
    // ignoreBOM: false means a leading byte-order mark is removed.
    text = decoder.decode(bytes);
  } catch {
    throw new IngestionError('E_PARSE', 'csv: the response is not valid UTF-8');
  }
  return parseCsv(text, { maxRows: limits?.remainingRecords, maxRecords: limits?.maxRecords });
}

function validate(adapter, need) {
  // Each row is already one record; there is no wrapper to walk into.
  need(adapter.records_path === undefined || adapter.records_path === '$',
    'records_path must be "$" when access.kind is "csv"');
}

export const csvKind = Object.freeze({ name: 'csv', validate, parse });
