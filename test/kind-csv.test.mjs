import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvKind, parseCsv } from '../src/kinds/csv.mjs';

// access.kind "csv" (since 0.8). Shapes come from real files (LiveBench
// cost, the USGS earthquake feed, Our World in Data); values are invented.

const rejects = (fn, code, pattern) => assert.throws(fn, (err) => {
  assert.equal(err.code, code);
  if (pattern) assert.match(err.message, pattern);
  return true;
});

test('a header row and data rows become one object per row', () => {
  assert.deepEqual(parseCsv('id,name\n1,a\n2,b\n'), [{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
});

test('LF, CRLF and lone CR line ends, with or without a final line end', () => {
  const want = [{ a: '1', b: '2' }, { a: '3', b: '4' }];
  assert.deepEqual(parseCsv('a,b\n1,2\n3,4'), want);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n3,4\r\n'), want);
  assert.deepEqual(parseCsv('a,b\r1,2\r3,4\r'), want);
});

test('quoted cells hold commas, line ends and doubled quotes', () => {
  const rows = parseCsv('id,place\nx,"31 km SW of Chenega, Alaska"\ny,"two\r\nlines"\nz,"say ""hi"""\n');
  assert.deepEqual(rows.map((r) => r.place), ['31 km SW of Chenega, Alaska', 'two\r\nlines', 'say "hi"']);
});

test('a quote inside an unquoted cell is a literal character', () => {
  assert.deepEqual(parseCsv('item\n5" disk\n'), [{ item: '5" disk' }]);
});

test('text after a closing quote is E_PARSE with the line where that row starts', () => {
  rejects(() => parseCsv('a,b\n"x\ny",1\n"p"q,2\n'), 'E_PARSE', /^csv line 4: text after a closing quote$/);
});

test('a quoted value that is never closed is E_PARSE', () => {
  rejects(() => parseCsv('a,b\n1,"open\n2,3\n'), 'E_PARSE', /^csv line 2: a quoted value is never closed$/);
});

test('a leading BOM is removed from the first header name', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,v\n1,2\n')]);
  assert.deepEqual(csvKind.parse({ bytes }), [{ id: '1', v: '2' }]);
});

test('bytes that are not UTF-8 are E_PARSE', () => {
  rejects(() => csvKind.parse({ bytes: Buffer.from([0x69, 0x64, 0x0a, 0xff, 0x0a]) }), 'E_PARSE',
    /^csv: the response is not valid UTF-8$/);
});

test('an empty body or a header with no rows gives no records', () => {
  assert.deepEqual(csvKind.parse({ bytes: Buffer.alloc(0) }), []);
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
  assert.deepEqual(parseCsv('a,b\n'), []);
});

test('empty lines anywhere are skipped', () => {
  assert.deepEqual(parseCsv('\n\na,b\n\n1,2\n\n\n3,4\n'), [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
});

test('an empty cell, quoted or not, is null; other cells are exact strings', () => {
  assert.deepEqual(parseCsv('a,b,c,d\n,"", x ,0\n'), [{ a: null, b: null, c: ' x ', d: '0' }]);
});

test('a short row gives null for the missing columns', () => {
  assert.deepEqual(parseCsv('a,b,c\n1\n'), [{ a: '1', b: null, c: null }]);
});

test('empty cells past the header are allowed (trailing commas)', () => {
  assert.deepEqual(parseCsv('a,b\n1,2,,\n'), [{ a: '1', b: '2' }]);
});

test('a value past the header is E_PARSE', () => {
  rejects(() => parseCsv('a,b\n1,2\n1,2,SECRET\n'), 'E_PARSE', /^csv line 3: a value has no column name \(column 3\)$/);
});

test('a column with an empty header name is dropped, and must stay empty', () => {
  assert.deepEqual(parseCsv('a,,b\n1,,2\n'), [{ a: '1', b: '2' }]);
  assert.deepEqual(parseCsv('a,b,\n1,2,\n'), [{ a: '1', b: '2' }]);
  rejects(() => parseCsv('a,,b\n1,SECRET,2\n'), 'E_PARSE', /^csv line 2: a value has no column name \(column 2\)$/);
});

test('a repeated header name is E_PARSE', () => {
  rejects(() => parseCsv('\nid,SECRET,SECRET\n1,2,3\n'), 'E_PARSE', /^csv line 2: the header repeats a column name \(column 3\)$/);
});

test('header names are used exactly as written', () => {
  assert.deepEqual(parseCsv(' id ,Name\n1,2\n'), [{ ' id ': '1', Name: '2' }]);
});

test('a header of 1000 columns is allowed, 1001 is E_PARSE', () => {
  const header = (n) => Array.from({ length: n }, (_, i) => `c${i}`).join(',');
  assert.equal(Object.keys(parseCsv(`${header(1000)}\n1\n`)[0]).length, 1000);
  rejects(() => parseCsv(`${header(1001)}\n1\n`), 'E_PARSE', /^csv line 1: the header has more than 1000 columns$/);
});

test('a header named __proto__ is an ordinary own key', () => {
  const [row] = parseCsv('__proto__,id\nx,1\n');
  assert.equal(Object.getPrototypeOf(row), Object.prototype);
  assert.ok(Object.hasOwn(row, '__proto__'));
  assert.equal(Object.getOwnPropertyDescriptor(row, '__proto__').value, 'x');
  assert.equal(row.id, '1');
  // A second row must not share or inherit the first row's values.
  const rows = parseCsv('__proto__,id\nx,1\n,2\n');
  assert.equal(Object.getOwnPropertyDescriptor(rows[1], '__proto__').value, null);
  assert.equal(Object.getPrototypeOf(rows[1]), Object.prototype);
});

test('more rows than the record budget is E_RECORD_LIMIT', () => {
  rejects(() => parseCsv('a\n1\n2\n3\n', { maxRows: 2, maxRecords: 7 }), 'E_RECORD_LIMIT', /^fetch exceeded max_records \(7\)$/);
  assert.equal(parseCsv('a\n1\n2\n', { maxRows: 2, maxRecords: 7 }).length, 2);
  rejects(() => csvKind.parse({ bytes: Buffer.from('a\n1\n2\n'), limits: { maxRecords: 5, remainingRecords: 1 } }),
    'E_RECORD_LIMIT', /^fetch exceeded max_records \(5\)$/);
});

test('error messages never contain cell or header text', () => {
  for (const text of ['a\n"SECRET"x\n', 'a\n"SECRET\n', 'SECRET,SECRET\n1,2\n', 'a\n1,SECRET\n']) {
    assert.throws(() => parseCsv(text), (err) => !err.message.includes('SECRET'));
  }
});

test('validate: records_path must be omitted or "$"', () => {
  const run = (adapter) => {
    const errors = [];
    csvKind.validate(adapter, (cond, msg) => { if (!cond) errors.push(msg); });
    return errors;
  };
  assert.deepEqual(run({}), []);
  assert.deepEqual(run({ records_path: '$' }), []);
  assert.deepEqual(run({ records_path: 'data' }), ['records_path must be "$" when access.kind is "csv"']);
});
