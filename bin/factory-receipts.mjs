#!/usr/bin/env node
import {resolve} from 'node:path';

import {
  mergeFactoryReceipts,
  selectFactoryProofAttestationSubjects,
} from '../lib/factory-receipts.mjs';

const USAGE = 'usage: factory-receipts.mjs merge --receipts <dir> --receipts-revision <oid> --index <file> --out <file> | select-attestation-subjects --repo <dir> --receipts-revision <oid> --out <dir>';

function pairs(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(name) || value === undefined) throw new Error('invalid factory receipt arguments');
    const key = name === '--receipts-revision' ? 'receiptRevision' : name.slice(2);
    result[key] = name === '--receipts-revision' ? value : resolve(value);
  }
  return result;
}

function options(argv) {
  const command = argv[0];
  if (command === 'merge') {
    const result = pairs(argv.slice(1), new Set(['--receipts', '--receipts-revision', '--index', '--out']));
    if (!result.receipts || !result.receiptRevision || !result.index || !result.out) {
      throw new Error('--receipts, --receipts-revision, --index, and --out are required');
    }
    return {command, ...result};
  }
  if (command === 'select-attestation-subjects') {
    const result = pairs(argv.slice(1), new Set(['--repo', '--receipts-revision', '--out']));
    if (!result.repo || !result.receiptRevision || !result.out) {
      throw new Error('--repo, --receipts-revision, and --out are required');
    }
    return {command, ...result};
  }
  throw new Error(USAGE);
}

try {
  const parsed = options(process.argv.slice(2));
  if (parsed.command === 'merge') {
    const result = await mergeFactoryReceipts({
      receiptsDir: parsed.receipts,
      receiptRevision: parsed.receiptRevision,
      indexPath: parsed.index,
      out: parsed.out,
    });
    process.stdout.write(`merged ${result.added.length} factory receipts into the canonical ledger index\n`);
  } else {
    const result = await selectFactoryProofAttestationSubjects({
      repositoryPath: parsed.repo,
      receiptRevision: parsed.receiptRevision,
      out: parsed.out,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
