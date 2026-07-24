import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CONSENT_SCOPE_NAMES = Object.freeze([
  'contribution_invitation',
  'verification_execution_consent',
  'receipt_publication_consent',
  'marketing_reference_consent',
]);

const CONSENT_STATUSES = new Set(['granted', 'absent', 'not_applicable']);
const PUBLIC_LISTINGS = new Set(['listed', 'correction_only', 'private_internal']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const M012_WITHDRAWN_AGREEMENT_SENTENCE = 'Earlier rendered status showing the PR as open, and language describing upstream CI as agreeing with M-012, were inaccurate and have been withdrawn.';
const M012_CORRECTION_TEXT = 'Correction — July 23, 2026\nPR #901 was closed unmerged after a maintainer objected to Northset’s use of the project and its review process in a product demonstration. M-012 remains only an immutable record of the original `a0bdd2d…` patch and the single listed command. Earlier rendered status showing the PR as open, and language describing upstream CI as agreeing with M-012, were inaccurate and have been withdrawn. The later PR head was not executed by M-012.';

function requiredObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactFields(value, fields, label) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new TypeError(`${label} contains a missing or extra field`);
  }
}

function validTime(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 time`);
  }
  return value;
}

function normalizeEvidence(value, label) {
  if (value === null) return null;
  requiredObject(value, label);
  exactFields(value, ['kind', 'value'], label);
  if (!['public_url', 'private_digest'].includes(value.kind)) {
    throw new TypeError(`${label}.kind must be public_url or private_digest`);
  }
  if (typeof value.value !== 'string' || value.value.length === 0) {
    throw new TypeError(`${label}.value must be a non-blank string`);
  }
  if (value.kind === 'public_url') {
    const parsed = new URL(value.value);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new TypeError(`${label}.value must be an HTTP(S) URL`);
    }
  } else if (!SHA256_PATTERN.test(value.value)) {
    throw new TypeError(`${label}.value must be a SHA-256 digest`);
  }
  return {...value};
}

function normalizeScope(value, label) {
  requiredObject(value, label);
  exactFields(value, ['status', 'evidence', 'granted_at', 'granted_by'], label);
  if (!CONSENT_STATUSES.has(value.status)) {
    throw new TypeError(`${label}.status is invalid`);
  }
  const evidence = normalizeEvidence(value.evidence, `${label}.evidence`);
  if (value.status === 'granted') {
    if (evidence === null) throw new TypeError(`${label}.evidence is required when granted`);
    validTime(value.granted_at, `${label}.granted_at`);
    if (typeof value.granted_by !== 'string' || value.granted_by.trim().length === 0) {
      throw new TypeError(`${label}.granted_by is required when granted`);
    }
  } else if (evidence !== null || value.granted_at !== null || value.granted_by !== null) {
    throw new TypeError(`${label} evidence fields must be null unless granted`);
  }
  return {
    status: value.status,
    evidence,
    granted_at: value.granted_at,
    granted_by: value.granted_by,
  };
}

export function validateConsentScopes(value, missionId) {
  requiredObject(value, 'consent scopes');
  exactFields(value, ['schema_version', 'mission_id', 'scopes'], 'consent scopes');
  if (value.schema_version !== 2 || value.mission_id !== missionId) {
    throw new TypeError('consent scopes schema_version or mission_id is invalid');
  }
  requiredObject(value.scopes, 'consent scopes.scopes');
  exactFields(value.scopes, CONSENT_SCOPE_NAMES, 'consent scopes.scopes');
  return {
    schema_version: 2,
    mission_id: missionId,
    scopes: Object.fromEntries(CONSENT_SCOPE_NAMES.map((name) => [
      name,
      normalizeScope(value.scopes[name], `consent scopes.scopes.${name}`),
    ])),
  };
}

function emptyScope(status = 'absent') {
  return {status, evidence: null, granted_at: null, granted_by: null};
}

export function absentConsentScopes(missionId) {
  return {
    schema_version: 2,
    mission_id: missionId,
    scopes: Object.fromEntries(CONSENT_SCOPE_NAMES.map((name) => [name, emptyScope()])),
  };
}

export function consentScopesFromLegacy(value, missionId) {
  requiredObject(value, 'legacy public consent');
  if (
    value.schema_version !== 1
    || value.mission_id !== missionId
    || value.publication_consent !== true
    || typeof value.consent_artifact !== 'string'
    || typeof value.granted_at !== 'string'
    || typeof value.granted_by !== 'string'
  ) {
    throw new TypeError('legacy public consent is invalid');
  }
  const evidence = {kind: 'public_url', value: value.consent_artifact};
  const granted = {
    status: 'granted',
    evidence,
    granted_at: validTime(value.granted_at, 'legacy public consent.granted_at'),
    granted_by: value.granted_by,
  };
  return {
    schema_version: 2,
    mission_id: missionId,
    scopes: {
      contribution_invitation: emptyScope('not_applicable'),
      verification_execution_consent: {...granted},
      receipt_publication_consent: {...granted},
      marketing_reference_consent: emptyScope(),
    },
  };
}

export function receiptPublicationGranted(consent) {
  return consent?.scopes?.receipt_publication_consent?.status === 'granted';
}

export function marketingReferenceGranted(consent) {
  return consent?.scopes?.marketing_reference_consent?.status === 'granted';
}

export function validateListing(value, label = 'listing') {
  if (!PUBLIC_LISTINGS.has(value)) {
    throw new TypeError(`${label} must be listed, correction_only, or private_internal`);
  }
  return value;
}

export function publicListingFor({publication, consent}) {
  const requested = publication?.listing ?? null;
  if (requested === 'correction_only') {
    if (publication?.mission_id !== 'M-012' || publication?.schema_version !== 2) {
      throw new TypeError('correction_only is reserved for the M-012 incident correction');
    }
    return 'correction_only';
  }
  if (requested === 'private_internal') return 'private_internal';
  return receiptPublicationGranted(consent) ? 'listed' : 'private_internal';
}

function sha256(contents) {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

async function filesBelow(root, current = root) {
  const entries = await readdir(current, {withFileTypes: true});
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, file));
    else if (entry.isFile()) files.push(path.relative(root, file).split(path.sep).join('/'));
  }
  return files;
}

const FORBIDDEN_PUBLIC_PATTERNS = [
  ['acquisition email', /mailto:/i],
  ['run request template', /request-a-run\.yml/i],
  ['comment trigger', /northset-verify/i],
  ['repository aggregate', /(?:href|src)=["'](?:\/|(?:\.\.\/)*)repo\//i],
  ['mutable PR state', /\bPR state:/i],
  ['mutable review signal', /\bReview signal:/i],
  ['mutable CI state', /\bCI state:/i],
  ['HTML comment canary', /<!--/],
  ['bidirectional text control', /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u],
  ['zero-width text control', /[\u200b-\u200d\u2060\ufeff]/u],
];
const ENDORSEMENT_TERM = /\b(?:agree(?:d|ing)|disagree(?:d|ing)|validated|endorsed|ratified|approved|approval|confirmed|certified|signed\s+off)\b/gi;

function positiveEndorsementClaim(source) {
  const claimBearingSource = source.replaceAll(M012_WITHDRAWN_AGREEMENT_SENTENCE, '');
  for (const match of claimBearingSource.matchAll(ENDORSEMENT_TERM)) {
    const precedingClause = claimBearingSource.slice(Math.max(0, match.index - 120), match.index);
    const followingClause = claimBearingSource.slice(
      match.index + match[0].length,
      match.index + match[0].length + 40,
    );
    if (
      match[0].toLowerCase() === 'approved'
      && /\boutside the\s*$/i.test(precedingClause)
      && /^\s+verification scope\b/i.test(followingClause)
    ) {
      continue;
    }
    if (
      match[0].toLowerCase() === 'approval'
      && /\bnamed approver and\s*$/i.test(precedingClause)
      && /^\s+time\b/i.test(followingClause)
    ) {
      continue;
    }
    if (!/\b(?:not|no|never|without)\b[^.!?]{0,100}$/i.test(precedingClause)) {
      return match[0];
    }
  }
  return null;
}

function jsonStringValues(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(jsonStringValues);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(jsonStringValues);
  }
  return [];
}

export async function validateRenderedPublication({siteRoot, index}) {
  if (!Array.isArray(index?.missions)) throw new TypeError('index.missions is required');
  const failures = [];
  for (const mission of index.missions) {
    const receipt = mission?.receipt;
    if (receipt?.public_listing === 'listed' && !receiptPublicationGranted(receipt.consent_scopes)) {
      failures.push(`${receipt.mission_id}: listed without receipt publication consent`);
    }
    if (
      receipt?.marketing_reference === true
      && !marketingReferenceGranted(receipt.consent_scopes)
    ) {
      failures.push(`${receipt.mission_id}: marketing reference lacks independent consent`);
    }
    if (receipt?.public_listing === 'correction_only' && receipt?.publication?.correction === undefined) {
      failures.push(`${receipt.mission_id}: correction-only listing lacks a correction record`);
    }
    if (receipt?.public_listing === 'correction_only' && receipt?.mission_id !== 'M-012') {
      failures.push(`${receipt.mission_id}: correction-only listing is reserved for M-012`);
    }
    if (receipt?.mission_id === 'M-012') {
      const publication = receipt.publication;
      const exactM012 = (
        receipt.public_listing === 'correction_only'
        && receipt.evidence_classification === 'LEGACY_SELF_RUN_RECORD'
        && publication?.schema_version === 2
        && publication.state === 'closed_unmerged'
        && publication.pr_number === 901
        && publication.pr_url === 'https://github.com/nodejs/doc-kit/pull/901'
        && publication.pr_head_oid === '4c8e448d249ffd4a70e57a73c1be441e3824cf0e'
        && publication.base_branch === 'main'
        && publication.head_drift === true
        && publication.ci_state === null
        && publication.merge_commit_oid === null
        && publication.review_decision === 'changes_requested'
        && publication.decision_url === 'https://github.com/nodejs/doc-kit/pull/901#pullrequestreview-4767280794'
        && publication.opened_at === '2026-07-12T22:22:09Z'
        && publication.closed_at === '2026-07-23T19:02:03Z'
        && publication.updated_at === '2026-07-23T19:02:11Z'
        && publication.correction_note === M012_CORRECTION_TEXT
        && publication.attestation_uri === 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-012/run-record-M-012.tar.gz'
        && publication.release_asset_sha256 === 'sha256:653a46b74e428acb75738ae1e7b8a1b2b66cb36933087927538a971032561cdf'
        && publication.correction?.source_url === 'https://github.com/nodejs/doc-kit/pull/901#pullrequestreview-4767280794'
        && publication.correction?.prior_rendered_sha256 === 'sha256:a8a4c6dae8a1c22da658d1212ce74a25793af9edf05d48c6b3b4c1a18baf3cb2'
        && publication.correction?.prior_rendered_bytes === 84797
        && receipt.code?.patch_diff_hash === 'sha256:524fa5413c71090d9b4d4ad8dfd20f877f163551943875f83db2fbde9903beb3'
        && receipt.bundle_digest === 'sha256:2c6b24a0e00782c386b6faf42945791584006b7e510c63b337acec7d621ef891'
        && receipt.verify_command === 'gh attestation verify run-record-M-012.tar.gz --repo northset-oss/verification-pilot --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml'
      );
      if (!exactM012) failures.push('M-012: exact incident correction invariant is not satisfied');
    }
  }
  const files = await filesBelow(siteRoot);
  if (files.some((file) => file === 'repo' || file.startsWith('repo/'))) {
    failures.push('generated repository pages are prohibited');
  }
  for (const relative of files.filter((file) => /\.(?:html|json|svg|xml|txt)$/i.test(file))) {
    const source = await readFile(path.join(siteRoot, relative), 'utf8');
    for (const [label, pattern] of FORBIDDEN_PUBLIC_PATTERNS) {
      if (pattern.test(source)) failures.push(`${relative}: contains ${label}`);
    }
    const claimValues = relative.startsWith('schema/')
      ? []
      : relative.endsWith('.json')
        ? jsonStringValues(JSON.parse(source))
        : [source];
    for (const claimValue of claimValues) {
      const endorsement = positiveEndorsementClaim(claimValue);
      if (endorsement !== null) {
        failures.push(`${relative}: contains endorsement implication (${endorsement})`);
        break;
      }
    }
  }
  const m012 = index.missions
    .map((mission) => mission?.receipt)
    .find((receipt) => receipt?.mission_id === 'M-012' && receipt.public_listing === 'correction_only');
  if (m012 !== undefined) {
    let rendered;
    try {
      rendered = await readFile(path.join(siteRoot, 'receipts', 'M-012', 'index.html'));
    } catch {
      failures.push('M-012: correction-only rendered page is missing');
    }
    if (
      rendered !== undefined
      && sha256(rendered) !== m012.publication?.correction?.replacement_rendered_sha256
    ) {
      failures.push('M-012: replacement_rendered_sha256 does not match rendered index.html bytes');
    }
  }
  if (failures.length > 0) {
    throw new TypeError(`public publication validation failed: ${failures.join('; ')}`);
  }
  return {files: files.length};
}

export async function createDeploymentManifest({
  siteRoot,
  ledgerSourceOid,
  receiptsSourceOid,
  mergedIndexSha256,
}) {
  for (const [label, value] of Object.entries({ledgerSourceOid, receiptsSourceOid})) {
    if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
      throw new TypeError(`${label} must be a full commit OID`);
    }
  }
  if (!SHA256_PATTERN.test(mergedIndexSha256)) {
    throw new TypeError('mergedIndexSha256 must be a SHA-256 digest');
  }
  const paths = (await filesBelow(siteRoot)).filter((file) => file !== 'deployment-manifest.json');
  const files = [];
  for (const relative of paths) {
    const absolute = path.join(siteRoot, relative);
    const contents = await readFile(absolute);
    const details = await stat(absolute);
    files.push({path: relative, bytes: details.size, sha256: sha256(contents)});
  }
  const manifest = {
    schema_version: 1,
    ledger_source_oid: ledgerSourceOid,
    receipts_source_oid: receiptsSourceOid,
    merged_index_sha256: mergedIndexSha256,
    files,
  };
  manifest.manifest_sha256 = sha256(JSON.stringify(manifest));
  return manifest;
}

export async function writeDeploymentManifest(options) {
  const manifest = await createDeploymentManifest(options);
  await writeFile(
    path.join(options.siteRoot, 'deployment-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

export async function verifyDeploymentManifest({siteRoot}) {
  const file = path.join(siteRoot, 'deployment-manifest.json');
  const recorded = JSON.parse(await readFile(file, 'utf8'));
  const regenerated = await createDeploymentManifest({
    siteRoot,
    ledgerSourceOid: recorded.ledger_source_oid,
    receiptsSourceOid: recorded.receipts_source_oid,
    mergedIndexSha256: recorded.merged_index_sha256,
  });
  if (JSON.stringify(regenerated) !== JSON.stringify(recorded)) {
    throw new TypeError('deployment manifest does not match rendered source bytes');
  }
  return recorded;
}

export async function verifyPublishedDeployment({siteRoot, baseUrl, fetchImpl = globalThis.fetch}) {
  const local = await verifyDeploymentManifest({siteRoot});
  const base = new URL(baseUrl);
  const cacheKey = local.manifest_sha256.slice('sha256:'.length);
  const fetchBytes = async (relative) => {
    const url = new URL(relative, base);
    url.searchParams.set('source', cacheKey);
    const response = await fetchImpl(url);
    if (!response.ok) throw new TypeError(`${relative} returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const remoteManifestBytes = await fetchBytes('deployment-manifest.json');
  const remote = JSON.parse(remoteManifestBytes.toString('utf8'));
  if (JSON.stringify(remote) !== JSON.stringify(local)) {
    throw new TypeError('deployed manifest does not match the source manifest');
  }
  for (const file of local.files) {
    const bytes = await fetchBytes(file.path);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new TypeError(`deployed bytes do not match source manifest: ${file.path}`);
    }
  }
  return {files: local.files.length, manifest_sha256: local.manifest_sha256};
}
