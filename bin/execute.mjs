#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { execute, ExecutorError } from '../lib/executor.mjs';

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes('--json');

function usageError(message) {
  return new ExecutorError(message, [{
    ruleId: 'CLI_USAGE',
    path: '$',
    message: `${message}; usage: execute.mjs run <config.json> --out <dir> [--now <iso>] [--json]`,
  }]);
}

function parseRun(arguments_) {
  const subcommand = arguments_.shift();
  if (subcommand !== 'run') {
    throw usageError(subcommand ? `unknown subcommand ${subcommand}` : 'missing subcommand');
  }
  const configFile = arguments_.shift();
  if (!configFile || configFile.startsWith('--')) {
    throw usageError('run requires one config file');
  }

  const options = {};
  let seenJson = false;
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    if (flag === '--json') {
      if (seenJson) throw usageError('duplicate flag --json');
      seenJson = true;
      continue;
    }
    if (flag !== '--out' && flag !== '--now') throw usageError(`unknown run argument ${flag}`);
    const option = flag === '--out' ? 'outDir' : 'now';
    if (Object.hasOwn(options, option)) throw usageError(`duplicate flag ${flag}`);
    const value = arguments_.shift();
    if (value === undefined || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    options[option] = value;
  }
  if (!Object.hasOwn(options, 'outDir')) throw usageError('missing required flag --out');
  return { configFile, options };
}

async function readConfig(configFile) {
  let source;
  try {
    source = await readFile(configFile, 'utf8');
  } catch (error) {
    throw new ExecutorError(`cannot read ${configFile}`, [{
      ruleId: 'CLI_READ',
      path: configFile,
      message: error.message,
    }]);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ExecutorError(`invalid JSON in ${configFile}`, [{
      ruleId: 'CONFIG_JSON_PARSE',
      path: configFile,
      message: error.message,
    }]);
  }
}

function printError(error) {
  const errors = error instanceof ExecutorError && error.errors.length > 0
    ? error.errors
    : [{ ruleId: 'EXECUTOR_ERROR', path: '$', message: error.message }];
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`);
    return;
  }
  for (const item of errors) {
    process.stderr.write(`${item.ruleId}: ${item.path}: ${item.message}\n`);
  }
}

try {
  const { configFile, options } = parseRun([...rawArgs]);
  const result = await execute(await readConfig(configFile), options);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      run_record: result.runRecordFile,
      stdout: result.stdoutFile,
      stderr: result.stderrFile,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`run_record ${result.runRecordFile}\n`);
  }
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
