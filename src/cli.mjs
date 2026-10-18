#!/usr/bin/env node
// The package's command-line interface (`adapter-ingestion`, package.json
// "bin"). Not a package subpath: the public contract is the commands, flags,
// exit codes and --json keys, frozen by test/contract-freeze.test.mjs.
//
// Exit codes: 0 ok; 1 stale run, operational error or abort; 2 usage or
// configuration (nothing was attempted, or the adapter/environment is unfit).
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateAdapter } from './adapter.mjs';
import { runIngest } from './run.mjs';
import { safeFailure } from './errors.mjs';
import { CODES } from './codes.mjs';

const EXIT_OK = 0;
const EXIT_OPERATIONAL = 1;
const EXIT_CONFIG = 2;
const CONFIG_ERROR_CODES = new Set(['E_OPTIONS', 'E_ADAPTER_INVALID']);

const USAGE = `usage: adapter-ingestion <command> [options]

commands:
  validate <adapter.json>   check an adapter offline; lists every error
  run <adapter.json> [--since YYYY-MM-DD] [--store FILE] [--runs DIR] [--history FILE]
                            ingest once; defaults: store/<host>.jsonl, runs/<host>
  explain <CODE>            what an E_*, A_* or D_* code means, and the fix

every command accepts --json: one JSON object on stdout, nothing else`;

const JSON_FLAG = { json: { type: 'boolean' } };
const COMMANDS = {
  validate: { options: { ...JSON_FLAG }, run: validateCommand },
  explain: { options: { ...JSON_FLAG }, run: explainCommand },
  run: {
    options: {
      ...JSON_FLAG, since: { type: 'string' }, store: { type: 'string' },
      runs: { type: 'string' }, history: { type: 'string' },
    },
    run: runCommand,
  },
};

class UsageError extends Error {}

// Usage and load failures share one output path: with --json a single
// {"error": {code, message}} object on stdout, otherwise the message (and
// usage, for a usage error) on stderr. Never a stack trace.
function printError(json, code, message, { showUsage = false } = {}) {
  if (json) console.log(JSON.stringify({ error: { code, message } }));
  else console.error(showUsage ? `${USAGE}\n\n${message}` : message);
}

// Never a raw stack trace, and never a snippet of the file's own content
// (a JSON SyntaxError's message can otherwise embed one) -- just which of
// the two things failed. Same wording as `node src/run.mjs`.
async function loadAdapter(adapterPath) {
  try {
    return { adapter: JSON.parse(await readFile(adapterPath, 'utf8')) };
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found'
      : err.code === 'EACCES' ? 'permission denied'
      : err instanceof SyntaxError ? 'not valid JSON'
      : 'could not be read';
    const code = err instanceof SyntaxError ? 'E_ADAPTER_INVALID' : 'E_OPTIONS';
    return { error: { code, message: `failed to load adapter "${adapterPath}": ${reason}` } };
  }
}

function onePositional(positionals, what) {
  if (positionals.length === 0) throw new UsageError(`${what} is required`);
  if (positionals.length > 1) throw new UsageError(`unexpected extra argument: ${positionals[1]}`);
  return positionals[0];
}

async function validateCommand({ positionals, values }) {
  const adapterPath = onePositional(positionals, 'an adapter.json path');
  const loaded = await loadAdapter(adapterPath);
  if (loaded.error) {
    printError(values.json, loaded.error.code, loaded.error.message);
    return EXIT_CONFIG;
  }
  const { ok, errors } = validateAdapter(loaded.adapter);
  if (values.json) {
    console.log(JSON.stringify({ ok, errors }));
  } else if (ok) {
    console.log(`valid: ${adapterPath}`);
  } else {
    console.log(`invalid: ${adapterPath}`);
    for (const e of errors) console.log(`  - ${e}`);
  }
  return ok ? EXIT_OK : EXIT_CONFIG;
}

// A safe host is required before any path is derived from it -- an
// invalid/missing host must never produce a fabricated runs/undefined
// report location. The full hostname check still belongs to runIngest.
function hasUsableHost(adapter) {
  return typeof adapter?.host === 'string' && adapter.host.length > 0;
}

function stagesLine(stages) {
  return Object.entries(stages).map(([k, v]) => `${k} ${v}`).join(', ');
}

