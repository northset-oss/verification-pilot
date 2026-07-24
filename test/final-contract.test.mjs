import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLedger, renderLedger, validatePublication } from '../lib/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const generatedAt = '2026-07-14T14:30:00Z';
const publicationFields = [
  'schema_version', 'mission_id', 'state', 'pr_number', 'pr_url', 'pr_head_oid',
  'base_branch', 'head_drift', 'ci_state', 'merge_commit_oid', 'review_decision',
  'decision_url', 'opened_at', 'closed_at', 'updated_at', 'observed_at',
  'correction_note', 'scope_note', 'attestation_uri', 'bundle_digest',
  'release_asset_sha256', 'attestation_verified_at',
].sort();

function completePublication(overrides = {}) {
  return {
    schema_version: 1,
    mission_id: 'M-007',
    state: 'open',
    pr_number: 7,
    pr_url: 'https://github.com/acme/project/pull/7',
    pr_head_oid: 'a'.repeat(40),
    base_branch: 'main',
    head_drift: false,
    ci_state: 'success',
    merge_commit_oid: null,
    review_decision: 'review_required',
    decision_url: null,
    opened_at: '2026-07-14T10:00:00Z',
    closed_at: null,
    updated_at: '2026-07-14T10:01:00Z',
    observed_at: '2026-07-14T14:25:52Z',
    correction_note: null,
    scope_note: null,
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-007/run-record-M-007.tar.gz',
    bundle_digest: `sha256:${'b'.repeat(64)}`,
    release_asset_sha256: `sha256:${'c'.repeat(64)}`,
    attestation_verified_at: '2026-07-14T14:21:48Z',
    ...overrides,
  };
}

test('publication schema is exact, complete, and enforces state-dependent facts', () => {
  assert.deepEqual(Object.keys(validatePublication(completePublication(), 'M-007')).sort(), publicationFields);
  assert.throws(() => validatePublication({ ...completePublication(), surprise: true }, 'M-007'), /allowed|unknown|additional/i);
  const missing = completePublication();
  delete missing.observed_at;
  assert.throws(() => validatePublication(missing, 'M-007'), /observed_at.*required/i);
  assert.throws(() => validatePublication(completePublication({ state: 'merged', closed_at: '2026-07-14T10:01:00Z', merge_commit_oid: null }), 'M-007'), /merge_commit_oid/i);
  assert.throws(() => validatePublication(completePublication({ state: 'open', closed_at: generatedAt }), 'M-007'), /closed_at/i);
  assert.throws(() => validatePublication(completePublication({ head_drift: true, pr_head_oid: null }), 'M-007'), /head_drift|pr_head_oid/i);
  assert.throws(() => validatePublication(completePublication({ release_asset_sha256: 'abc' }), 'M-007'), /release_asset_sha256/i);
  assert.throws(() => validatePublication(completePublication({ observed_at: '2026-07-14T09:59:59Z' }), 'M-007'), /observed_at|timestamps/i);
  assert.throws(() => validatePublication(completePublication({
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-007/run-record-M-007.tar.gz?download=1',
  }), 'M-007'), /attestation_uri|release asset/i);

  const pendingPrepared = completePublication({
    state: 'prepared',
    pr_number: null,
    pr_url: null,
    pr_head_oid: null,
    base_branch: null,
    head_drift: false,
    ci_state: null,
    merge_commit_oid: null,
    review_decision: null,
    decision_url: null,
    opened_at: null,
    closed_at: null,
    updated_at: null,
    observed_at: null,
    attestation_uri: null,
    release_asset_sha256: null,
    attestation_verified_at: null,
  });
  assert.doesNotThrow(() => validatePublication(pendingPrepared, 'M-007'));
  const attestationEvidence = {
    attestation_uri: completePublication().attestation_uri,
    release_asset_sha256: completePublication().release_asset_sha256,
    attestation_verified_at: completePublication().attestation_verified_at,
  };
  assert.doesNotThrow(() => validatePublication({ ...pendingPrepared, ...attestationEvidence }, 'M-007'));
  const evidenceFields = Object.keys(attestationEvidence);
  for (let mask = 1; mask < 7; mask += 1) {
    const partial = { ...pendingPrepared };
    evidenceFields.forEach((field, index) => {
      if ((mask & (1 << index)) !== 0) partial[field] = attestationEvidence[field];
    });
    assert.throws(
      () => validatePublication(partial, 'M-007'),
      /prepared attestation evidence must be all null or all present/i,
      `partial attestation mask ${mask.toString(2).padStart(3, '0')}`,
    );
  }
  for (const field of ['attestation_uri', 'release_asset_sha256', 'attestation_verified_at']) {
    assert.throws(
      () => validatePublication(completePublication({ [field]: null }), 'M-007'),
      new RegExp(`publication ${field} is required for external records`, 'i'),
    );
  }

  const future = completePublication({
    mission_id: 'M-021',
    pr_number: 21,
    pr_url: 'https://github.com/acme/project/pull/21',
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-021/run-record-M-021.tar.gz',
    pr_disclosure: {
      schema_version: 1,
      required: true,
      mode: 'pr_body',
      canonical_url: 'https://northset-oss.github.io/verification-pilot/receipts/M-021/',
      verified_at: '2026-07-14T14:29:00Z',
    },
  });
  assert.equal(validatePublication(future, 'M-021').pr_disclosure.mode, 'pr_body');
  assert.throws(
    () => validatePublication({
      ...future,
      pr_disclosure: { ...future.pr_disclosure, canonical_url: 'https://example.com/M-021/' },
    }, 'M-021'),
    /pr_disclosure.*canonical/i,
  );
  assert.throws(
    () => validatePublication({
      ...future,
      pr_disclosure: { ...future.pr_disclosure, extra: true },
    }, 'M-021'),
    /pr_disclosure.*extra.*allowed/i,
  );
  assert.throws(
    () => validatePublication({
      ...future,
      pr_disclosure: { ...future.pr_disclosure, verified_at: '2026-07-14T09:59:59Z' },
    }, 'M-021'),
    /pr_disclosure.*verified_at.*opened_at/i,
  );
});

