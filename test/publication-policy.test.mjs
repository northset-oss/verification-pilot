import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  absentConsentScopes,
  consentScopesFromLegacy,
  marketingReferenceGranted,
  publicListingFor,
  receiptPublicationGranted,
  validateConsentScopes,
  validateRenderedPublication,
  verifyDeploymentManifest,
  writeDeploymentManifest,
} from '../lib/publication-policy.mjs';

const missionId = 'M-900';

function grantedScope() {
  return {
    status: 'granted',
    evidence: {kind: 'public_url', value: 'https://example.test/consent'},
    granted_at: '2026-07-23T20:00:00Z',
    granted_by: 'repository owner',
  };
}

function consent(scopes = {}) {
  return {
    schema_version: 2,
    mission_id: missionId,
    scopes: {
      contribution_invitation: {status: 'absent', evidence: null, granted_at: null, granted_by: null},
      verification_execution_consent: {status: 'absent', evidence: null, granted_at: null, granted_by: null},
      receipt_publication_consent: {status: 'absent', evidence: null, granted_at: null, granted_by: null},
      marketing_reference_consent: {status: 'absent', evidence: null, granted_at: null, granted_by: null},
      ...scopes,
    },
  };
}

async function renderedFixture(contents = '<!doctype html><title>technical record</title>') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-publication-policy-'));
  await mkdir(path.join(root, 'receipts'), {recursive: true});
  await writeFile(path.join(root, 'index.html'), contents);
  return root;
}

test('fixture 1: all four independent consent scopes are required', () => {
  const value = consent();
  delete value.scopes.marketing_reference_consent;
  assert.throws(() => validateConsentScopes(value, missionId), /missing or extra field/);
});

test('fixture 2: absent receipt-publication consent fails closed', () => {
  const value = absentConsentScopes(missionId);
  assert.equal(receiptPublicationGranted(value), false);
  assert.equal(publicListingFor({publication: null, consent: value}), 'private_internal');
});

test('fixture 3: legacy consent is honored only when publication consent is explicit', () => {
  const legacy = {
    schema_version: 1,
    mission_id: missionId,
    variant: 'V',
    consent_artifact: 'https://example.test/consent',
    granted_at: '2026-07-23T20:00:00Z',
    granted_by: 'repository owner',
    publication_consent: true,
    scope: ['publish receipt'],
  };
  assert.equal(receiptPublicationGranted(consentScopesFromLegacy(legacy, missionId)), true);
  assert.throws(
    () => consentScopesFromLegacy({...legacy, publication_consent: false}, missionId),
    /legacy public consent is invalid/,
  );
});

test('fixture 4: public listing without publication consent is rejected', async () => {
  const siteRoot = await renderedFixture();
  const index = {missions: [{receipt: {
    mission_id: missionId,
    public_listing: 'listed',
    consent_scopes: absentConsentScopes(missionId),
  }}]};
  await assert.rejects(validateRenderedPublication({siteRoot, index}), /listed without receipt publication consent/);
});

test('correction-only listing is a singular M-012 incident exception', async () => {
  assert.throws(
    () => publicListingFor({
      publication: {schema_version: 2, mission_id: 'M-999', listing: 'correction_only'},
      consent: absentConsentScopes('M-999'),
    }),
    /reserved for the M-012 incident correction/,
  );
  const siteRoot = await renderedFixture();
  await assert.rejects(
    validateRenderedPublication({siteRoot, index: {missions: [{receipt: {
      mission_id: 'M-999',
      public_listing: 'correction_only',
      publication: {correction: {}},
      consent_scopes: absentConsentScopes('M-999'),
    }}]}}),
    /correction-only listing is reserved for M-012/,
  );
});

test('fixture 5: marketing consent is independent from receipt-publication consent', () => {
  const value = validateConsentScopes(consent({
    receipt_publication_consent: grantedScope(),
  }), missionId);
  assert.equal(receiptPublicationGranted(value), true);
  assert.equal(marketingReferenceGranted(value), false);
});

test('fixture 6: active acquisition surfaces are rejected', async () => {
  const cases = [
    ['<a href="mailto:oss@example.test">request a run</a>', /contains acquisition email/],
    ['<!-- hidden acquisition claim -->', /HTML comment canary/],
    ['safe\u202etext', /bidirectional text control/],
    ['safe\u200btext', /zero-width text control/],
  ];
  for (const [contents, expected] of cases) {
    const siteRoot = await renderedFixture(contents);
    await assert.rejects(
      validateRenderedPublication({siteRoot, index: {missions: []}}),
      expected,
    );
  }
});

test('fixture 7: repository aggregates and mutable status fields are rejected', async () => {
  const cases = [
    ['<a href="/repo/owner--project/">project</a><p>PR state: open</p>', /repository aggregate.*mutable PR state|mutable PR state.*repository aggregate/],
    ['Maintainers agreed with this record.', /endorsement implication \(agreed\)/],
    ['The project disagreed with this record.', /endorsement implication \(disagreed\)/],
    ['This evidence was validated upstream.', /endorsement implication \(validated\)/],
    ['The repository endorsed the work.', /endorsement implication \(endorsed\)/],
    ['The maintainer ratified the result.', /endorsement implication \(ratified\)/],
    ['The change was approved.', /endorsement implication \(approved\)/],
    ['This record has maintainer approval.', /endorsement implication \(approval\)/],
    ['The project confirmed the result.', /endorsement implication \(confirmed\)/],
    ['The maintainer certified the result.', /endorsement implication \(certified\)/],
    ['The reviewers signed off on the result.', /endorsement implication \(signed off\)/],
  ];
  for (const [contents, expected] of cases) {
    const siteRoot = await renderedFixture(contents);
    await assert.rejects(
      validateRenderedPublication({siteRoot, index: {missions: []}}),
      expected,
    );
  }
});

