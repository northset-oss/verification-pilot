#!/usr/bin/env node

import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

import {PR_RECEIPT_DISCLOSURE_RETIRED} from '../lib/pr-receipt-disclosure.mjs';

export async function runPrReceiptDisclosureCli({
  stderr = process.stderr,
} = {}) {
  stderr.write(`pr-receipt-disclosure: ${PR_RECEIPT_DISCLOSURE_RETIRED}\n`);
  return 1;
}

function isDirectInvocation() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = await runPrReceiptDisclosureCli();
