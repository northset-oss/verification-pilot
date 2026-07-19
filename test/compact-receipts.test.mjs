import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {renderCompactReceipts} from '../lib/compact-receipts.mjs';

const oid = (value) => value.repeat(40);
const sha = (value) => `sha256:${value.repeat(64)}`;
const fileDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function proof() {
  return {
    schema_version: 1, mission_id: 'M-1001', task_id: 'TASK-1', repository: 'owner/repo', issue_number: 12,
    candidate: 'owner/repo#12', base_oid: oid('a'), patch_sha256: sha('b'), commit_oid: oid('c'),
    tested_tree_oid: oid('d'), checks: ['PASS: focused check'], claim: {type: 'regression_fix', statement: 'regression_fix'},
    batch_approval_digest: sha('e'), environment: {profile: 'node'},
    base_observation: {exit_code: 1}, patched_observation: {exit_code: 0},
  };
}

test('renders a canonical HTML and JSON receipt bound to current proof bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compact-receipts-'));
  const receipts = path.join(root, 'receipts');
  const site = path.join(root, 'site');
  const source = proof();
  const bytes = Buffer.from(`${JSON.stringify(source)}\n`);
  const directory = path.join(receipts, source.mission_id, source.commit_oid);
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(directory, 'proof.json'), bytes);
  await writeFile(path.join(receipts, source.mission_id, 'current.json'), `${JSON.stringify({
    schema_version: 1, mission_id: source.mission_id, contribution_commit_oid: source.commit_oid,
    proof_sha256: fileDigest(bytes),
  })}\n`);

  const result = await renderCompactReceipts({receiptsDir: receipts, siteDir: site});
  assert.equal(result.length, 1);
  const receipt = JSON.parse(await readFile(path.join(site, 'receipts', 'M-1001', 'receipt.json'), 'utf8'));
  assert.equal(receipt.target.contribution_commit_oid, source.commit_oid);
  assert.equal(receipt.source.proof_sha256, fileDigest(bytes));
  const html = await readFile(path.join(site, 'receipts', 'M-1001', 'index.html'), 'utf8');
  assert.match(html, /M-1001 proof-of-pass receipt/);
  assert.match(html, /Contributor self-run\. Not maintainer verification\./);
});

test('rejects a current pointer that does not match immutable proof bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'compact-receipts-'));
  const receipts = path.join(root, 'receipts');
  const source = proof();
  const directory = path.join(receipts, source.mission_id, source.commit_oid);
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(directory, 'proof.json'), `${JSON.stringify(source)}\n`);
  await writeFile(path.join(receipts, source.mission_id, 'current.json'), `${JSON.stringify({
    schema_version: 1, mission_id: source.mission_id, contribution_commit_oid: source.commit_oid,
    proof_sha256: sha('f'),
  })}\n`);
  await assert.rejects(renderCompactReceipts({receiptsDir: receipts, siteDir: path.join(root, 'site')}),
    /current proof digest does not match/);
});
