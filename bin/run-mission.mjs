#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { PipelineError, runPipeline } from '../lib/pipeline.mjs';

const NEXT_STEP = 'Next: attest bundle in CI (attest-bundle workflow), then it is verifiable with: gh attestation verify <bundle> --repo northset-oss/verification-pilot --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml';
const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes('--json');

function cliError(message) {
  return new PipelineError(message, [{
    ruleId: 'CLI_USAGE',
    path: '$',
    message: `${message}; usage: run-mission.mjs <mission-input.json> --missions-dir <dir> [--site <index.html>] [--now <iso>] [--force] [--require-success] [--json]`,
  }]);
}

function parseArguments(arguments_) {
  const inputFile = arguments_.shift();
  if (!inputFile || inputFile.startsWith('--')) {
    throw cliError('one mission-input.json file is required');
  }

  const options = {};
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    if (flag === '--force' || flag === '--json' || flag === '--require-success') {
      const option = { '--force': 'force', '--json': 'json', '--require-success': 'requireSuccess' }[flag];
      if (Object.hasOwn(options, option)) throw cliError(`duplicate flag ${flag}`);
      options[option] = true;
      continue;
    }
    if (flag !== '--missions-dir' && flag !== '--now' && flag !== '--site') {
      throw cliError(`unknown argument ${flag}`);
    }
    const option = { '--missions-dir': 'missionsDir', '--now': 'now', '--site': 'siteFile' }[flag];
    if (Object.hasOwn(options, option)) throw cliError(`duplicate flag ${flag}`);
    const value = arguments_.shift();
    if (value === undefined || value.startsWith('--')) throw cliError(`${flag} requires a value`);
    options[option] = value;
  }
  if (!Object.hasOwn(options, 'missionsDir')) throw cliError('missing required flag --missions-dir');
  delete options.json;
  return { inputFile, options };
}

async function readInput(inputFile) {
  let source;
  try {
    source = await readFile(inputFile, 'utf8');
  } catch (error) {
    throw new PipelineError(`cannot read ${inputFile}`, [{
      ruleId: 'CLI_READ',
      path: inputFile,
      message: error.message,
    }]);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new PipelineError(`invalid JSON in ${inputFile}`, [{
      ruleId: 'MISSION_INPUT_JSON_PARSE',
      path: inputFile,
      message: error.message,
    }]);
  }
}

function errorItems(error) {
  if (Array.isArray(error?.errors) && error.errors.length > 0) return error.errors;
  return [{ ruleId: 'PIPELINE_ERROR', path: '$', message: error?.message ?? String(error) }];
}

function printError(error) {
  const errors = errorItems(error);
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      message: error.message,
      errors,
    }, null, 2)}\n`);
    return;
  }
  process.stderr.write(`PIPELINE_ERROR: ${error.message}\n`);
  for (const item of errors) {
    process.stderr.write(`${item.ruleId}: ${item.path}: ${item.message}\n`);
  }
}

try {
  const { inputFile, options } = parseArguments([...rawArgs]);
  const result = await runPipeline(await readInput(inputFile), {
    ...options,
    onWarning: (message) => process.stderr.write(`warning: ${message}\n`),
  });
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result, next: NEXT_STEP }, null, 2)}\n`);
  } else {
    process.stdout.write(`mission_dir ${result.missionDir}\n`);
    process.stdout.write(`bundle_digest ${result.bundleDigest}\n`);
    process.stdout.write(`ledger_included ${result.ledgerIncluded}\n`);
    if (result.siteFile !== undefined) process.stdout.write(`site_file ${result.siteFile}\n`);
    process.stdout.write(`attestation_pending ${result.attestationPending}\n`);
    process.stdout.write(`${NEXT_STEP}\n`);
  }
} catch (error) {
  printError(error);
  process.exitCode = 1;
}