test('ledger cross-checks head_drift against the immutable recorded patch commit', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-head-drift-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const missions = path.join(temporaryRoot, 'missions');
  await cp(path.join(root, 'missions/M-007'), path.join(missions, 'M-007'), { recursive: true });
  const publicationPath = path.join(missions, 'M-007/publication.json');
  const mission = JSON.parse(await readFile(path.join(missions, 'M-007/mission.json'), 'utf8'));
  const publication = JSON.parse(await readFile(publicationPath, 'utf8'));

  publication.pr_head_oid = 'f'.repeat(40);
  publication.head_drift = false;
  await writeFile(publicationPath, `${JSON.stringify(publication, null, 2)}\n`);
  await assert.rejects(
    buildLedger({ missionsDir: missions, out: path.join(temporaryRoot, 'false-mismatch.json'), now: generatedAt }),
    /head_drift.*mismatch|mismatch.*head_drift/i,
  );

  publication.pr_head_oid = mission.patch_commit;
  publication.head_drift = true;
  await writeFile(publicationPath, `${JSON.stringify(publication, null, 2)}\n`);
  await assert.rejects(
    buildLedger({ missionsDir: missions, out: path.join(temporaryRoot, 'true-match.json'), now: generatedAt }),
    /head_drift.*mismatch|mismatch.*head_drift/i,
  );
});

test('all committed missions have complete publication envelopes and freshness metadata', async () => {
  const committedIndex = JSON.parse(
    await readFile(path.join(root, 'missions/index.json'), 'utf8'),
  );
  for (const { mission_id: missionId } of committedIndex.missions) {
    const publication = JSON.parse(await readFile(path.join(root, 'missions', missionId, 'publication.json'), 'utf8'));
    const expectedFields = [
      ...publicationFields,
      ...(publication.pr_disclosure ? ['pr_disclosure'] : []),
      ...(publication.schema_version === 2 ? ['listing', 'correction'] : []),
    ].sort();
    assert.deepEqual(Object.keys(publication).sort(), expectedFields, missionId);
    if (publication.state === 'prepared' && publication.attestation_uri === null) {
      assert.equal(publication.attestation_uri, null);
      assert.equal(publication.release_asset_sha256, null);
      assert.equal(publication.attestation_verified_at, null);
    } else {
      assert.match(publication.attestation_verified_at, /^2026-[0-9]{2}-[0-9]{2}T[0-9:]+(?:\.[0-9]{3})?Z$/, missionId);
      assert.match(publication.release_asset_sha256, /^sha256:[0-9a-f]{64}$/, missionId);
    }
    validatePublication(publication, missionId);
  }
});

