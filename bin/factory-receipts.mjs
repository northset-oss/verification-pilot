#!/usr/bin/env node
import {resolve} from 'node:path';

import {mergeFactoryReceipts} from '../lib/factory-receipts.mjs';

function options(argv) {
  if (argv[0] !== 'merge') {
    throw new Error('usage: factory-receipts.mjs merge --receipts <dir> --receipts-revision <oid> --index <file> --out <file>');
  }
  const result = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--receipts', '--receipts-revision', '--index', '--out'].includes(name) || value === undefined) {
      throw new Error('invalid factory receipt arguments');
    }
    const key = name === '--receipts-revision' ? 'receiptRevision' : name.slice(2);
    result[key] = name === '--receipts-revision' ? value : resolve(value);
  }
  if (!result.receipts || !result.receiptRevision || !result.index || !result.out) {
    throw new Error('--receipts, --receipts-revision, --index, and --out are required');
  }
  return result;
}

try {
  const parsed = options(process.argv.slice(2));
  const result = await mergeFactoryReceipts({
    receiptsDir: parsed.receipts,
    receiptRevision: parsed.receiptRevision,
    indexPath: parsed.index,
    out: parsed.out,
  });
  process.stdout.write(`merged ${result.added.length} factory receipts into the canonical ledger index\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
