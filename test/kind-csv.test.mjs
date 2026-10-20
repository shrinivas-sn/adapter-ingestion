import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvKind, parseCsv, MAX_CELLS } from '../src/kinds/csv.mjs';
import { builtinKindNames, resolveKind, validateKindsOption } from '../src/kinds/index.mjs';
import { validateAdapter } from '../src/adapter.mjs';
import { runIngest } from '../src/run.mjs';
import { readRecords } from '../src/store.mjs';

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

// ---- Task 2.2: the built-in kind, and caller kinds of the same name ----

const adapter = {
  version: 1, host: 'example.test',
  access: { tier: 0, kind: 'csv', url: 'https://example.test/data.csv' },
  map: { source_id: { path: 'id' }, url: { template: 'https://example.test/item/{id}' }, name: { path: 'name', normalize: 'text' } },
  required: ['name'],
};
const csvResponse = (text) => async () => new Response(text, { status: 200, headers: { 'content-type': 'text/csv' } });

async function withPaths(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'kind-csv-'));
  try {
    return await fn({ storeFile: join(dir, 'store.jsonl'), runsDir: join(dir, 'runs') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('csv is a built-in kind', () => {
  assert.ok(builtinKindNames().includes('csv'));
  assert.equal(resolveKind('csv'), csvKind);
});

test('validateAdapter accepts a csv adapter with no kinds option, and applies its rules', () => {
  assert.deepEqual(validateAdapter(adapter), { ok: true, errors: [] });
  assert.deepEqual(validateAdapter({ ...adapter, records_path: 'x' }).errors, ['records_path must be "$" when access.kind is "csv"']);
});

test('json-api and html still cannot be replaced; csv can be registered as before', () => {
  assert.doesNotThrow(() => validateKindsOption({ csv: { parse() {} } }));
  for (const name of ['json-api', 'html']) {
    assert.throws(() => validateKindsOption({ [name]: { parse() {} } }),
      (err) => err.code === 'E_OPTIONS' && err.message === `kinds.${name} shadows a built-in kind`);
  }
});

test('a caller kind named csv wins over the built-in', () => {
  const calls = [];
  const custom = { parse(input) { calls.push(input); return []; } };
  const resolved = resolveKind('csv', { csv: custom });
  assert.notEqual(resolved, csvKind);
  resolved.parse({ bytes: Buffer.alloc(0) });
  assert.equal(calls.length, 1);
  assert.equal(resolveKind('html', { html: custom }).name, 'html');
});

test('runIngest stores csv rows with the built-in kind', async () => {
  await withPaths(async (paths) => {
    const fetchImpl = csvResponse('id,name\na1,"Ada, L."\nb2,Bo\n');
    const { report } = await runIngest({ adapter, paths, fetchImpl, now: new Date('2026-10-20T00:00:00Z') });
    assert.equal(report.outcome, 'ok', JSON.stringify(report.failure ?? report.errors));
    const records = await readRecords(paths.storeFile);
    assert.deepEqual(records.map((r) => [r.fields.source_id, r.fields.name, r.source_url]), [
      ['a1', 'Ada, L.', 'https://example.test/item/a1'],
      ['b2', 'Bo', 'https://example.test/item/b2'],
    ]);
    assert.deepEqual(records[0].raw, { id: 'a1', name: 'Ada, L.' });
  });
});

test('runIngest uses a registered csv kind instead of the built-in, as on 0.7', async () => {
  await withPaths(async (paths) => {
    const custom = { parse: () => [{ id: 'mine', name: 'from the caller kind' }] };
    const fetchImpl = csvResponse('id,name\na1,Ada\n');
    const { report } = await runIngest({ adapter, paths, fetchImpl, kinds: { csv: custom }, now: new Date('2026-10-20T00:00:00Z') });
    assert.equal(report.outcome, 'ok');
    const records = await readRecords(paths.storeFile);
    assert.deepEqual(records.map((r) => r.fields.source_id), ['mine']);
  });
});

test('a broken csv body fails the run with E_PARSE and the line number', async () => {
  await withPaths(async (paths) => {
    const fetchImpl = csvResponse('id,name\na1,"open\n');
    await assert.rejects(runIngest({ adapter, paths, fetchImpl, now: new Date('2026-10-20T00:00:00Z') }), (err) => {
      assert.equal(err.code, 'E_PARSE');
      assert.equal(err.message, 'csv line 2: a quoted value is never closed');
      return true;
    });
  });
});

test('max_records is enforced while parsing', async () => {
  await withPaths(async (paths) => {
    const fetchImpl = csvResponse('id,name\na,1\nb,2\nc,3\n');
    const small = { ...adapter, fetch: { max_records: 2 } };
    await assert.rejects(runIngest({ adapter: small, paths, fetchImpl, now: new Date('2026-10-20T00:00:00Z') }),
      (err) => err.code === 'E_RECORD_LIMIT');
  });
});

test('a malformed registration named csv is not replaced by the built-in', () => {
  assert.equal(resolveKind('csv', { csv: { parse: 'nope' } }), null);
  assert.equal(resolveKind('csv', { other: { parse() {} } }), csvKind);
  assert.equal(validateAdapter(adapter, { kinds: { csv: { parse: 'nope' } } }).ok, false);
});

// ---- Review fix: short rows cannot blow memory up past a cell budget ----

test('the cell budget (rows times named columns) is 5,000,000 by default', () => {
  assert.equal(MAX_CELLS, 5_000_000);
});

test('more cells than the budget is E_PARSE, checked before the row is built', () => {
  // 3 named columns, 1-byte rows: each row still costs 3 cells.
  const text = 'a,b,c\nx\ny\nz\n';
  assert.equal(parseCsv(text, { maxCells: 9 }).length, 3);
  rejects(() => parseCsv(text, { maxCells: 8 }), 'E_PARSE', /^csv line 4: the file has more than 8 cells \(rows times named columns\)$/);
});

test('unnamed columns do not count against the cell budget', () => {
  assert.equal(parseCsv('a,,\n1,,\n2,,\n', { maxCells: 2 }).length, 2);
});
