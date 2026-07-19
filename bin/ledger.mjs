#!/usr/bin/env node

import { buildLedger, renderLedger } from '../lib/ledger.mjs';

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes('--json');
const allowSkips = rawArgs.includes('--allow-skips');
const args = rawArgs.filter((argument) => argument !== '--json' && argument !== '--allow-skips');
const subcommand = args.shift();

function usage(message) {
  const command = 'ledger.mjs build --missions-dir <dir> --out <index.json> [--now <iso>] [--allow-skips] [--json] | ledger.mjs render --index <index.json> --out <site/index.html> [--now <iso>]';
  throw new Error(`${message}; usage: ${command}`);
}

function parseOptions(arguments_, flags) {
  const options = {};
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    const option = flags.get(flag);
    if (!option) usage(`unknown argument ${flag}`);
    if (Object.hasOwn(options, option)) usage(`duplicate flag ${flag}`);
    const value = arguments_.shift();
    if (value === undefined || value.startsWith('--')) usage(`${flag} requires a value`);
    options[option] = value;
  }
  return options;
}

function requireOptions(options, flags) {
  for (const [flag, option] of flags) {
    if (!Object.hasOwn(options, option)) usage(`missing required flag ${flag}`);
  }
}

try {
  if (subcommand === 'build') {
    const flags = new Map([
      ['--missions-dir', 'missionsDir'],
      ['--out', 'out'],
      ['--now', 'now'],
    ]);
    const options = parseOptions(args, flags);
    requireOptions(options, new Map([
      ['--missions-dir', 'missionsDir'],
      ['--out', 'out'],
    ]));
    const result = await buildLedger({
      ...options,
      now: options.now ?? null,
      onWarning: (message) => process.stderr.write(`warning: ${message}\n`),
      allowSkips,
    });
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify({ included: result.included, skipped: result.skipped })}\n`);
    }
  } else if (subcommand === 'render') {
    if (allowSkips) usage('--allow-skips is only valid for build');
    const flags = new Map([
      ['--index', 'indexPath'],
      ['--out', 'out'],
      ['--now', 'now'],
    ]);
    const options = parseOptions(args, flags);
    requireOptions(options, new Map([
      ['--index', 'indexPath'],
      ['--out', 'out'],
    ]));
    await renderLedger({ ...options, now: options.now ?? null });
  } else {
    usage(subcommand ? `unknown subcommand ${subcommand}` : 'missing subcommand');
  }
} catch (error) {
  process.stderr.write(`ledger: ${error.message}\n`);
  process.exitCode = 1;
}
