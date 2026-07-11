#!/usr/bin/env node

// The signed bundle is the immutable source of truth. The top-level mission.json the ledger
// renders from may differ ONLY in publication-envelope fields that cannot exist inside the
// bundle at signing time (the attestation URI and the bundle digest are known only AFTER the
// bundle is sealed and signed). Every OTHER field — every execution fact — must be byte-for-byte
// identical, so a public ledger entry can never claim something the attested bundle does not.
// This closes the "split-brain receipt" gap: mutable ledger metadata vs. the signed artifact.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const PUBLICATION_ENVELOPE_FIELDS = new Set(['attestation_uri', 'run_record_bundle_digest']);

function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

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

  const keys = new Set([...Object.keys(top), ...Object.keys(bundled)]);
  const violations = [];
  for (const key of keys) {
    if (PUBLICATION_ENVELOPE_FIELDS.has(key)) continue;
    const a = top[key];
    const b = bundled[key];
    const equal = a !== null && typeof a === 'object'
      ? stableStringify(a) === stableStringify(b ?? {})
      : a === b;
    if (!equal) violations.push(key);
  }

  // A populated envelope field in the top-level receipt must be null in the bundle (the bundle
  // was sealed before it existed) — never a DIFFERENT non-null value.
  for (const key of PUBLICATION_ENVELOPE_FIELDS) {
    if (bundled[key] !== null && bundled[key] !== undefined && bundled[key] !== top[key]) {
      violations.push(`${key} (bundle value diverges)`);
    }
  }

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
