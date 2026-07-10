#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { checkTargets } from '../lib/policy-monitor.mjs';

const CHANGE_STATUSES = new Set(['changed', 'new', 'removed']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  if (args[0] !== 'check') {
    throw new Error(
      'usage: policy-monitor.mjs check --targets <file> --state <file> [--write] [--json]',
    );
  }

  const options = { write: false, json: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--write') {
      options.write = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--targets' || arg === '--state') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a file path`);
      }
      options[arg.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.targets || !options.state) {
    throw new Error('--targets and --state are required');
  }
  return options;
}

async function readJson(file, label) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${label} ${file}: ${error.message}`);
  }
}

function validateTargets(config) {
  if (!isObject(config) || config.version !== '0' || !Array.isArray(config.targets)) {
    throw new Error('targets config must contain version "0" and a targets array');
  }
  if (config.targets.length === 0) {
    throw new Error('targets config must contain at least one target');
  }

  for (const [index, target] of config.targets.entries()) {
    if (!isObject(target) || !/^[^/\s]+\/[^/\s]+$/.test(target.repo)) {
      throw new Error(`targets[${index}].repo must use owner/name format`);
    }
    if (
      !Array.isArray(target.paths) ||
      target.paths.length === 0 ||
      target.paths.some((path) => typeof path !== 'string' || path.length === 0)
    ) {
      throw new Error(`targets[${index}].paths must be a non-empty string array`);
    }
  }
}

function validateState(state) {
  if (!isObject(state) || state.version !== '0' || !isObject(state.files)) {
    throw new Error('state must contain version "0" and a files object');
  }
  if (Object.values(state.files).some((sha) => typeof sha !== 'string' || sha.length === 0)) {
    throw new Error('every state file SHA must be a non-empty string');
  }
}

function formatChange(result) {
  if (result.status === 'new') return `new ${result.key}: ${result.sha}`;
  if (result.status === 'removed') return `removed ${result.key}: ${result.previousSha}`;
  return `changed ${result.key}: ${result.previousSha} -> ${result.sha}`;
}

export async function runPolicyMonitorCli({
  args = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    const options = parseArgs(args);
    const targetsConfig = await readJson(options.targets, 'targets config');
    const state = await readJson(options.state, 'state');
    validateTargets(targetsConfig);
    validateState(state);

    const report = await checkTargets({
      targets: targetsConfig.targets,
      state,
      fetchImpl,
      token: env.GITHUB_TOKEN,
    });
    const requestCount = targetsConfig.targets.reduce(
      (total, target) => total + target.paths.length,
      0,
    );
    const warnings = report.results.filter(({ status }) => status === 'warning');
    const allRequestsFailed = warnings.length === requestCount;

    if (!allRequestsFailed && options.write) {
      await writeFile(options.state, `${JSON.stringify(report.nextState, null, 2)}\n`, 'utf8');
    }

    if (options.json) {
      stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const result of report.results) {
        if (CHANGE_STATUSES.has(result.status)) stdout.write(`${formatChange(result)}\n`);
        if (result.status === 'warning') {
          stderr.write(`warning ${result.key}: ${result.reason}\n`);
        }
      }
    }

    if (allRequestsFailed) {
      stderr.write('policy-monitor: all GitHub API requests failed\n');
      return 1;
    }
    return report.changed ? 2 : 0;
  } catch (error) {
    stderr.write(`policy-monitor: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  process.exitCode = await runPolicyMonitorCli();
}