async function runCommand({ positionals, values }) {
  const adapterPath = onePositional(positionals, 'an adapter.json path');
  const loaded = await loadAdapter(adapterPath);
  if (loaded.error) {
    printError(values.json, loaded.error.code, loaded.error.message);
    return EXIT_CONFIG;
  }
  const { adapter } = loaded;
  if (!hasUsableHost(adapter)) {
    printError(values.json, 'E_ADAPTER_INVALID',
      `adapter "${adapterPath}" has no usable "host" -- refusing to derive a store/report path from it`);
    return EXIT_CONFIG;
  }
  const paths = {
    storeFile: values.store ?? `store/${adapter.host}.jsonl`,
    runsDir: values.runs ?? `runs/${adapter.host}`,
    ...(values.history !== undefined ? { historyFile: values.history } : {}),
  };

  // Registered only for the duration of this run, never at module import.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let report = null;
  let thrown = null;
  try {
    ({ report } = await runIngest({ adapter, paths, since: values.since, signal: ac.signal }));
  } catch (err) {
    thrown = err;
    report = err.report ?? null;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  if (!report) {
    // Failed before any report existed (an invalid option such as --history).
    const failure = safeFailure(thrown, 'options');
    printError(values.json, failure.code, failure.message);
    return CONFIG_ERROR_CODES.has(failure.code) ? EXIT_CONFIG : EXIT_OPERATIONAL;
  }

  if (values.json) {
    const { outcome, stages, canary, notices, failure } = report;
    console.log(JSON.stringify({ outcome, stages, canary, notices, failure }));
  } else {
    console.log(`outcome: ${report.outcome} (${stagesLine(report.stages)})`);
    for (const breach of report.canary.breaches) console.log(`  canary: ${breach}`);
    if (report.failure) console.error(`ingest failed: ${report.failure.code}: ${report.failure.message}`);
    for (const n of report.notices) console.error(`notice ${n.code}: ${n.message}`);
  }
  if (thrown) return CONFIG_ERROR_CODES.has(report.failure?.code) ? EXIT_CONFIG : EXIT_OPERATIONAL;
  return report.outcome === 'ok' ? EXIT_OK : EXIT_OPERATIONAL;
}

async function explainCommand({ positionals, values }) {
  const code = onePositional(positionals, 'a code (for example E_FETCH)');
  const entry = Object.hasOwn(CODES, code) ? CODES[code] : null;
  if (!entry) {
    printError(values.json, 'E_OPTIONS', `unknown code "${code}"; codes look like E_FETCH, A_CANARY_NO_HISTORY`);
    return EXIT_CONFIG;
  }
  if (values.json) {
    console.log(JSON.stringify({ code, kind: entry.kind, meaning: entry.meaning, cause: entry.cause, fix: entry.fix }));
  } else {
    console.log(`${code} (${entry.kind})\nmeaning: ${entry.meaning}\ncause:   ${entry.cause}\nfix:     ${entry.fix}`);
  }
  return EXIT_OK;
}

export async function main(argv) {
  const [name, ...rest] = argv;
  const wantsJson = rest.includes('--json');
  if (name === '--help' || name === '-h' || name === 'help') {
    console.log(USAGE);
    return EXIT_OK;
  }
  if (name === undefined) {
    printError(false, 'E_OPTIONS', 'a command is required', { showUsage: true });
    return EXIT_CONFIG;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!command) {
    printError(wantsJson, 'E_OPTIONS', `unknown command: ${name}`, { showUsage: !wantsJson });
    return EXIT_CONFIG;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: command.options, allowPositionals: true, strict: true });
  } catch (err) {
    printError(wantsJson, 'E_OPTIONS', err.message, { showUsage: !wantsJson });
    return EXIT_CONFIG;
  }
  try {
    return await command.run(parsed);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    printError(parsed.values.json, 'E_OPTIONS', err.message, { showUsage: !parsed.values.json });
    return EXIT_CONFIG;
  }
}

// Only a direct run executes, never an import. Unlike src/run.mjs, this file
// is reached through npm's bin link: on POSIX that is a symlink, and Node
// reports the main module by its real path, so argv[1] is resolved first.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = await main(process.argv.slice(2));
}