test('generated public ledger fails closed and keeps correction-only records unlisted', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-final-contract-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const indexPath = path.join(temporaryRoot, 'index.json');
  const siteFile = path.join(temporaryRoot, 'site', 'index.html');
  const built = await buildLedger({ missionsDir: path.join(root, 'missions'), out: indexPath, now: generatedAt });
  const committedIndex = JSON.parse(
    await readFile(path.join(root, 'missions/index.json'), 'utf8'),
  );
  assert.equal(built.included, committedIndex.missions.length);
  assert.equal(built.index.missions.length, committedIndex.missions.length);
  await renderLedger({ indexPath, out: siteFile, now: generatedAt });
  const html = await readFile(siteFile, 'utf8');
  assert.match(html, /M-004/);
  assert.doesNotMatch(html, /M-012|M-020|Upstream CI agreed|mailto:|request a run/i);
  const publicLedger = JSON.parse(await readFile(path.join(temporaryRoot, 'site/ledger.json'), 'utf8'));
  assert.equal(publicLedger.generated_at, generatedAt);
  assert.deepEqual(publicLedger.receipts.map(({ receipt_id: receiptId }) => receiptId), ['M-004']);

  const correctionPage = await readFile(path.join(temporaryRoot, 'site/receipts/M-012/index.html'), 'utf8');
  assert.match(correctionPage, /noindex,nofollow/);
  assert.match(correctionPage, /PR #901 was closed unmerged after a maintainer objected/);
  assert.match(correctionPage, /LEGACY_SELF_RUN_RECORD/);
  assert.match(
    correctionPage,
    /gh attestation verify run-record-M-012\.tar\.gz --repo northset-oss\/verification-pilot --signer-workflow northset-oss\/verification-pilot\/\.github\/workflows\/attest-bundle\.yml/,
  );
  assert.doesNotMatch(correctionPage, /data-filter|external-receipts|navigator\.clipboard|window\.print/);
  assert.doesNotMatch(correctionPage, /mailto:|request a run|Upstream CI agreed/i);
  const correctionReceipt = JSON.parse(
    await readFile(path.join(temporaryRoot, 'site/receipts/M-012/receipt.json'), 'utf8'),
  );
  assert.equal(
    correctionReceipt.artifact_verification.verify_command,
    'gh attestation verify run-record-M-012.tar.gz --repo northset-oss/verification-pilot --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml',
  );
  assert.equal(
    correctionReceipt.artifact_verification.release_asset_sha256,
    'sha256:653a46b74e428acb75738ae1e7b8a1b2b66cb36933087927538a971032561cdf',
  );

  await assert.rejects(
    readFile(path.join(temporaryRoot, 'site/receipts/M-020/receipt.json'), 'utf8'),
    { code: 'ENOENT' },
  );
  await assert.rejects(
    readFile(path.join(temporaryRoot, 'site/repo/nodejs--doc-kit/index.html'), 'utf8'),
    { code: 'ENOENT' },
  );
});

test('render rejects unknown index fields instead of trusting hand-authored projections', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-index-strict-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const indexPath = path.join(temporaryRoot, 'index.json');
  await writeFile(indexPath, JSON.stringify({ version: '0', generated_at: generatedAt, missions: [], extra: true }));
  await assert.rejects(renderLedger({ indexPath, out: path.join(temporaryRoot, 'site/index.html'), now: generatedAt }), /extra|allowed|index/i);
});

