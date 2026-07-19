import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access, mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {mergeFactoryReceipts} from '../lib/factory-receipts.mjs';
import {renderLedger} from '../lib/ledger.mjs';

const generatedAt = '2026-07-19T14:00:00Z';
const oid = (value) => value.repeat(40);
const sha = (value) => `sha256:${value.repeat(64)}`;
const fileDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function observation(overrides = {}) {
  return {
    phase: 'patched_observation',
    command: 'node --test test/regression.test.js',
    network: 'none',
    expected_result: 'success',
    result: 'PASS',
    expectation_met: true,
    started_at: '2026-07-19T13:00:01Z',
    finished_at: '2026-07-19T13:00:03Z',
    duration_ms: 2000,
    exit_code: 0,
    stdout_sha256: sha('1'),
    stderr_sha256: sha('2'),
    output_sha256: sha('3'),
    ...overrides,
  };
}

function structuredProof() {
  const base = observation({
    phase: 'base_observation',
    expected_result: 'failure',
    result: 'FAIL',
    exit_code: 1,
    started_at: '2026-07-19T13:00:00Z',
    finished_at: '2026-07-19T13:00:01Z',
    duration_ms: 1000,
  });
  const patched = observation();
  return {
    schema_version: 2,
    mission_id: 'M-1002',
    task_id: 'TASK-2',
    repository: 'owner/repo',
    issue_number: 12,
    candidate: 'owner/repo#12',
    base_oid: oid('a'),
    patch_sha256: sha('b'),
    commit_oid: oid('c'),
    tested_tree_oid: oid('d'),
    checks: ['node --test test/regression.test.js'],
    claim: {type: 'regression_fix', statement: 'regression_fix'},
    batch_approval_digest: sha('e'),
    environment: {profile: 'node', image: sha('f'), architecture: 'arm64', network: 'none'},
    base_observation: base,
    patched_observation: patched,
    executed_commands: [base, patched],
    checks_not_run: [{check: 'npm test', reason: 'outside the approved verification scope'}],
    limitations: ['Repository-wide CI was not executed.'],
    verification_started_at: '2026-07-19T13:00:00Z',
    verification_finished_at: '2026-07-19T13:00:03Z',
  };
}

function legacyProof() {
  return {
    schema_version: 1,
    mission_id: 'M-1001',
    task_id: 'TASK-1',
    repository: 'owner/repo',
    issue_number: 11,
    candidate: 'owner/repo#11',
    base_oid: oid('a'),
    patch_sha256: sha('b'),
    commit_oid: oid('9'),
    tested_tree_oid: oid('d'),
    checks: ['PASS: a free-form legacy check', 'BLOCKED: npm test'],
    claim: {type: 'regression_fix', statement: 'regression_fix'},
    batch_approval_digest: sha('e'),
    environment: {profile: 'node', image: sha('f'), architecture: 'arm64', network: 'none'},
    base_observation: {exit_code: 1},
    patched_observation: {exit_code: 0},
  };
}

async function writeFactoryProof(receipts, proof) {
  const bytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  const directory = path.join(receipts, proof.mission_id, proof.commit_oid);
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(directory, 'proof.json'), bytes);
  await writeFile(path.join(receipts, proof.mission_id, 'current.json'), `${JSON.stringify({
    schema_version: 1,
    mission_id: proof.mission_id,
    contribution_commit_oid: proof.commit_oid,
    proof_sha256: fileDigest(bytes),
  })}\n`);
}

async function writeFactoryPublication(receipts, proof, overrides = {}) {
  const publication = {
    schema_version: 1,
    mission_id: proof.mission_id,
    contribution_commit_oid: proof.commit_oid,
    receipt_url: `https://northset-oss.github.io/verification-pilot/receipts/${proof.mission_id}/`,
    pr_url: 'https://github.com/owner/repo/pull/4222',
    pr_number: 4222,
    pr_state: 'OPEN',
    merged: false,
    ci_state: 'PENDING',
    attestation_state: 'ATTESTATION_PENDING',
    attestation_url: null,
    observed_at: '2026-07-19T13:30:00Z',
    ...overrides,
  };
  await writeFile(path.join(receipts, proof.mission_id, proof.commit_oid, 'publication.json'),
    `${JSON.stringify(publication)}\n`);
}

