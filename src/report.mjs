import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function buildReport({ host, startedAt, finishedAt, stages, errors = [] }) {
  return {
    host,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
    stages,
    error_count: errors.length,
    errors: errors.slice(0, 20),
  };
}

export async function writeReport(dir, report) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `report-${report.started_at.replace(/[:.]/g, '-')}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}

export async function readHistory(dir, limit = 5) {
  let names;
  try { names = await readdir(dir); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const picked = names.filter((n) => n.startsWith('report-')).sort().reverse().slice(0, limit);
  const out = [];
  for (const n of picked) {
    try { out.push(JSON.parse(await readFile(join(dir, n), 'utf8'))); } catch { /* skip */ }
  }
  return out;
}
