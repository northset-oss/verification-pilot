#!/usr/bin/env node

import { BundleError, createBundle, verifyBundle } from '../lib/bundle.mjs';

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes('--json');
const args = rawArgs.filter((argument) => argument !== '--json');
const subcommand = args.shift();

function usageError(message) {
  return new BundleError(message, [{
    ruleId: 'CLI_USAGE',
    path: '$',
    message: `${message}; usage: bundle.mjs create <mission-dir> --stdout <file> --stderr <file> --run-record <file> --created-at <iso> [--json] | bundle.mjs verify <mission-dir> [--json]`,
  }]);
}

function parseCreate(arguments_) {
  const missionDirectory = arguments_.shift();
  if (!missionDirectory || missionDirectory.startsWith('--')) {
    throw usageError('create requires one mission directory');
  }

  const flagNames = new Map([
    ['--stdout', 'stdoutFile'],
    ['--stderr', 'stderrFile'],
    ['--run-record', 'runRecordFile'],
    ['--created-at', 'createdAt'],
  ]);
  const options = {};
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    const option = flagNames.get(flag);
    if (!option) throw usageError(`unknown create argument ${flag}`);
    if (Object.hasOwn(options, option)) throw usageError(`duplicate flag ${flag}`);
    const value = arguments_.shift();
    if (value === undefined || value.startsWith('--')) throw usageError(`${flag} requires a value`);
    options[option] = value;
  }
  for (const [flag, option] of flagNames) {
    if (!Object.hasOwn(options, option)) throw usageError(`missing required flag ${flag}`);
  }
  return { missionDirectory, options };
}

function parseVerify(arguments_) {
  if (arguments_.length !== 1 || arguments_[0].startsWith('--')) {
    throw usageError('verify requires exactly one mission directory');
  }
  return arguments_[0];
}

function printErrors(error) {
  const errors = error instanceof BundleError
    ? error.errors
    : [{ ruleId: 'BUNDLE_ERROR', path: '$', message: error.message }];
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, errors }, null, 2)}\n`);
  } else {
    for (const item of errors) {
      process.stderr.write(`${item.ruleId}: ${item.path}: ${item.message}\n`);
    }
  }
}

function printVerificationFailure(result) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      bundle_digest: result.bundleDigest,
      issues: result.issues,
    }, null, 2)}\n`);
    return;
  }
  for (const issue of result.issues) {
    process.stderr.write(`${issue.kind.toUpperCase()} ${issue.path}${issue.message ? `: ${issue.message}` : ''}\n`);
  }
}

try {
  if (subcommand === 'create') {
    const { missionDirectory, options } = parseCreate(args);
    const result = await createBundle(missionDirectory, options);
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ ok: true, bundle_digest: result.bundleDigest }, null, 2)}\n`);
    } else {
      process.stdout.write(`bundle_digest ${result.bundleDigest}\n`);
    }
  } else if (subcommand === 'verify') {
    const missionDirectory = parseVerify(args);
    const result = await verifyBundle(missionDirectory);
    if (!result.ok) {
      printVerificationFailure(result);
      process.exitCode = 1;
    } else if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ ok: true, bundle_digest: result.bundleDigest }, null, 2)}\n`);
    } else {
      process.stdout.write(`OK ${result.bundleDigest}\n`);
    }
  } else {
    throw usageError(subcommand ? `unknown subcommand ${subcommand}` : 'missing subcommand');
  }
} catch (error) {
  printErrors(error);
  process.exitCode = 1;
}