test('ledger build is strict by default and allow-skips is an explicit diagnostic mode', async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-build-strict-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const missions = path.join(temporaryRoot, 'missions');
  await cp(path.join(root, 'test/fixtures/ledger/missions'), missions, { recursive: true });
  await unlink(path.join(missions, 'alpha/publication.json'));
  await assert.rejects(
    buildLedger({ missionsDir: missions, out: path.join(temporaryRoot, 'strict.json'), now: generatedAt }),
    /publication\.json is required/,
  );
  const diagnostic = await buildLedger({
    missionsDir: missions,
    out: path.join(temporaryRoot, 'diagnostic.json'),
    now: generatedAt,
    allowSkips: true,
  });
  assert.ok(diagnostic.skipped >= 2);

  const emptyMissions = path.join(temporaryRoot, 'empty-missions');
  await cp(path.join(root, 'test/fixtures/ledger/missions/alpha'), path.join(emptyMissions, 'M-007'), { recursive: true });
  await unlink(path.join(emptyMissions, 'M-007/mission.json'));
  await assert.rejects(
    buildLedger({ missionsDir: emptyMissions, out: path.join(temporaryRoot, 'missing-mission.json'), now: generatedAt }),
    /mission\.json is required/i,
  );
});

test('public JSON schemas commit the fail-closed consent and correction contract', async () => {
  const publicSchemas = [
    'publication.schema.json',
    'ledger.schema.json',
    'public-receipt.schema.json',
    'run-record.schema.json',
    'economic-identity.schema.json',
    'approval.schema.json',
    'consent-scopes.schema.json',
  ];
  for (const name of publicSchemas) {
    const schema = JSON.parse(await readFile(path.join(root, 'schema', name), 'utf8'));
    if (name === 'economic-identity.schema.json') {
      assert.deepEqual(schema.oneOf, [
        {$ref: '#/$defs/sourceEconomicIdentity'},
        {$ref: '#/$defs/publicEconomicIdentity'},
      ], name);
      assert.equal(schema.$defs.publicEconomicIdentity.additionalProperties, false, name);
      assert.equal(schema.$defs.sourceEconomicIdentity.additionalProperties, false, name);
    } else if (name === 'approval.schema.json') assert.equal(schema.$defs.approval.additionalProperties, false, name);
    else assert.equal(schema.additionalProperties, false, name);
  }
  const publicationSchema = JSON.parse(await readFile(path.join(root, 'schema/publication.schema.json'), 'utf8'));
  assert.deepEqual([...publicationSchema.required].sort(), publicationFields);
  assert.deepEqual(publicationSchema.properties.schema_version.enum, [1, 2]);
  assert.deepEqual(publicationSchema.properties.listing.enum, ['listed', 'correction_only', 'private_internal']);
  assert.deepEqual(publicationSchema.allOf[0].then.required, ['listing', 'correction']);
  assert.equal(publicationSchema.properties.pr_disclosure.$ref, '#/$defs/prDisclosure');

  const consentSchema = JSON.parse(await readFile(path.join(root, 'schema/consent-scopes.schema.json'), 'utf8'));
  assert.deepEqual(consentSchema.required, ['schema_version', 'mission_id', 'scopes']);
  assert.deepEqual(
    consentSchema.properties.scopes.required,
    [
      'contribution_invitation',
      'verification_execution_consent',
      'receipt_publication_consent',
      'marketing_reference_consent',
    ],
  );

  const receiptSchema = JSON.parse(await readFile(path.join(root, 'schema/public-receipt.schema.json'), 'utf8'));
  assert.ok(receiptSchema.required.includes('consent_scopes'));
  assert.ok(receiptSchema.required.includes('evidence_classification'));
  assert.equal(receiptSchema.properties.upstream_outcome, undefined);
  assert.equal(receiptSchema.properties.links.properties.publication_pr, undefined);

  const ledgerSchema = JSON.parse(await readFile(path.join(root, 'schema/ledger.schema.json'), 'utf8'));
  const ledger = JSON.parse(await readFile(path.join(root, 'site/ledger.json'), 'utf8'));
  assert.deepEqual(Object.keys(ledger).sort(), [...ledgerSchema.required].sort());
  for (const name of publicSchemas) {
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, 'site/schema', name), 'utf8')),
      JSON.parse(await readFile(path.join(root, 'schema', name), 'utf8')),
      `${name} must be published with the Pages site`,
    );
  }
});
