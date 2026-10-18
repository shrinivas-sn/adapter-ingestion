import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bin is always started through process.execPath, never its shebang,
// so the tests behave the same on Windows.
const cliPath = fileURLToPath(new URL('../../src/cli.mjs', import.meta.url));

export function runBin(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function disposableCwd(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-bin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function assertNoLeakage(text) {
  assert.ok(!/\bat .*\(.*:\d+:\d+\)/.test(text), `must not contain a stack trace: ${text}`);
  assert.ok(!text.includes('node:internal'), `must not reference Node internals: ${text}`);
}

export const VALID_ADAPTER = {
  version: 1, host: 'example.test',
  access: { tier: 1, kind: 'json-api', url: 'https://example.test/api' },
  map: { source_id: { path: 'id' }, url: { path: 'link' }, title: { path: 'title', normalize: 'text' } },
  required: ['source_id', 'url', 'title'],
};
