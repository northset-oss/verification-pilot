#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { checkDocumentTargets, checkTargets } from '../lib/policy-monitor.mjs';

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
  if (!isObject(config) || !['0', '1'].includes(config.version) || !Array.isArray(config.targets)) {
    throw new Error('targets config must contain version "0" or "1" and a targets array');
  }
  const documents = config.version === '1' ? config.documents : [];
  if (config.version === '1' && !Array.isArray(documents)) {
    throw new Error('version "1" targets config must contain a documents array');
  }
  if (config.targets.length === 0 && documents.length === 0) {
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
  for (const [index, document] of documents.entries()) {
    let parsed;
    try { parsed = new URL(document?.url); } catch { parsed = null; }
    if (!isObject(document) || !/^[a-z0-9][a-z0-9-]*$/.test(document.id ?? '') ||
        parsed?.protocol !== 'https:' || parsed.hostname !== 'docs.github.com') {
      throw new Error(`documents[${index}] must contain a stable id and https://docs.github.com URL`);
    }
  }
}

function validateState(state) {
  if (!isObject(state) || !['0', '1'].includes(state.version) || !isObject(state.files) ||
      (state.version === '1' && !isObject(state.documents))) {
    throw new Error('state must contain version "0" or "1", a files object, and version "1" documents');
  }
  if (Object.values(state.files).some((sha) => typeof sha !== 'string' || sha.length === 0)) {
    throw new Error('every state file SHA must be a non-empty string');
  }
}

function formatChange(result) {
  const current = result.sha ?? result.digest;
  const previous = result.previousSha ?? result.previous_digest;
  if (result.status === 'new') return `new ${result.key}: ${current}`;
  if (result.status === 'removed') return `removed ${result.key}: ${previous}`;
  return `changed ${result.key}: ${previous} -> ${current}`;
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

    if (targetsConfig.version !== state.version) throw new Error('targets config and state versions must match');
    const repositoryReport = targetsConfig.targets.length ? await checkTargets({
      targets: targetsConfig.targets, state, fetchImpl, token: env.GITHUB_TOKEN,
    }) : {results: [], nextState: {files: state.files}, changed: false};
    const documentReport = targetsConfig.version === '1' ? await checkDocumentTargets({
      documents: targetsConfig.documents, state, fetchImpl,
    }) : {results: [], nextState: {documents: {}}, changed: false};
    const report = {
      results: [...repositoryReport.results, ...documentReport.results],
      nextState: {
        version: targetsConfig.version,
        files: repositoryReport.nextState.files,
        ...(targetsConfig.version === '1' ? {documents: documentReport.nextState.documents} : {}),
      },
      changed: repositoryReport.changed || documentReport.changed,
    };
    const requestCount = targetsConfig.targets.reduce(
      (total, target) => total + target.paths.length,
      0,
    ) + (targetsConfig.documents?.length ?? 0);
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
      stderr.write(targetsConfig.version === '0'
        ? 'policy-monitor: all GitHub API requests failed\n'
        : 'policy-monitor: all policy requests failed\n');
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
