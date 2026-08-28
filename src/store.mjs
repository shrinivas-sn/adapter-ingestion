import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function appendRecords(filePath, records) {
  if (!records.length) return 0;
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return records.length;
}

export async function readRecords(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A single corrupt line must not make the whole store unreadable.
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

export async function readIndex(filePath) {
  const idx = new Map();
  for (const r of await readRecords(filePath)) idx.set(r.id, r.content_hash);
  return idx;
}
