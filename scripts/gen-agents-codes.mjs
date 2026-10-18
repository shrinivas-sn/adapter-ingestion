// Renders the code table in AGENTS.md from src/codes.mjs, between the
// `<!-- codes:start -->` and `<!-- codes:end -->` markers, so the agent guide
// can never drift from the catalog `adapter-ingestion explain` uses.
//
//   node scripts/gen-agents-codes.mjs          rewrite AGENTS.md
//   node scripts/gen-agents-codes.mjs --check  exit 1 if AGENTS.md is stale (CI)
import { readFile, writeFile } from 'node:fs/promises';
import { CODES } from '../src/codes.mjs';

const FILE = new URL('../AGENTS.md', import.meta.url);
const START = '<!-- codes:start -->';
const END = '<!-- codes:end -->';

const cell = (text) => text.replaceAll('|', '\\|');

function renderTable() {
  const rows = Object.entries(CODES)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, e]) => `| \`${code}\` | ${e.kind} | ${cell(e.meaning)} | ${cell(e.fix)} |`);
  return ['| Code | Kind | Meaning | Fix |', '|---|---|---|---|', ...rows].join('\n');
}

const original = await readFile(FILE, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const text = original.replace(/\r\n/g, '\n');
const start = text.indexOf(START);
const end = text.indexOf(END);
if (start < 0 || end < start) {
  console.error(`AGENTS.md must contain ${START} followed by ${END}`);
  process.exit(2);
}
const next = `${text.slice(0, start + START.length)}\n${renderTable()}\n${text.slice(end)}`;

if (process.argv.includes('--check')) {
  if (next !== text) {
    console.error('AGENTS.md code table is stale: run node scripts/gen-agents-codes.mjs');
    process.exit(1);
  }
  console.log('AGENTS.md code table is up to date');
} else {
  await writeFile(FILE, next.replace(/\n/g, eol));
  console.log('AGENTS.md code table written');
}
