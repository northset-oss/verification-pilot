#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

import {
  validateRenderedPublication,
  verifyDeploymentManifest,
  verifyPublishedDeployment,
  writeDeploymentManifest,
} from '../lib/publication-policy.mjs';

const args = process.argv.slice(2);
const command = args.shift();

function options(arguments_) {
  const parsed = {};
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    if (!flag.startsWith('--')) throw new TypeError(`unknown argument ${flag}`);
    const value = arguments_.shift();
    if (value === undefined || value.startsWith('--')) throw new TypeError(`${flag} requires a value`);
    parsed[flag.slice(2).replaceAll('-', '_')] = value;
  }
  return parsed;
}

function required(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

try {
  const parsed = options(args);
  if (command === 'validate') {
    const siteRoot = required(parsed.site, '--site');
    const index = JSON.parse(await readFile(required(parsed.index, '--index'), 'utf8'));
    const result = await validateRenderedPublication({siteRoot, index});
    process.stdout.write(`publication policy: PASS (${result.files} rendered files)\n`);
  } else if (command === 'manifest') {
    const siteRoot = required(parsed.site, '--site');
    const indexSource = await readFile(required(parsed.index, '--index'));
    const manifest = await writeDeploymentManifest({
      siteRoot,
      ledgerSourceOid: required(parsed.ledger_source_oid, '--ledger-source-oid'),
      receiptsSourceOid: required(parsed.receipts_source_oid, '--receipts-source-oid'),
      mergedIndexSha256: `sha256:${createHash('sha256').update(indexSource).digest('hex')}`,
    });
    process.stdout.write(`${manifest.manifest_sha256}\n`);
  } else if (command === 'verify-manifest') {
    const manifest = await verifyDeploymentManifest({siteRoot: required(parsed.site, '--site')});
    process.stdout.write(`${manifest.manifest_sha256}\n`);
  } else if (command === 'verify-live') {
    const result = await verifyPublishedDeployment({
      siteRoot: required(parsed.site, '--site'),
      baseUrl: required(parsed.base_url, '--base-url'),
    });
    process.stdout.write(`deployment parity: PASS (${result.files} files; ${result.manifest_sha256})\n`);
  } else {
    throw new TypeError('usage: publication-policy.mjs validate --site <dir> --index <index.json> | manifest --site <dir> --index <index.json> --ledger-source-oid <oid> --receipts-source-oid <oid> | verify-manifest --site <dir> | verify-live --site <dir> --base-url <url>');
  }
} catch (error) {
  process.stderr.write(`publication policy: ${error.message}\n`);
  process.exitCode = 1;
}
