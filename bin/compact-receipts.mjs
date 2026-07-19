#!/usr/bin/env node
import {resolve} from 'node:path';

import {renderCompactReceipts} from '../lib/compact-receipts.mjs';

function options(argv) {
  if (argv[0] !== 'render') throw new Error('usage: compact-receipts.mjs render --receipts <dir> --site <dir>');
  const result = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--receipts', '--site'].includes(name) || value === undefined) throw new Error('invalid compact receipt arguments');
    result[name.slice(2)] = resolve(value);
  }
  if (!result.receipts || !result.site) throw new Error('--receipts and --site are required');
  return result;
}

try {
  const parsed = options(process.argv.slice(2));
  const receipts = await renderCompactReceipts({receiptsDir: parsed.receipts, siteDir: parsed.site});
  process.stdout.write(`rendered ${receipts.length} compact receipts\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
