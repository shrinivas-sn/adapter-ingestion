import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { IngestionError } from './errors.mjs';

// A small, bounded, committable mirror of past runs, so the canary's
// trailing median works where runs/ does not survive between runs (a CI job
// that starts from a fresh checkout). One JSON line per finished run, oldest
// first. Only the fields the canary's eligibility rule and median read are
// kept -- no errors, warnings, URLs or headers -- so it is safe to commit.
const SUMMARY_KEYS = ['report_version', 'run_id', 'host', 'adapter_fingerprint', 'mode', 'outcome', 'started_at', 'stages'];

export function historySummary(report) {
  const out = {};
  for (const key of SUMMARY_KEYS) out[key] = report[key];
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

async function readLines(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new IngestionError('E_REPORT_READ', `failed to read history file: ${err.message}`, { cause: err });
  }
  return text.split('\n').map((l) => l.replace(/\r$/, ''));
}

// Newest first, up to `limit` entries that pass `isEligible`. The file is
// bounded by appendHistory, so it is read whole. A line that is not a
// usable summary is skipped with a warning, the same way the store treats
// a corrupt line.
export async function readHistoryFile(file, limit, isEligible, { onWarning } = {}) {
  const lines = await readLines(file);
  const out = [];
  const warnings = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const text = lines[i];
    if (text.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!isPlainObject(parsed) || typeof parsed.started_at !== 'string' || !isPlainObject(parsed.stages)) {
      warnings.push({ code: 'W_HISTORY_CORRUPT_LINE', line: i + 1 });
      continue;
    }
    if (isEligible(parsed)) out.push(parsed);
  }
  // Lines are scanned newest-first; warnings are reported in file order.
  for (const w of warnings.reverse()) onWarning?.(w);
  return out;
}

// Appends one summary and keeps the newest `keep` lines. Published through
// an exclusive temp sibling, synced, then renamed into place -- the same
// crash-safety pattern as writeReport, so a reader never sees half a file.
export async function appendHistory(file, summary, { keep }) {
  try {
    const existing = (await readLines(file)).filter((l) => l.trim() !== '');
    const kept = [...existing, JSON.stringify(summary)].slice(-keep);
    await mkdir(dirname(file), { recursive: true });
    const tempPath = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(tempPath, 'wx');
      await handle.write(kept.join('\n') + '\n');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, file);
    } catch (err) {
      try { await handle?.close(); } catch { /* already closed or errored */ }
      try { await unlink(tempPath); } catch { /* best-effort cleanup of our own temp file */ }
      throw err;
    }
  } catch (err) {
    throw new IngestionError('E_REPORT_WRITE', `failed to write history file: ${err.message}`, { cause: err });
  }
}
