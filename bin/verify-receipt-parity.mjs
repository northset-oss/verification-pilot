#!/usr/bin/env node

// The signed bundle is the immutable source of truth. The top-level mission.json the ledger
// renders from may differ ONLY in publication-envelope fields that cannot exist inside the
// bundle at signing time (the attestation URI and the bundle digest are known only AFTER the
// bundle is sealed and signed). Every OTHER field — every execution fact — must be byte-for-byte
// identical, so a public ledger entry can never claim something the attested bundle does not.
// This closes the "split-brain receipt" gap: mutable ledger metadata vs. the signed artifact.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { receiptParityViolations } from '../lib/receipt-parity.mjs';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const missionDir = process.argv[2];
  if (!missionDir) {
    process.stderr.write('usage: verify-receipt-parity.mjs <mission-dir>\n');
    process.exit(2);
  }

  const top = await readJson(path.join(missionDir, 'mission.json'));
  const bundled = await readJson(path.join(missionDir, 'bundle', 'mission.json'));

  const violations = receiptParityViolations(top, bundled);

  if (violations.length > 0) {
    process.stderr.write(
      `SPLIT_BRAIN ${missionDir}: top-level receipt diverges from the signed bundle in: ${violations.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`OK ${path.basename(missionDir)}: ledger receipt == signed bundle (envelope-only differences)\n`);
}

main().catch((error) => {
  process.stderr.write(`verify-receipt-parity: ${error.message}\n`);
  process.exit(1);
});