test('fixture 8: exact stale M-012 public facts are rejected', async () => {
  const siteRoot = await renderedFixture();
  const index = {missions: [{receipt: {
    mission_id: 'M-012',
    public_listing: 'listed',
    evidence_classification: 'LEGACY_SELF_RUN_RECORD',
    consent_scopes: absentConsentScopes('M-012'),
    publication: {
      schema_version: 1,
      state: 'open',
      pr_head_oid: '4c8e448d249ffd4a70e57a73c1be441e3824cf0e',
      ci_state: 'success',
      review_decision: 'changes_requested',
      decision_url: 'https://github.com/nodejs/doc-kit/pull/901#pullrequestreview-4683515567',
      closed_at: null,
      updated_at: '2026-07-19T21:46:36Z',
    },
  }}]};
  await assert.rejects(
    validateRenderedPublication({siteRoot, index}),
    /M-012: exact incident correction invariant is not satisfied/,
  );
});

test('fixture 9: exact M-012 correction-only projection passes', async () => {
  const rendered = '<h1>Correction — July 23, 2026</h1>';
  const siteRoot = await renderedFixture(rendered);
  await mkdir(path.join(siteRoot, 'receipts/M-012'), {recursive: true});
  await writeFile(path.join(siteRoot, 'receipts/M-012/index.html'), rendered);
  const replacementRenderedSha256 =
    `sha256:${createHash('sha256').update(rendered).digest('hex')}`;
  const index = {missions: [{receipt: {
    mission_id: 'M-012',
    public_listing: 'correction_only',
    evidence_classification: 'LEGACY_SELF_RUN_RECORD',
    consent_scopes: absentConsentScopes('M-012'),
    publication: {
      schema_version: 2,
      state: 'closed_unmerged',
      pr_number: 901,
      pr_url: 'https://github.com/nodejs/doc-kit/pull/901',
      pr_head_oid: '4c8e448d249ffd4a70e57a73c1be441e3824cf0e',
      base_branch: 'main',
      head_drift: true,
      ci_state: null,
      merge_commit_oid: null,
      review_decision: 'changes_requested',
      decision_url: 'https://github.com/nodejs/doc-kit/pull/901#pullrequestreview-4767280794',
      opened_at: '2026-07-12T22:22:09Z',
      closed_at: '2026-07-23T19:02:03Z',
      updated_at: '2026-07-23T19:02:11Z',
      correction_note: 'Correction — July 23, 2026\nPR #901 was closed unmerged after a maintainer objected to Northset’s use of the project and its review process in a product demonstration. M-012 remains only an immutable record of the original `a0bdd2d…` patch and the single listed command. Earlier rendered status showing the PR as open, and language describing upstream CI as agreeing with M-012, were inaccurate and have been withdrawn. The later PR head was not executed by M-012.',
      attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-012/run-record-M-012.tar.gz',
      release_asset_sha256: 'sha256:653a46b74e428acb75738ae1e7b8a1b2b66cb36933087927538a971032561cdf',
      correction: {
        source_url: 'https://github.com/nodejs/doc-kit/pull/901#pullrequestreview-4767280794',
        prior_rendered_sha256: 'sha256:a8a4c6dae8a1c22da658d1212ce74a25793af9edf05d48c6b3b4c1a18baf3cb2',
        prior_rendered_bytes: 84797,
        replacement_rendered_sha256: replacementRenderedSha256,
      },
    },
    code: {
      patch_diff_hash: 'sha256:524fa5413c71090d9b4d4ad8dfd20f877f163551943875f83db2fbde9903beb3',
    },
    bundle_digest: 'sha256:2c6b24a0e00782c386b6faf42945791584006b7e510c63b337acec7d621ef891',
    verify_command: 'gh attestation verify run-record-M-012.tar.gz --repo northset-oss/verification-pilot --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml',
  }}]};
  assert.deepEqual(await validateRenderedPublication({siteRoot, index}), {files: 2});
  await writeFile(path.join(siteRoot, 'receipts/M-012/index.html'), `${rendered}\n`);
  await assert.rejects(
    validateRenderedPublication({siteRoot, index}),
    /replacement_rendered_sha256 does not match rendered index\.html bytes/,
  );
});

test('deployment manifest rejects rendered source drift', async () => {
  const siteRoot = await renderedFixture();
  await writeDeploymentManifest({
    siteRoot,
    ledgerSourceOid: 'a'.repeat(40),
    receiptsSourceOid: 'b'.repeat(40),
    mergedIndexSha256: `sha256:${'c'.repeat(64)}`,
  });
  await verifyDeploymentManifest({siteRoot});

  await writeFile(path.join(siteRoot, 'index.html'), '<!doctype html><title>drifted bytes</title>');

  await assert.rejects(
    verifyDeploymentManifest({siteRoot}),
    /deployment manifest does not match rendered source bytes/,
  );
});
