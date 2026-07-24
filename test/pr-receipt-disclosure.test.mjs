import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {
  auditAllDisclosures,
  auditAllFactoryDisclosures,
  canonicalReceiptUrl,
  createFetchRequest,
  renderDisclosureBlock,
  syncFactoryDisclosure,
  syncMissionDisclosure,
  upsertDisclosureBlock,
  validateDisclosurePolicy,
} from '../lib/pr-receipt-disclosure.mjs';
import {runPrReceiptDisclosureCli} from '../bin/pr-receipt-disclosure.mjs';

const retired = /upstream inspection, copy generation, and mutation are disabled/i;

test('disclosure library has no usable inspection or copy-generation path', async () => {
  for (const operation of [
    validateDisclosurePolicy,
    canonicalReceiptUrl,
    renderDisclosureBlock,
    upsertDisclosureBlock,
    createFetchRequest,
  ]) assert.throws(() => operation(), retired);
  await assert.rejects(auditAllDisclosures(), retired);
  await assert.rejects(auditAllFactoryDisclosures(), retired);
});

test('exported synchronizers cannot perform upstream mutation', async () => {
  let patches = 0;
  const request = async (_url, options = {}) => {
    if (options.method === 'PATCH') patches += 1;
    throw new Error('network must not be reached');
  };
  await assert.rejects(syncFactoryDisclosure({request}), retired);
  await assert.rejects(syncMissionDisclosure({request}), retired);
  assert.equal(patches, 0);
});

test('CLI is retired for every invocation without reading credentials or reaching the network', async () => {
  let output = '';
  let errorOutput = '';
  const exitCode = await runPrReceiptDisclosureCli({
    args: ['sync', '--apply'],
    env: {GITHUB_TOKEN: 'must-not-be-read'},
    stdout: {write: (value) => { output += value; }},
    stderr: {write: (value) => { errorOutput += value; }},
    fetchImpl: async () => { throw new Error('network must not be reached'); },
  });
  assert.equal(exitCode, 1);
  assert.equal(output, '');
  assert.match(errorOutput, retired);
});

test('retired disclosure sources contain no acquisition or upstream mutation implementation', async () => {
  const library = await readFile(new URL('../lib/pr-receipt-disclosure.mjs', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../bin/pr-receipt-disclosure.mjs', import.meta.url), 'utf8');
  for (const source of [library, cli]) {
    assert.doesNotMatch(source, /request-a-run|northset-verify|oss@northset|checkable in|method:\s*['"]PATCH/i);
  }
});