async function setup(proofs) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'factory-receipts-'));
  const receipts = path.join(root, 'receipts');
  const sourceIndex = path.join(root, 'index.json');
  const mergedIndex = path.join(root, 'merged-index.json');
  const site = path.join(root, 'site');
  await mkdir(receipts, {recursive: true});
  await writeFile(sourceIndex, `${JSON.stringify({version: '0', generated_at: generatedAt, missions: []})}\n`);
  for (const proof of proofs) await writeFactoryProof(receipts, proof);
  return {root, receipts, sourceIndex, mergedIndex, site};
}

test('factory v2 proof is merged into the normal ledger and rendered by the canonical folio', async () => {
  const fixture = await setup([structuredProof()]);
  const result = await mergeFactoryReceipts({
    receiptsDir: fixture.receipts,
    receiptRevision: oid('f'),
    indexPath: fixture.sourceIndex,
    out: fixture.mergedIndex,
  });
  assert.deepEqual(result.added, [{mission_id: 'M-1002', evidence_status: 'complete'}]);

  await renderLedger({indexPath: fixture.mergedIndex, out: path.join(fixture.site, 'index.html')});
  const html = await readFile(path.join(fixture.site, 'receipts/M-1002/index.html'), 'utf8');
  const homepage = await readFile(path.join(fixture.site, 'index.html'), 'utf8');
  const ledger = JSON.parse(await readFile(path.join(fixture.site, 'ledger.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(path.join(fixture.site, 'receipts/M-1002/receipt.json'), 'utf8'));
  const schema = JSON.parse(await readFile(path.join(fixture.site, 'schema/public-receipt.schema.json'), 'utf8'));

  assert.match(html, /class="receipt receipt--self-run receipt--economic receipt--v1/);
  assert.match(html, /class="proof-hero"/);
  assert.match(html, /Evidence annex/);
  assert.match(html, /Checks not run/);
  assert.doesNotMatch(html, /body\{max-width:58rem/);
  assert.match(homepage, /receipts\/M-1002\//);
  assert.equal(ledger.receipts.length, 1);
  assert.equal(ledger.receipts[0].receipt_id, 'M-1002');
  assert.equal(receipt.schema_version, 3);
  assert.equal(receipt.evidence_status, 'complete');
  assert.equal(receipt.receipt_result, 'PASS — 1/1 declared command');
  assert.deepEqual(receipt.commands.map((command) => command.exit_code), [0]);
  assert.equal(receipt.checks_not_run[0].check, 'npm test');
  assert.equal(receipt.source.proof_schema_version, 2);
  assert.equal(receipt.bundle.bundle_contents_digest, null);
  assert.ok(schema.properties.schema_version.enum.includes(3));
  const v3 = schema.allOf.find((entry) => entry.if?.properties?.schema_version?.const === 3 &&
    entry.then?.properties?.code);
  assert.equal(v3.then.properties.code.properties.tested_tree_oid.$ref, '#/$defs/oid');
  assert.deepEqual(Object.keys(receipt).filter((key) => !Object.hasOwn(schema.properties, key)), []);
  for (const key of schema.required) assert.ok(Object.hasOwn(receipt, key), `missing schema-required ${key}`);
  await assert.rejects(access(path.join(fixture.site, 'receipts/compact-index.json')), (error) => error.code === 'ENOENT');

  const secondIndex = path.join(fixture.root, 'second-index.json');
  const secondSite = path.join(fixture.root, 'second-site');
  await mergeFactoryReceipts({
    receiptsDir: fixture.receipts,
    receiptRevision: oid('f'),
    indexPath: fixture.sourceIndex,
    out: secondIndex,
  });
  await renderLedger({indexPath: secondIndex, out: path.join(secondSite, 'index.html')});
  assert.equal(await readFile(secondIndex, 'utf8'), await readFile(fixture.mergedIndex, 'utf8'));
  for (const relative of ['index.html', 'ledger.json', 'receipts/M-1002/index.html', 'receipts/M-1002/receipt.json']) {
    assert.equal(await readFile(path.join(secondSite, relative), 'utf8'),
      await readFile(path.join(fixture.site, relative), 'utf8'), relative);
  }
});

test('immutable legacy factory proof becomes an incomplete canonical record without invented PASS data', async () => {
  const proof = legacyProof();
  const fixture = await setup([proof]);
  await writeFactoryPublication(fixture.receipts, proof);
  await mergeFactoryReceipts({
    receiptsDir: fixture.receipts,
    receiptRevision: oid('f'),
    indexPath: fixture.sourceIndex,
    out: fixture.mergedIndex,
  });
  await renderLedger({indexPath: fixture.mergedIndex, out: path.join(fixture.site, 'index.html')});
  const html = await readFile(path.join(fixture.site, 'receipts/M-1001/index.html'), 'utf8');
  const receipt = JSON.parse(await readFile(path.join(fixture.site, 'receipts/M-1001/receipt.json'), 'utf8'));

  assert.match(html, /Receipt Evidence Record/);
  assert.match(html, /structured command evidence unavailable/i);
  assert.match(html, /Legacy declarations/);
  assert.match(html, /PASS: a free-form legacy check/);
  assert.match(html, /PR #4222/);
  assert.match(html, /CI state<\/dt><dd>PENDING/);
  assert.equal(receipt.evidence_status, 'incomplete');
  assert.equal(receipt.receipt_result, 'INCOMPLETE — structured command evidence unavailable');
  assert.deepEqual(receipt.timestamps, {started_at: null, finished_at: null});
  assert.deepEqual(receipt.commands, []);
  assert.equal(receipt.passed_commands, 0);
  assert.equal(receipt.declared_commands, 0);
  assert.equal(receipt.legacy_checks.length, 2);
  assert.equal(receipt.bundle.bundle_contents_digest, null);
  assert.equal(receipt.links.publication_pr, 'https://github.com/owner/repo/pull/4222');
  assert.equal(receipt.upstream_outcome.status, 'open');
  assert.equal(receipt.source.factory_publication.ci_state, 'PENDING');
  assert.equal(receipt.source.raw_proof_url,
    `https://github.com/northset-oss/verification-pilot/blob/${oid('f')}/receipts/M-1001/${proof.commit_oid}/proof.json`);
  assert.equal(receipt.source.raw_publication_url,
    `https://github.com/northset-oss/verification-pilot/blob/${oid('f')}/receipts/M-1001/${proof.commit_oid}/publication.json`);
  assert.equal(receipt.code.patch_commit_binding, 'bound to verified tested tree');
  assert.equal(receipt.code.tested_tree_oid, proof.tested_tree_oid);
  assert.equal(receipt.environment.source_commit, proof.commit_oid);
});

test('factory adapter fails closed on digest drift and false structured PASS evidence', async () => {
  const corrupt = await setup([structuredProof()]);
  const pointerFile = path.join(corrupt.receipts, 'M-1002/current.json');
  const pointer = JSON.parse(await readFile(pointerFile, 'utf8'));
  pointer.proof_sha256 = sha('0');
  await writeFile(pointerFile, `${JSON.stringify(pointer)}\n`);
  await assert.rejects(mergeFactoryReceipts({
    receiptsDir: corrupt.receipts,
    receiptRevision: oid('f'),
    indexPath: corrupt.sourceIndex,
    out: corrupt.mergedIndex,
  }), /digest does not match/);

  const falsePassProof = structuredProof();
  falsePassProof.executed_commands[1].expectation_met = false;
  falsePassProof.patched_observation = falsePassProof.executed_commands[1];
  const falsePass = await setup([falsePassProof]);
  await assert.rejects(mergeFactoryReceipts({
    receiptsDir: falsePass.receipts,
    receiptRevision: oid('f'),
    indexPath: falsePass.sourceIndex,
    out: falsePass.mergedIndex,
  }), /cannot publish PASS|expectation does not match its exit code/);
});

test('factory adapter rejects contradictory structured observations and publication state', async () => {
  const contradictoryProof = structuredProof();
  contradictoryProof.executed_commands[0] = {
    ...contradictoryProof.executed_commands[0],
    started_at: 'not-a-time',
  };
  const contradictory = await setup([contradictoryProof]);
  await assert.rejects(mergeFactoryReceipts({
    receiptsDir: contradictory.receipts,
    receiptRevision: oid('f'),
    indexPath: contradictory.sourceIndex,
    out: contradictory.mergedIndex,
  }), /must be an ISO-8601 time|contradict/);

  const proof = structuredProof();
  const malformedPublication = await setup([proof]);
  await writeFactoryPublication(malformedPublication.receipts, proof, {
    pr_state: 'MERGED',
    merged: false,
  });
  await assert.rejects(mergeFactoryReceipts({
    receiptsDir: malformedPublication.receipts,
    receiptRevision: oid('f'),
    indexPath: malformedPublication.sourceIndex,
    out: malformedPublication.mergedIndex,
  }), /merged state is inconsistent/);
});
