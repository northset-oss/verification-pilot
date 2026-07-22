import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateMission } from './mission-validator.mjs';
import { assertProofOfPass } from './proof-of-pass.mjs';
import { createReceiptQr } from './receipt-qr.mjs';
import { assertReceiptParity } from './receipt-parity.mjs';
import {
  projectEconomicIdentity,
  validateApprovalRecord,
  validateEconomicIdentity,
} from './economic-identity.mjs';

const PROJECTION_FIELDS = [
  'mission_id',
  'variant',
  'claims_tier',
  'grade',
  'target_repo',
  'issue_or_task',
  'consent_artifact',
  'maintainer_outcome',
  'run_record_bundle_digest',
  'attestation_uri',
  'disclosure_label',
];
const PUBLICATION_STATES = new Set(['prepared', 'open', 'closed_unmerged', 'merged']);
const REVIEW_DECISIONS = new Set(['approved', 'changes_requested', 'review_required']);
const CI_STATES = new Set(['success', 'failure', 'pending', 'cancelled', 'skipped']);
const PUBLICATION_REQUIRED_FIELDS = new Set([
  'schema_version', 'mission_id', 'state', 'pr_number', 'pr_url', 'pr_head_oid',
  'base_branch', 'head_drift', 'ci_state', 'merge_commit_oid', 'review_decision',
  'decision_url', 'opened_at', 'closed_at', 'updated_at', 'observed_at',
  'correction_note', 'scope_note', 'attestation_uri', 'bundle_digest',
  'release_asset_sha256', 'attestation_verified_at',
]);
const PUBLICATION_FIELDS = new Set([...PUBLICATION_REQUIRED_FIELDS, 'pr_disclosure']);
const PR_DISCLOSURE_FIELDS = new Set([
  'schema_version', 'required', 'mode', 'canonical_url', 'verified_at',
]);
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OID_PATTERN = /^[0-9a-f]{40}$/;
const RECEIPT_BASE_URL = 'https://northset-oss.github.io/verification-pilot/receipts';
const SITE_BASE_URL = new URL('../', `${RECEIPT_BASE_URL}/`).href;
const VERIFY_WORKFLOW = 'northset-oss/verification-pilot/.github/workflows/attest-bundle.yml';
const ATTESTATION_URI_PREFIX = 'https://github.com/northset-oss/verification-pilot/releases/download/';
const PUBLIC_RUN_REQUEST_URL = 'https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml';
const DISCREPANCY_REPORT_URL = 'https://github.com/northset-oss/verification-pilot/issues/new?template=report-a-discrepancy.yml';
const RUN_REQUEST_EMAIL = 'oss@northset.ai';
const SAMPLE_PRIVATE_CHECK_RECEIPT_URL = `${RECEIPT_BASE_URL}/M-004/`;
const GENERATED_RECEIPT_PATTERN = /^M-(?:\d{3,}|E2[a-c])$/;
const GENERATED_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+--[A-Za-z0-9_.-]+$/;
const GENERATED_REPOSITORY_MARKER = 'northset-ledger-repository-page\n';
const CONSENT_VARIANTS = new Set(['V', 'W', 'F']);
const PUBLIC_SCHEMA_FILES = [
  'ledger.schema.json',
  'public-consent.schema.json',
  'public-receipt.schema.json',
  'publication.schema.json',
  'run-record.schema.json',
  'economic-identity.schema.json',
  'approval.schema.json',
];

function compareMissionIds(left, right) {
  return left.mission_id.localeCompare(right.mission_id);
}

function projectMission(mission) {
  const entry = {};
  for (const field of PROJECTION_FIELDS) {
    if (field === 'maintainer_outcome') {
      entry.maintainer_outcome = {
        status: mission.maintainer_outcome.status,
        link: mission.maintainer_outcome.link,
      };
    } else if (Object.hasOwn(mission, field)) {
      entry[field] = mission[field];
    }
  }
  entry.attested = typeof mission.attestation_uri === 'string';
  entry.publication = null;
  return entry;
}

function requiredString(value, sourcePath) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${sourcePath} must be a non-blank string`);
  }
  return value;
}

function requiredObject(value, sourcePath) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${sourcePath} must be an object`);
  }
  return value;
}

function requiredArray(value, sourcePath) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${sourcePath} must be a non-empty array`);
  }
  return value;
}

function validTime(value, sourcePath) {
  requiredString(value, sourcePath);
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (match === null) throw new TypeError(`${sourcePath} must be an ISO-8601 time`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 60
    || (offsetHourText !== undefined && Number(offsetHourText) > 23)
    || (offsetMinuteText !== undefined && Number(offsetMinuteText) > 59)
  ) {
    throw new TypeError(`${sourcePath} must be an ISO-8601 time`);
  }
  return value;
}

function validUrl(value, sourcePath) {
  if (value === null || value === undefined) return null;
  requiredString(value, sourcePath);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${sourcePath} must be an absolute HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`${sourcePath} must be an absolute HTTP(S) URL`);
  }
  return value;
}

function optionalString(value, sourcePath) {
  if (value === null || value === undefined) return null;
  return requiredString(value, sourcePath);
}

function optionalPositiveInteger(value, sourcePath) {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${sourcePath} must be a positive integer`);
  }
  return value;
}

function optionalStringArray(value, sourcePath, {required = false} = {}) {
  if (value === null || value === undefined) {
    if (required) throw new TypeError(`${sourcePath} must be an array`);
    return [];
  }
  if (!Array.isArray(value)) throw new TypeError(`${sourcePath} must be an array`);
  return value.map((item, index) => requiredString(item, `${sourcePath}[${index}]`));
}

function duration(value, sourcePath) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${sourcePath} must be a non-negative integer number of milliseconds`);
  }
  return value;
}

function attestationAsset(value, missionId, sourcePath) {
  const uri = validUrl(value, sourcePath);
  if (uri === null) return null;
  const parsed = new URL(uri);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const expectedTag = `run-record-${missionId}`;
  const tag = segments[4];
  const suffix = tag?.slice(expectedTag.length + 1);
  const tagMatches = tag === expectedTag
    || (tag?.startsWith(`${expectedTag}-`) === true && /^[0-9a-f]{12}$/i.test(suffix));
  if (
    parsed.origin !== 'https://github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || segments.length !== 6
    || segments[0] !== 'northset-oss'
    || segments[1] !== 'verification-pilot'
    || segments[2] !== 'releases'
    || segments[3] !== 'download'
    || !tagMatches
    || segments[5] !== `${tag}.tar.gz`
  ) {
    throw new TypeError(`${sourcePath} must identify the ${missionId} release asset in the signing repository`);
  }
  return uri;
}

function requireAgreement(values, label) {
  const recorded = values.filter((value) => value !== null && value !== undefined);
  if (new Set(recorded).size > 1) throw new TypeError(`${label} values disagree across committed sources`);
  return recorded[0] ?? null;
}

function formatValidationErrors(errors) {
  return errors
    .map((error) => `${error.ruleId} ${error.path}: ${error.message}`)
    .join('; ')
    .replaceAll(/\s+/g, ' ');
}

async function readJson(file, sourcePath) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new TypeError(`${sourcePath}: ${error.message}`);
  }
}

async function readJsonIfPresent(file, sourcePath) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new TypeError(`${sourcePath}: ${error.message}`);
  }
}

async function readTextIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeOutput(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

export function validatePublication(value, missionId) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('publication must be an object');
  }
  for (const field of PUBLICATION_REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`publication ${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!PUBLICATION_FIELDS.has(field)) throw new TypeError(`publication ${field} is not an allowed field`);
  }
  if (value.schema_version !== 1 || value.mission_id !== missionId) {
    throw new TypeError('publication schema_version or mission_id is invalid');
  }
  if (Object.hasOwn(value, 'pr_disclosure')) {
    const disclosure = value.pr_disclosure;
    requiredObject(disclosure, 'publication pr_disclosure');
    for (const field of PR_DISCLOSURE_FIELDS) {
      if (!Object.hasOwn(disclosure, field)) {
        throw new TypeError(`publication pr_disclosure.${field} is required`);
      }
    }
    for (const field of Object.keys(disclosure)) {
      if (!PR_DISCLOSURE_FIELDS.has(field)) {
        throw new TypeError(`publication pr_disclosure.${field} is not allowed`);
      }
    }
    if (![1, 2].includes(disclosure.schema_version)) {
      throw new TypeError('publication pr_disclosure.schema_version must equal 1 or 2');
    }
    if (disclosure.required !== true) {
      throw new TypeError('publication pr_disclosure.required must be true');
    }
    if (disclosure.mode !== 'pr_body') {
      throw new TypeError('publication pr_disclosure.mode must equal pr_body');
    }
    const expectedReceiptUrl = `${RECEIPT_BASE_URL}/${missionId}/`;
    if (disclosure.canonical_url !== expectedReceiptUrl) {
      throw new TypeError(`publication pr_disclosure.canonical_url must equal ${expectedReceiptUrl}`);
    }
    validTime(disclosure.verified_at, 'publication pr_disclosure.verified_at');
    if (
      typeof value.opened_at === 'string'
      && Date.parse(disclosure.verified_at) < Date.parse(value.opened_at)
    ) {
      throw new TypeError('publication pr_disclosure.verified_at must not precede opened_at');
    }
    if (value.state === 'prepared') {
      throw new TypeError('publication pr_disclosure is not allowed for prepared records');
    }
  }
  if (!PUBLICATION_STATES.has(value.state)) throw new TypeError(`publication state is invalid: ${value.state}`);
  if (value.review_decision !== null && !REVIEW_DECISIONS.has(value.review_decision)) {
    throw new TypeError(`publication review_decision is invalid: ${value.review_decision}`);
  }
  if (value.ci_state !== null && !CI_STATES.has(value.ci_state)) {
    throw new TypeError(`publication ci_state is invalid: ${value.ci_state}`);
  }
  for (const field of ['pr_url', 'pr_head_oid', 'decision_url', 'opened_at', 'closed_at', 'updated_at',
    'observed_at', 'correction_note', 'scope_note', 'attestation_uri', 'bundle_digest',
    'release_asset_sha256', 'attestation_verified_at', 'ci_state', 'merge_commit_oid', 'base_branch']) {
    if (value[field] !== null && typeof value[field] !== 'string') {
      throw new TypeError(`publication ${field} must be a string or null`);
    }
  }
  if (value.pr_head_oid !== null && !OID_PATTERN.test(value.pr_head_oid)) {
    throw new TypeError('publication pr_head_oid must be a full commit OID or null');
  }
  if (value.merge_commit_oid !== null && !OID_PATTERN.test(value.merge_commit_oid)) {
    throw new TypeError('publication merge_commit_oid must be a full commit OID or null');
  }
  if (value.pr_number !== null && (!Number.isInteger(value.pr_number) || value.pr_number < 1)) {
    throw new TypeError('publication pr_number must be a positive integer or null');
  }
  if (typeof value.head_drift !== 'boolean') {
    throw new TypeError('publication head_drift must be boolean');
  }
  for (const field of ['opened_at', 'closed_at', 'updated_at', 'observed_at', 'attestation_verified_at']) {
    if (value[field] !== null) validTime(value[field], `publication ${field}`);
  }
  if (!SHA256_DIGEST_PATTERN.test(value.bundle_digest)) {
    throw new TypeError('publication bundle_digest must be sha256: followed by 64 lowercase hex characters');
  }
  const attestationFields = ['attestation_uri', 'release_asset_sha256', 'attestation_verified_at'];
  const presentAttestationFields = attestationFields.filter((field) => value[field] !== null);
  if (value.state === 'prepared' && presentAttestationFields.length !== 0 && presentAttestationFields.length !== 3) {
    throw new TypeError('publication prepared attestation evidence must be all null or all present');
  }
  if (value.state !== 'prepared') {
    for (const field of attestationFields) {
      if (value[field] === null) throw new TypeError(`publication ${field} is required for external records`);
    }
  }
  if (value.release_asset_sha256 !== null && !SHA256_DIGEST_PATTERN.test(value.release_asset_sha256)) {
    throw new TypeError('publication release_asset_sha256 must be sha256: followed by 64 lowercase hex characters');
  }
  const publicationAttestation = attestationAsset(value.attestation_uri, missionId, 'publication attestation_uri');
  if (publicationAttestation !== null) {
    const tag = new URL(publicationAttestation).pathname.split('/').filter(Boolean)[4];
    const legacyTag = `run-record-${missionId}`;
    const digestTag = `${legacyTag}-${value.bundle_digest.slice('sha256:'.length, 'sha256:'.length + 12)}`;
    if (tag !== legacyTag && tag !== digestTag) {
      throw new TypeError('publication attestation_uri digest suffix must match bundle_digest');
    }
  }

  if (value.state === 'prepared') {
    for (const field of ['pr_number', 'pr_url', 'pr_head_oid', 'base_branch', 'ci_state',
      'merge_commit_oid', 'review_decision', 'decision_url', 'opened_at', 'closed_at',
      'updated_at', 'observed_at']) {
      if (value[field] !== null) throw new TypeError(`publication ${field} must be null for prepared records`);
    }
    if (value.head_drift) throw new TypeError('publication head_drift must be false for prepared records');
  } else {
    if (!Number.isInteger(value.pr_number)) throw new TypeError('publication pr_number is required for external records');
    const expectedPrUrl = new RegExp(`^https://github\\.com/[^/]+/[^/]+/pull/${value.pr_number}$`);
    if (typeof value.pr_url !== 'string' || !expectedPrUrl.test(value.pr_url)) {
      throw new TypeError('publication pr_url must be the exact GitHub pull request URL matching pr_number');
    }
    for (const field of ['pr_head_oid', 'base_branch', 'ci_state', 'opened_at', 'updated_at', 'observed_at']) {
      if (value[field] === null) throw new TypeError(`publication ${field} is required for external records`);
    }
    if (value.decision_url !== null && !value.decision_url.startsWith(`${value.pr_url}#`) && value.decision_url !== value.pr_url) {
      throw new TypeError('publication decision_url must belong to the recorded pull request');
    }
    if (value.review_decision === 'approved' || value.review_decision === 'changes_requested') {
      if (value.decision_url === null) throw new TypeError('publication decision_url is required for a recorded review decision');
    }
    if (value.head_drift && value.pr_head_oid === null) throw new TypeError('publication head_drift requires pr_head_oid');
    if (value.state === 'open') {
      if (value.closed_at !== null || value.merge_commit_oid !== null) {
        throw new TypeError('publication closed_at and merge_commit_oid must be null for open records');
      }
    } else {
      if (value.closed_at === null) throw new TypeError('publication closed_at is required for closed records');
      if (value.state === 'merged' && value.merge_commit_oid === null) {
        throw new TypeError('publication merge_commit_oid is required for merged records');
      }
      if (value.state === 'closed_unmerged' && value.merge_commit_oid !== null) {
        throw new TypeError('publication merge_commit_oid must be null for closed_unmerged records');
      }
    }
    if (Date.parse(value.updated_at) < Date.parse(value.opened_at)
      || (value.closed_at !== null && Date.parse(value.updated_at) < Date.parse(value.closed_at))) {
      throw new TypeError('publication timestamps are inconsistent');
    }
    if (Date.parse(value.observed_at) < Date.parse(value.updated_at)) {
      throw new TypeError('publication observed_at must not precede updated_at');
    }
  }
  return value;
}

async function publicationFor(missionFile, missionId) {
  const file = path.join(path.dirname(missionFile), 'publication.json');
  try {
    return validatePublication(JSON.parse(await readFile(file, 'utf8')), missionId);
  } catch (error) {
    if (error.code === 'ENOENT') throw new TypeError(`publication.json is required for ${missionId}`);
    throw error;
  }
}

export function publicationOutcome(publication) {
  if (publication.state === 'open' && publication.review_decision === 'changes_requested') return 'changes_requested';
  if (publication.state === 'open' && publication.review_decision === 'approved') return 'approved';
  return publication.state;
}

function receiptClassification(variant, disclosureLabel) {
  if (
    variant === 'own_repo_rehearsal'
    || disclosureLabel.includes('REHEARSAL — NOT EXTERNAL VALIDATION')
  ) return 'REHEARSAL — NOT EXTERNAL VALIDATION';
  if (variant === 'author_contribution') return 'CONTRIBUTOR SELF-RUN — NOT MAINTAINER VERIFICATION';
  if (variant === 'V') return 'MAINTAINER-INVITED VERIFICATION';
  return `DECLARED ${variant} MISSION — SEE DISCLOSURE`;
}

function outcomeFor(mission, publication) {
  if (mission.variant === 'own_repo_rehearsal') return null;
  if (publication !== null) {
    const decisionUrl = validUrl(publication.decision_url, 'publication.json:decision_url');
    const prUrl = validUrl(publication.pr_url, 'publication.json:pr_url');
    const codeDrift = publication.head_drift === true
      ? {
          head_drift: true,
          pr_head_oid: optionalString(publication.pr_head_oid, 'publication.json:pr_head_oid'),
        }
      : {};
    const linkedReview = ['approved', 'changes_requested'].includes(publication.review_decision)
      && decisionUrl !== null;
    if (linkedReview) {
      return {
        status: publicationOutcome(publication),
        link: decisionUrl,
        attribution: 'Linked maintainer review',
        ...codeDrift,
      };
    }
    if (
      publication.state === 'open'
      && (publication.review_decision === null || publication.review_decision === 'review_required')
    ) {
      return {
        status: 'open',
        link: prUrl,
        attribution: 'Live upstream pull request',
        ...codeDrift,
      };
    }
    return {
      status: publicationOutcome(publication),
      link: decisionUrl ?? prUrl,
      attribution: 'Recorded upstream outcome',
      ...codeDrift,
    };
  }
  const result = requiredObject(mission.maintainer_outcome, 'mission.json:maintainer_outcome');
  return {
    status: requiredString(result.status, 'mission.json:maintainer_outcome.status'),
    link: validUrl(result.link, 'mission.json:maintainer_outcome.link'),
    attribution: 'Recorded mission outcome',
  };
}

function redactionEntries(redactions) {
  const source = requiredObject(redactions, 'bundle/run_record.json:redactions');
  return Object.entries(source)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => {
      if (!Number.isInteger(count) || count < 0) {
        throw new TypeError(`bundle/run_record.json:redactions.${kind} must be a non-negative integer`);
      }
      return { kind, count };
    })
    .filter((entry) => entry.count > 0);
}

function formatVerifyCommand(attestationUri) {
  if (attestationUri === null) return null;
  const filename = new URL(attestationUri).pathname.split('/').filter(Boolean).at(-1);
  if (!filename) return null;
  const shellFilename = /^[A-Za-z0-9._-]+$/.test(filename)
    ? filename
    : `'${filename.replaceAll("'", "'\\''")}'`;
  return `gh attestation verify ${shellFilename} --repo northset-oss/verification-pilot --signer-workflow ${VERIFY_WORKFLOW}`;
}

function coherentAttestationEvidence(receipt) {
  try {
    if (
      receipt.publication !== null
      && receipt.publication !== undefined
      && (
        receipt.publication.attestation_uri !== receipt.attestation_uri
        || receipt.publication.release_asset_sha256 !== receipt.release_asset_sha256
        || receipt.publication.attestation_verified_at !== receipt.attestation_verified_at
      )
    ) {
      return null;
    }
    const attestationUri = attestationAsset(receipt.attestation_uri, receipt.mission_id, 'receipt.attestation_uri');
    if (
      attestationUri === null
      || !SHA256_DIGEST_PATTERN.test(receipt.release_asset_sha256)
      || typeof receipt.attestation_verified_at !== 'string'
    ) {
      return null;
    }
    validTime(receipt.attestation_verified_at, 'receipt.attestation_verified_at');
    return {
      attestationUri,
      releaseAssetSha256: receipt.release_asset_sha256,
      verifiedAt: receipt.attestation_verified_at,
    };
  } catch {
    return null;
  }
}

/**
 * Normalize one committed mission and its immutable run record into the public receipt model.
 * Every mission-specific value is copied from mission.json, bundle/run_record.json,
 * bundle.manifest.json, publication.json, or the committed patch itself.
 */
export async function buildReceiptViewModel({ missionFile, mission: suppliedMission = null, publication: suppliedPublication = undefined }) {
  if (typeof missionFile !== 'string' || missionFile.length === 0) throw new TypeError('missionFile is required');
  const mission = suppliedMission ?? await readJson(missionFile, 'mission.json');
  const validation = validateMission(mission);
  if (!validation.valid) throw new TypeError(`mission.json is invalid: ${formatValidationErrors(validation.errors)}`);

  const missionDirectory = path.dirname(missionFile);
  const bundledMission = await readJson(path.join(missionDirectory, 'bundle', 'mission.json'), 'bundle/mission.json');
  assertReceiptParity(mission, bundledMission);
  const runRecord = await readJson(path.join(missionDirectory, 'bundle', 'run_record.json'), 'bundle/run_record.json');
  const economicFile = path.join(missionDirectory, 'bundle', 'economic.json');
  const approvalFile = path.join(missionDirectory, 'approval.json');
  const economicSource = await readTextIfPresent(economicFile);
  const approvalSource = await readTextIfPresent(approvalFile);
  if ((economicSource === null) !== (approvalSource === null)) {
    throw new TypeError('schema-v2 receipt requires both bundle/economic.json and approval.json');
  }
  let economic = null;
  let approval = null;
  if (economicSource !== null) {
    try { economic = JSON.parse(economicSource); }
    catch (error) { throw new TypeError(`bundle/economic.json is invalid JSON: ${error.message}`); }
    try { approval = JSON.parse(approvalSource); }
    catch (error) { throw new TypeError(`approval.json is invalid JSON: ${error.message}`); }
  }
  const publication = suppliedPublication === undefined
    ? await publicationFor(missionFile, mission.mission_id)
    : suppliedPublication;
  const manifest = await readJsonIfPresent(path.join(missionDirectory, 'bundle', 'bundle.manifest.json'), 'bundle/bundle.manifest.json');
  const issueSnapshotFile = path.join(missionDirectory, 'bundle', 'issue_snapshot.json');
  const issueSnapshotSource = await readTextIfPresent(issueSnapshotFile);
  const issueSnapshot = issueSnapshotSource === null
    ? null
    : await readJsonIfPresent(issueSnapshotFile, 'bundle/issue_snapshot.json');
  const patch = await readTextIfPresent(path.join(missionDirectory, 'bundle', 'patch.diff'))
    ?? await readTextIfPresent(path.join(missionDirectory, 'patch.diff'));
  const stdoutRedacted = await readTextIfPresent(path.join(missionDirectory, 'bundle', 'stdout_redacted.txt'));
  const stderrRedacted = await readTextIfPresent(path.join(missionDirectory, 'bundle', 'stderr_redacted.txt'));

  const startedAt = validTime(runRecord.started_at, 'bundle/run_record.json:started_at');
  const finishedAt = validTime(runRecord.finished_at, 'bundle/run_record.json:finished_at');
  const environment = requiredObject(runRecord.environment, 'bundle/run_record.json:environment');
  const commands = requiredArray(runRecord.commands, 'bundle/run_record.json:commands').map((command, index) => {
    const item = requiredObject(command, `bundle/run_record.json:commands[${index}]`);
    if (!Object.hasOwn(item, 'exit_code') || (item.exit_code !== null && !Number.isInteger(item.exit_code))) {
      throw new TypeError(`bundle/run_record.json:commands[${index}].exit_code must be an integer or null`);
    }
    if (Object.hasOwn(item, 'timed_out') && typeof item.timed_out !== 'boolean') {
      throw new TypeError(`bundle/run_record.json:commands[${index}].timed_out must be a boolean`);
    }
    const timedOut = item.timed_out === true;
    if ((item.exit_code === null) !== timedOut) {
      throw new TypeError(`bundle/run_record.json:commands[${index}].exit_code must be null exactly when timed_out is true`);
    }
    return {
      cmd: requiredString(item.cmd, `bundle/run_record.json:commands[${index}].cmd`),
      exit_code: item.exit_code,
      duration_ms: duration(item.duration_ms, `bundle/run_record.json:commands[${index}].duration_ms`),
      timed_out: timedOut,
    };
  });
  const declared = requiredArray(mission.commands_declared, 'mission.json:commands_declared').map((command, index) => (
    requiredString(command, `mission.json:commands_declared[${index}]`)
  ));
  if (declared.length !== commands.length || declared.some((command, index) => command !== commands[index].cmd)) {
    throw new TypeError('mission.json:commands_declared must match bundle/run_record.json:commands one-to-one and byte-for-byte');
  }
  assertProofOfPass(mission, runRecord);

  const imageRef = requiredString(environment.container_image_ref, 'bundle/run_record.json:environment.container_image_ref');
  const imageDigest = optionalString(environment.container_image_digest, 'bundle/run_record.json:environment.container_image_digest');
  const networkPolicy = requiredString(environment.network_policy, 'bundle/run_record.json:environment.network_policy');
  const workspaceEvidenceFields = [
    'workspace_write_allowlist', 'workspace_file_count_limit', 'workspace_bytes_limit',
    'initial_workspace_manifest_digest', 'post_run_changed_tracked_paths',
    'post_run_untracked_paths', 'post_run_mode_changes',
  ];
  const hasWorkspaceEvidence = Object.hasOwn(environment, 'workspace_mode');
  if (!hasWorkspaceEvidence && workspaceEvidenceFields.some((field) => Object.hasOwn(environment, field))) {
    throw new TypeError('bundle/run_record.json:environment.workspace_mode is required with workspace evidence');
  }
  if (mission.workspace_mode !== undefined && !hasWorkspaceEvidence) {
    throw new TypeError('mission.json:workspace_mode requires bundle/run_record.json:environment.workspace_mode');
  }
  if (hasWorkspaceEvidence) {
    for (const field of workspaceEvidenceFields) {
      if (!Object.hasOwn(environment, field)) {
        throw new TypeError(`bundle/run_record.json:environment.${field} is required with workspace_mode`);
      }
    }
  }
  const workspaceMode = environment.workspace_mode === undefined
    ? (mission.workspace_mode ?? null)
    : requiredString(environment.workspace_mode, 'bundle/run_record.json:environment.workspace_mode');
  if (workspaceMode !== null && !['readonly', 'writable_copy'].includes(workspaceMode)) {
    throw new TypeError('workspace_mode must be readonly or writable_copy');
  }
  if (mission.workspace_mode !== undefined && mission.workspace_mode !== workspaceMode) {
    throw new TypeError('mission.json:workspace_mode must equal bundle/run_record.json:environment.workspace_mode');
  }
  const workspaceWriteAllowlist = optionalStringArray(
    environment.workspace_write_allowlist,
    'bundle/run_record.json:environment.workspace_write_allowlist',
    {required: hasWorkspaceEvidence},
  );
  if (workspaceWriteAllowlist.length > 32 || workspaceWriteAllowlist.some((item) => (
    item !== path.posix.normalize(item) || path.posix.isAbsolute(item) || item.startsWith('../')
  ))) {
    throw new TypeError('bundle/run_record.json:environment.workspace_write_allowlist must contain at most 32 normalized relative paths');
  }
  if (workspaceMode === 'readonly' && workspaceWriteAllowlist.length > 0) {
    throw new TypeError('bundle/run_record.json:environment.workspace_write_allowlist must be empty for readonly mode');
  }
  const workspaceFileCountLimit = optionalPositiveInteger(environment.workspace_file_count_limit, 'bundle/run_record.json:environment.workspace_file_count_limit');
  const workspaceBytesLimit = optionalPositiveInteger(environment.workspace_bytes_limit, 'bundle/run_record.json:environment.workspace_bytes_limit');
  if (hasWorkspaceEvidence && (workspaceFileCountLimit === null || workspaceBytesLimit === null)) {
    throw new TypeError('workspace evidence limits must be positive integers');
  }
  const identity = requiredObject(mission.worker_identity, 'mission.json:worker_identity');
  const payment = requiredObject(mission.payment, 'mission.json:payment');
  const limitations = requiredArray(mission.limitations, 'mission.json:limitations').map((item, index) => (
    requiredString(item, `mission.json:limitations[${index}]`)
  ));
  const manifestDigest = manifest === null ? null : optionalString(manifest.bundle_digest, 'bundle/bundle.manifest.json:bundle_digest');
  const missionDigest = optionalString(mission.run_record_bundle_digest, 'mission.json:run_record_bundle_digest');
  const publicationDigest = optionalString(publication?.bundle_digest, 'publication.json:bundle_digest');
  const bundleDigest = requireAgreement(
    [manifestDigest, publicationDigest, missionDigest],
    'run-record bundle digest',
  );
  if (bundleDigest === null) throw new TypeError('receipt requires a committed run-record bundle digest');
  const missionAttestation = attestationAsset(mission.attestation_uri, mission.mission_id, 'mission.json:attestation_uri');
  const publicationAttestation = attestationAsset(
    publication?.attestation_uri,
    mission.mission_id,
    'publication.json:attestation_uri',
  );
  const attestationUri = publication?.state === 'prepared'
    ? publicationAttestation
    : requireAgreement([publicationAttestation, missionAttestation], 'attestation URI');
  const baseCommit = optionalString(mission.base_commit, 'mission.json:base_commit');
  const sourceCommit = optionalString(environment.source_commit, 'bundle/run_record.json:environment.source_commit');
  if (baseCommit !== null && sourceCommit !== null && baseCommit !== sourceCommit) {
    throw new TypeError('mission.json:base_commit must equal bundle/run_record.json:environment.source_commit');
  }
  const patchCommit = optionalString(mission.patch_commit, 'mission.json:patch_commit');
  if (publication.state !== 'prepared') {
    const expectedHeadDrift = patchCommit !== publication.pr_head_oid;
    if (publication.head_drift !== expectedHeadDrift) {
      throw new TypeError('publication head_drift must be true exactly when pr_head_oid and mission.patch_commit mismatch');
    }
  }
  const patchDiffHash = optionalString(mission.patch_diff_hash, 'mission.json:patch_diff_hash');
  const executedPatchHash = optionalString(environment.patch_sha256, 'bundle/run_record.json:environment.patch_sha256');
  if (patchDiffHash !== null && executedPatchHash !== null && patchDiffHash !== executedPatchHash) {
    throw new TypeError('mission.json:patch_diff_hash must equal bundle/run_record.json:environment.patch_sha256');
  }
  if (patchDiffHash !== null && patch !== null) {
    const committedPatchHash = `sha256:${createHash('sha256').update(patch).digest('hex')}`;
    if (patchDiffHash !== committedPatchHash) {
      throw new TypeError('mission.json:patch_diff_hash must equal the committed patch.diff SHA-256');
    }
  }
  const consentArtifact = validUrl(mission.consent_artifact, 'mission.json:consent_artifact');
  if (CONSENT_VARIANTS.has(mission.variant) && consentArtifact === null) {
    throw new TypeError(`mission.json:consent_artifact is required for variant ${mission.variant}`);
  }
  const successfulChecks = commands.filter((command) => command.exit_code === 0 && !command.timed_out).length;
  const issueOrTask = validUrl(mission.issue_or_task, 'mission.json:issue_or_task');
  let issueTitle = null;
  if (issueSnapshot?.issue !== undefined) {
    const issue = requiredObject(issueSnapshot.issue, 'bundle/issue_snapshot.json:issue');
    issueTitle = requiredString(issue.title, 'bundle/issue_snapshot.json:issue.title').trim();
    const snapshotUrl = validUrl(issue.html_url, 'bundle/issue_snapshot.json:issue.html_url');
    if (snapshotUrl === null || issueOrTask === null || snapshotUrl !== issueOrTask) {
      throw new TypeError('bundle/issue_snapshot.json:issue.html_url must equal mission.json:issue_or_task');
    }
  }
  const wallDurationMs = Date.parse(finishedAt) - Date.parse(startedAt);
  const commandDurationMs = commands.reduce((total, command) => total + command.duration_ms, 0);
  const timingConsistent = wallDurationMs >= commandDurationMs;
  const setupInstallDurationMs = timingConsistent ? wallDurationMs - commandDurationMs : null;
  if (economic !== null) {
    validateEconomicIdentity(economic, {mission, runRecord});
    validateApprovalRecord(approval, {mission, economic});
    if (Date.parse(approval.approved_at) < Date.parse(finishedAt)) {
      throw new TypeError('approval.json approved_at cannot precede the recorded run finish');
    }
    if (issueSnapshotSource === null) throw new TypeError('schema-v2 receipt requires bundle/issue_snapshot.json');
    const issueSnapshotDigest = `sha256:${createHash('sha256').update(issueSnapshotSource).digest('hex')}`;
    if (economic.provenance.issue_snapshot_sha256 !== issueSnapshotDigest) {
      throw new TypeError('economic.json issue snapshot digest does not match bundle/issue_snapshot.json');
    }
    await validateEconomicSourceRefs(economic, missionDirectory);
    if (manifest === null) throw new TypeError('schema-v2 receipt requires bundle/bundle.manifest.json');
    const entry = Array.isArray(manifest.files)
      ? manifest.files.find((item) => item?.path === 'economic.json')
      : null;
    const actualDigest = createHash('sha256').update(economicSource).digest('hex');
    if (entry?.sha256 !== actualDigest) {
      throw new TypeError('bundle/economic.json must be bound by bundle.manifest.json');
    }
  }
  const economicIdentity = economic === null ? null : projectEconomicIdentity(economic, approval, publication, mission);

  return {
    version: economicIdentity === null ? 1 : 2,
    mission_id: mission.mission_id,
    canonical_path: `receipts/${mission.mission_id}/`,
    canonical_url: `${RECEIPT_BASE_URL}/${mission.mission_id}/`,
    variant: mission.variant,
    classification: receiptClassification(mission.variant, mission.disclosure_label),
    disclosure_label: requiredString(mission.disclosure_label, 'mission.json:disclosure_label'),
    consent_artifact: consentArtifact,
    target_repo: validUrl(mission.target_repo, 'mission.json:target_repo'),
    issue_or_task: issueOrTask,
    issue_title: issueTitle,
    worker_identity: {
      runtime: requiredString(identity.runtime, 'mission.json:worker_identity.runtime'),
      human_operator: requiredString(identity.human_operator, 'mission.json:worker_identity.human_operator'),
    },
    code: {
      base_commit: baseCommit,
      recorded_patch_commit: patchCommit,
      patch_commit_binding: 'declared metadata; not execution-bound',
      patch_diff_hash: patchDiffHash,
      patch_diff_binding: patchDiffHash === null ? 'no patch recorded' : 'bound to executed patch bytes',
    },
    started_at: startedAt,
    finished_at: finishedAt,
    environment: {
      container_image_ref: imageRef,
      container_image_digest: imageDigest,
      container_image_id: optionalString(environment.container_image_id, 'bundle/run_record.json:environment.container_image_id'),
      container_os: optionalString(environment.container_os, 'bundle/run_record.json:environment.container_os'),
      container_architecture: optionalString(environment.container_architecture, 'bundle/run_record.json:environment.container_architecture'),
      network_policy: networkPolicy,
      workspace_mode: workspaceMode,
      workspace_write_allowlist: workspaceWriteAllowlist,
      workspace_file_count_limit: workspaceFileCountLimit,
      workspace_bytes_limit: workspaceBytesLimit,
      initial_workspace_manifest_digest: optionalString(environment.initial_workspace_manifest_digest, 'bundle/run_record.json:environment.initial_workspace_manifest_digest'),
      post_run_changed_tracked_paths: optionalStringArray(environment.post_run_changed_tracked_paths, 'bundle/run_record.json:environment.post_run_changed_tracked_paths', {required: hasWorkspaceEvidence}),
      post_run_untracked_paths: optionalStringArray(environment.post_run_untracked_paths, 'bundle/run_record.json:environment.post_run_untracked_paths', {required: hasWorkspaceEvidence}),
      post_run_mode_changes: optionalStringArray(environment.post_run_mode_changes, 'bundle/run_record.json:environment.post_run_mode_changes', {required: hasWorkspaceEvidence}),
      source_commit: sourceCommit,
      install_commands: Array.isArray(environment.install_commands)
        ? environment.install_commands.map((command, index) => requiredString(command, `bundle/run_record.json:environment.install_commands[${index}]`))
        : [],
    },
    commands,
    declared_checks: declared.length,
    successful_checks: successfulChecks,
    result: `PASS — ${successfulChecks}/${declared.length} declared command${declared.length === 1 ? '' : 's'}`,
    execution_summary: `${successfulChecks}/${declared.length} declared command${declared.length === 1 ? '' : 's'} returned exit 0 in the recorded environment`,
    wall_duration_ms: timingConsistent ? wallDurationMs : null,
    setup_install_duration_ms: setupInstallDurationMs,
    economic_identity: economicIdentity,
    payment: {
      maintainer_payment: requiredString(payment.maintainer_payment, 'mission.json:payment.maintainer_payment'),
      merge_contingent: payment.merge_contingent === true,
    },
    redactions: redactionEntries(runRecord.redactions),
    limitations,
    bundle_digest: bundleDigest,
    release_asset_sha256: publication?.release_asset_sha256 ?? null,
    attestation_verified_at: publication?.attestation_verified_at ?? null,
    attestation_uri: attestationUri,
    verify_command: formatVerifyCommand(attestationUri),
    download_url: attestationUri,
    patch_diff: patch,
    stdout_redacted: stdoutRedacted,
    stderr_redacted: stderrRedacted,
    correction_note: optionalString(publication?.correction_note, 'publication.json:correction_note'),
    scope_note: optionalString(publication?.scope_note, 'publication.json:scope_note'),
    publication,
    live_outcome: outcomeFor(mission, publication),
  };
}

/**
 * Build and write a deterministic public ledger index with normalized receipt view models.
 */
export async function buildLedger({
  missionsDir,
  out,
  now = null,
  onWarning = () => {},
  allowSkips = false,
  excludeMissionIds = [],
}) {
  if (!Array.isArray(excludeMissionIds) || excludeMissionIds.some((missionId) => !GENERATED_RECEIPT_PATTERN.test(missionId))) {
    throw new TypeError('excludeMissionIds must be an array of generated mission IDs');
  }
  const excluded = new Set(excludeMissionIds);
  const directoryEntries = await readdir(missionsDir, { withFileTypes: true });
  const missionFiles = directoryEntries
    .filter((entry) => (
      entry.isDirectory()
      && !entry.name.startsWith('.')
      && !excluded.has(entry.name)
    ))
    .map((entry) => path.join(missionsDir, entry.name, 'mission.json'))
    .sort();
  const missions = [];
  let skipped = 0;

  for (const missionFile of missionFiles) {
    let mission;
    try {
      mission = JSON.parse(await readFile(missionFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        if (!allowSkips) throw new TypeError(`${missionFile}: mission.json is required`);
        skipped += 1;
        onWarning(`skipping ${missionFile}: mission.json is required`);
        continue;
      }
      if (!allowSkips) throw new TypeError(`${missionFile}: ${error.message}`);
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${error.message}`);
      continue;
    }
    const validation = validateMission(mission);
    if (!validation.valid) {
      if (!allowSkips) throw new TypeError(`${missionFile}: ${formatValidationErrors(validation.errors)}`);
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${formatValidationErrors(validation.errors)}`);
      continue;
    }

    let publication;
    let receipt;
    try {
      publication = await publicationFor(missionFile, mission.mission_id);
      receipt = await buildReceiptViewModel({ missionFile, mission, publication });
    } catch (error) {
      if (!allowSkips) throw new TypeError(`${missionFile}: ${error.message}`);
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${error.message}`);
      continue;
    }
    const projected = projectMission(mission);
    projected.receipt = receipt;
    projected.publication = publication;
    if (publication !== null) {
      projected.maintainer_outcome = {
        status: publicationOutcome(publication),
        link: publication.decision_url ?? publication.pr_url,
      };
      if (publication.bundle_digest) projected.run_record_bundle_digest = publication.bundle_digest;
      projected.attestation_uri = publication.attestation_uri;
      projected.attested = typeof projected.attestation_uri === 'string';
    }
    missions.push(projected);
  }

  missions.sort(compareMissionIds);
  const index = {
    version: '1',
    generated_at: now,
    ci_agreement: ciAgreementForReceipts(missions.map((mission) => mission.receipt)),
    missions,
  };
  await writeOutput(out, `${JSON.stringify(index, null, 2)}\n`);
  return { included: missions.length, skipped, index };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapePreformatted(value) {
  return escapeHtml(value)
    .replaceAll('\t', '&#9;')
    .replace(/ +$/gm, (spaces) => '&#32;'.repeat(spaces.length));
}

function jsonPointerValue(value, pointer) {
  let current = value;
  for (const segment of pointer.slice(1).split('/').map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) return {found: false};
    current = current[segment];
  }
  return {found: true, value: current};
}

async function validateEconomicSourceRefs(economic, missionDirectory) {
  for (const line of economic.costs.lines) {
    for (const ref of line.source_refs) {
      const relative = ref.artifact.split('/');
      if (path.isAbsolute(ref.artifact) || relative.includes('..') || relative.includes('.') || !ref.artifact.startsWith('bundle/')) {
        throw new TypeError('economic.json cost source_refs must identify public bundle artifacts');
      }
      const artifactFile = path.join(missionDirectory, ...relative);
      let source;
      try { source = await readFile(artifactFile); }
      catch (error) { throw new TypeError(`economic.json cost source artifact is unavailable: ${ref.artifact}: ${error.message}`); }
      const digest = `sha256:${createHash('sha256').update(source).digest('hex')}`;
      if (digest !== ref.artifact_sha256) throw new TypeError(`economic.json cost source digest does not match ${ref.artifact}`);
      if (ref.artifact.endsWith('.json')) {
        let parsed;
        try { parsed = JSON.parse(source.toString('utf8')); }
        catch (error) { throw new TypeError(`economic.json cost source artifact is invalid JSON: ${ref.artifact}: ${error.message}`); }
        if (!jsonPointerValue(parsed, ref.json_pointer).found) {
          throw new TypeError(`economic.json cost source pointer does not exist in ${ref.artifact}`);
        }
      }
    }
  }
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

function link(value, label, className = '') {
  const href = safeUrl(value);
  if (href === null) return `<span class="${className}">${escapeHtml(label)}</span>`;
  return `<a class="${className}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function relativeLink(href, label, className = '') {
  return `<a class="${className}" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function requestRunMailto(repository = null) {
  const subject = repository === null
    ? 'Northset run request: owner/repository#123'
    : `Northset run request: ${repository}`;
  const body = [
    'PR URL:',
    'Repository:',
    'I am a maintainer or authorized representative:',
    'Checks to run, if different from repo defaults:',
    'Anything Northset should know:',
  ].join('\n');
  return `mailto:${RUN_REQUEST_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function renderRequestRunCta(repository = null) {
  const heading = repository === null ? 'Request a private run' : `Maintain ${repository}?`;
  const body = repository === null
    ? '<strong>Maintain an open-source project?</strong> Send Northset a PR already in your queue. We run its repository-declared checks in an isolated container and return the run record privately. We do not modify the PR. Nothing is published without your approval. Free during the pilot.'
    : 'Get this same run for any PR in your queue — private, free during the pilot, nothing published without your approval.';
  return `<section class="request-run" aria-labelledby="request-run-title">
  <p class="eyebrow">FOR MAINTAINERS</p>
  <h2 id="request-run-title">${escapeHtml(heading)}</h2>
  <p>${body}</p>
  <div class="request-actions"><a class="button-link request-primary" href="${escapeHtml(PUBLIC_RUN_REQUEST_URL)}">Open a public request</a><a class="button-link request-secondary" href="${escapeHtml(requestRunMailto(repository))}">Email a private request</a><a class="button-link request-secondary" href="${escapeHtml(SAMPLE_PRIVATE_CHECK_RECEIPT_URL)}">See a sample private check receipt</a></div>
  <p class="request-public-note">The issue form is public. Do not include secrets or private repository details there; use email instead.</p>
  <p class="request-onboarded"><strong>Already onboarded?</strong> Add <code>northset-verify</code> to a PR to request a run on that PR.</p>
</section>`;
}

function repoLabel(value) {
  try {
    return new URL(value).pathname.replace(/^\/+/, '') || value;
  } catch {
    return value;
  }
}

function repositoryIdentity(targetRepo) {
  const parsed = new URL(targetRepo);
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (parsed.origin !== 'https://github.com' || segments.length !== 2) {
    return null;
  }
  const [owner, repository] = segments;
  const slug = `${owner}--${repository}`;
  if (!GENERATED_REPOSITORY_PATTERN.test(slug)) {
    throw new TypeError('external receipt repository cannot form a safe generated repository path');
  }
  return { label: `${owner}/${repository}`, slug };
}

function repositoryReceiptGroups(receipts) {
  const groups = new Map();
  const externalSlugs = new Set();
  for (const receipt of receipts) {
    const repository = repositoryIdentity(receipt.target_repo);
    if (repository === null) continue;
    const group = groups.get(repository.slug) ?? { repository, receipts: [] };
    group.receipts.push(receipt);
    groups.set(repository.slug, group);
    if (receipt.variant !== 'own_repo_rehearsal') externalSlugs.add(repository.slug);
  }
  return new Map([...groups].filter(([slug]) => externalSlugs.has(slug)));
}

export function ciAgreementForReceipts(receipts) {
  const conclusive = receipts.filter((receipt) => ['success', 'failure'].includes(receipt.publication?.ci_state));
  return {
    agreed: conclusive.filter((receipt) => receipt.publication.ci_state === 'success').length,
    total: conclusive.length,
  };
}

function renderCiAgreementLine(receipt) {
  if (!['success', 'failure'].includes(receipt.publication?.ci_state)) return '';
  return `<p class="receipt-ci-agreement"><strong>Upstream CI ${receipt.publication.ci_state === 'success' ? 'agreed' : 'disagreed'} with this receipt.</strong> This is a recorded upstream observation, not part of the signed run evidence.</p>`;
}

function renderDiscrepancyPledge() {
  return `<p class="discrepancy-pledge">If your CI disagrees with this receipt, <a href="${escapeHtml(DISCREPANCY_REPORT_URL)}">report it</a> — we publish discrepancies on this ledger.</p>`;
}

function issueLabel(value) {
  try {
    const segments = new URL(value).pathname.split('/').filter(Boolean);
    const number = segments.at(-1);
    const kind = segments.at(-2);
    if (!/^\d+$/.test(number)) return 'Issue or task';
    if (kind === 'issues') return `Issue #${number}`;
    if (kind === 'pull') return `PR #${number}`;
    if (kind === 'discussions') return `Discussion #${number}`;
    return 'Issue or task';
  } catch {
    return 'Issue or task';
  }
}

function prLabel(publication) {
  return publication?.pr_number === null || publication?.pr_number === undefined
    ? 'Pull request'
    : `PR #${publication.pr_number}`;
}

function formatDuration(milliseconds) {
  if (!Number.isInteger(milliseconds) || milliseconds < 0) return null;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds % 1 === 0 ? seconds : seconds.toFixed(1).replace(/\.0$/, '')}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}m${String(remainder).padStart(2, '0')}s`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function utcDateParts(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError('value must be a valid date-time');
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth(),
    day: parsed.getUTCDate(),
    hours: String(parsed.getUTCHours()).padStart(2, '0'),
    minutes: String(parsed.getUTCMinutes()).padStart(2, '0'),
  };
}

export function formatHumanDate(value) {
  const {year, month, day} = utcDateParts(value);
  return `${MONTH_NAMES[month]} ${day}, ${year}`;
}

function formatUtcTime(value) {
  const {hours, minutes} = utcDateParts(value);
  return `${hours}:${minutes}`;
}

function sameUtcDate(left, right) {
  const leftParts = utcDateParts(left);
  const rightParts = utcDateParts(right);
  return leftParts.year === rightParts.year
    && leftParts.month === rightParts.month
    && leftParts.day === rightParts.day;
}

export function formatRunInterval(startedAt, finishedAt, wallDurationMs = null) {
  const interval = sameUtcDate(startedAt, finishedAt)
    ? `${formatHumanDate(startedAt)} · ${formatUtcTime(startedAt)}–${formatUtcTime(finishedAt)} UTC`
    : `${formatHumanDate(startedAt)} ${formatUtcTime(startedAt)} UTC–${formatHumanDate(finishedAt)} ${formatUtcTime(finishedAt)} UTC`;
  const durationLabel = formatDuration(wallDurationMs);
  return durationLabel === null ? interval : `${interval} · ${durationLabel.replace('m', 'm ')}`;
}

export function truncateHash(value) {
  const match = String(value).match(/^(.*sha256:)([0-9a-f]{64})$/);
  if (match === null) return String(value);
  return `${match[1]}${match[2].slice(0, 6)}…${match[2].slice(-7)}`;
}

function renderHumanTimestamp(value) {
  return `<time datetime="${escapeHtml(value)}">${escapeHtml(formatHumanDate(value))} · ${escapeHtml(formatUtcTime(value))} UTC</time>`;
}

function renderRunInterval(startedAt, finishedAt, wallDurationMs) {
  if (startedAt === null || finishedAt === null) {
    return '<span class="evidence-unavailable">not recorded in the immutable source proof</span>';
  }
  const durationLabel = formatDuration(wallDurationMs);
  const startLabel = sameUtcDate(startedAt, finishedAt)
    ? `${formatHumanDate(startedAt)} · ${formatUtcTime(startedAt)}`
    : `${formatHumanDate(startedAt)} · ${formatUtcTime(startedAt)} UTC`;
  const finishLabel = sameUtcDate(startedAt, finishedAt)
    ? `${formatUtcTime(finishedAt)} UTC`
    : `${formatHumanDate(finishedAt)} · ${formatUtcTime(finishedAt)} UTC`;
  return `<span class="human-run-interval" aria-label="${escapeHtml(formatRunInterval(startedAt, finishedAt, wallDurationMs))}"><time datetime="${escapeHtml(startedAt)}">${escapeHtml(startLabel)}</time><span aria-hidden="true">–</span><time datetime="${escapeHtml(finishedAt)}">${escapeHtml(finishLabel)}</time>${durationLabel === null ? '' : `<span aria-hidden="true">·</span><span>${escapeHtml(durationLabel.replace('m', 'm '))}</span>`}</span>`;
}

function renderCopyableHash(value, label) {
  const rendered = truncateHash(value);
  if (rendered === String(value)) return `<code>${escapeHtml(value)}</code>`;
  return `<span class="copyable-hash"><code>${escapeHtml(rendered)}</code><button type="button" class="copy-hash" data-copy="${escapeHtml(value)}" aria-label="Copy full ${escapeHtml(label)}">Copy</button></span>`;
}

function durationOrUnavailable(milliseconds) {
  return formatDuration(milliseconds) ?? 'not captured';
}

function readableKey(value) {
  return String(value).replaceAll('_', ' ');
}

function renderEconomicOverview(receipt) {
  if (receipt.version !== 2) return '';
  const economic = receipt.economic_identity;
  const {task, funding, authorization, attempt_lineage: lineage, usage, work_scope: work, costs} = economic;
  const upstreamState = receipt.publication?.state ?? 'prepared';
  const missing = costs.missing_components.length === 0
    ? '<li>No known cost components are missing.</li>'
    : costs.missing_components.map((item) => `<li>${escapeHtml(readableKey(item))}</li>`).join('');
  const approvalTime = new Date(authorization.approved_at).toISOString();
  const orderedAttempts = [...lineage.attempts].sort((left, right) => left.attempt_sequence - right.attempt_sequence);
  const groupedAttempts = [];
  for (let index = 0; index < orderedAttempts.length;) {
    const first = orderedAttempts[index];
    const firstIsCurrent = first.attempt_id === task.attempt_id;
    let end = index + 1;
    while (!firstIsCurrent && end < orderedAttempts.length) {
      const previous = orderedAttempts[end - 1];
      const next = orderedAttempts[end];
      if (
        next.attempt_id === task.attempt_id
        || next.attempt_sequence !== previous.attempt_sequence + 1
        || next.state !== first.state
        || next.terminal_reason_class !== first.terminal_reason_class
      ) break;
      end += 1;
    }
    const run = orderedAttempts.slice(index, end);
    if (run.length >= 3) groupedAttempts.push(run);
    else groupedAttempts.push(...run.map((attempt) => [attempt]));
    index = end;
  }
  const attemptStations = groupedAttempts.map((attemptGroup) => {
    if (attemptGroup.length >= 3) {
      const first = attemptGroup[0];
      const last = attemptGroup.at(-1);
      const stateLabel = readableKey(first.state).toUpperCase();
      const reasonLabel = first.terminal_reason_class === null
        ? 'no terminal reason recorded'
        : readableKey(first.terminal_reason_class);
      const groupLabel = `Attempts ${first.attempt_sequence} through ${last.attempt_sequence}: ${stateLabel}; terminal reason ${reasonLabel}; IDs ${first.attempt_id} through ${last.attempt_id}`;
      const clusterMarks = attemptGroup.map(() => '<span class="attempt-cluster-mark"></span>').join('');
      return `<li class="proofline-attempt proofline-attempt--grouped" data-attempt-count="${attemptGroup.length}" style="--attempt-count:${attemptGroup.length}" aria-label="${escapeHtml(groupLabel)}"><span class="attempt-group-bracket" aria-hidden="true"><span class="attempt-cluster">${clusterMarks}</span></span><span class="attempt-group-copy"><span class="attempt-sequence">ATTEMPTS ${first.attempt_sequence}–${last.attempt_sequence}</span><code>${escapeHtml(first.attempt_id)} → ${escapeHtml(last.attempt_id)}</code><strong>${attemptGroup.length}× ${escapeHtml(stateLabel)}</strong><span class="attempt-reason">${escapeHtml(reasonLabel)}</span></span></li>`;
    }
    const attempt = attemptGroup[0];
    const current = attempt.attempt_id === task.attempt_id;
    const ready = current && attempt.state.toUpperCase() === 'READY';
    const classes = ['proofline-attempt', current ? 'proofline-attempt--current' : '', ready ? 'proofline-attempt--ready' : '']
      .filter(Boolean)
      .join(' ');
    const terminalReason = attempt.terminal_reason_class === null
      ? ''
      : `<span class="attempt-reason">${escapeHtml(readableKey(attempt.terminal_reason_class))}</span>`;
    return `<li class="${classes}"${current ? ' aria-current="step"' : ''}><span class="attempt-tick" aria-hidden="true"></span><span class="attempt-sequence">ATTEMPT ${attempt.attempt_sequence}</span><code>${escapeHtml(attempt.attempt_id)}</code><strong>${escapeHtml(readableKey(attempt.state))}</strong>${terminalReason}</li>`;
  }).join('');
  const stages = [
    {label: 'Discovery', duration: usage.discovery.elapsed_ms},
    {label: 'Qualification', duration: usage.qualification.duration_ms},
    {label: 'Authoring', duration: usage.authoring.duration_ms},
    {label: 'Verification', duration: usage.verification.executor_elapsed_ms},
  ];
  const measuredStageDuration = stages.reduce((total, stage) => total + (stage.duration ?? 0), 0);
  const currentAttemptIndex = orderedAttempts.findIndex((attempt) => attempt.attempt_id === task.attempt_id);
  const currentNodePosition = orderedAttempts.length === 0 || currentAttemptIndex < 0
    ? 0
    : (currentAttemptIndex / orderedAttempts.length) * 100;
  const anatomySegments = stages.map((stage) => {
    const percentage = stage.duration === null || measuredStageDuration === 0
      ? 0
      : (stage.duration / measuredStageDuration) * 100;
    const safePercentage = Number.isFinite(percentage)
      ? Math.min(100, Math.max(0, percentage)).toFixed(6)
      : '0.000000';
    return `<span class="anatomy-segment" data-available="${stage.duration === null ? 'false' : 'true'}" style="--anatomy-share:${safePercentage}%"></span>`;
  }).join('');
  const stageStations = stages.map((stage, index) => {
    const percentage = stage.duration === null || measuredStageDuration === 0
      ? 0
      : (stage.duration / measuredStageDuration) * 100;
    const safePercentage = Number.isFinite(percentage)
      ? Math.min(100, Math.max(0, percentage))
      : 0;
    const percentageLabel = stage.duration === null
      ? ''
      : `<span class="stage-share">${safePercentage.toFixed(1).replace(/\.0$/, '')}%</span>`;
    return `<div class="proofline-stage" data-available="${stage.duration === null ? 'false' : 'true'}"><span class="stage-index">0${index + 1}</span><span class="stage-name">${stage.label}</span><strong>${escapeHtml(durationOrUnavailable(stage.duration))}</strong>${percentageLabel}</div>`;
  }).join('');
  const costIncomplete = costs.status !== 'complete' || costs.total_economic_cost === null;
  const costCompleteness = readableKey(economic.completeness.cost);
  const totalCost = costs.total_economic_cost === null
    ? 'UNPRICED'
    : `${costs.currency === null ? '' : `${costs.currency} `}${costs.total_economic_cost}`;
  const totalCostExplanation = costs.total_economic_cost === null
    ? 'No complete total is recorded; see the missing or unpriced component record above.'
    : `Recorded ${readableKey(costs.status)} total${costs.currency === null ? ' without a recorded currency.' : '.'}`;
  return `<section class="economic-overview" aria-labelledby="economic-overview-title">
  <p class="section-kicker">01 / TECHNICAL RESULT</p>
  <h2 class="visually-hidden" id="economic-overview-title">Technical result</h2>
  <div class="proof-hero">
    <div class="proof-result">
      <div class="proof-score">${receipt.declared_checks}/${receipt.declared_checks}</div>
      <p class="proof-statement"><strong>declared commands passed</strong></p>
      <p>Recorded on the named code in the named execution environment. The evidence annex carries the exact scope.</p>
    </div>
    <dl class="proof-status-rail">
      <div><dt>Upstream</dt><dd><strong>${escapeHtml(outcomeLabel(upstreamState))}</strong><span>mutable external state</span></dd></div>
      <div><dt>Attempts</dt><dd><strong>${lineage.attempts_total} total</strong><span>current <code>${escapeHtml(task.attempt_id)}</code> · #${task.attempt_sequence}</span></dd></div>
      <div${costIncomplete ? ' data-cost-state="incomplete"' : ''}><dt>Cost record</dt><dd><strong>${escapeHtml(readableKey(costs.status).toUpperCase())}</strong><span>${escapeHtml(costCompleteness)}</span></dd></div>
    </dl>
  </div>
</section>
<section class="proofline" aria-labelledby="proofline-title">
  <div class="section-heading proofline-heading"><div><p class="section-kicker">02 / RECORDED WORK SEQUENCE</p><h2 id="proofline-title">Northset Proofline</h2></div><p>Every task-bound attempt is shown in recorded order. Anatomy geometry follows each non-null elapsed duration’s share; labels retain exact recorded time.</p></div>
  <div class="proofline-instrument" style="--current-node:${currentNodePosition.toFixed(6)}%">
    <ol class="attempt-proofline" aria-label="Task-bound attempt sequence">${attemptStations}</ol>
    <div class="proofline-stages" aria-label="Recorded stage durations">
      <div class="proofline-anatomy">
        <p class="anatomy-title">ATTEMPT ${task.attempt_sequence} / EXECUTION ANATOMY</p>
        <div class="anatomy-bar">${anatomySegments}</div>
        <div class="anatomy-legend">${stageStations}</div>
      </div>
    </div>
  </div>
</section>
<section class="economic-identity" aria-labelledby="economic-identity-title">
  <div class="section-heading"><div><p class="section-kicker">03 / ECONOMIC NARRATIVE</p><h2 id="economic-identity-title">Economic identity</h2></div><p>Observed sponsorship, authorization, scope, transfer, and outcome. No estimates or inferred value.</p></div>
  <ol class="identity-flow">
    <li><article><p class="flow-index">01 / MANDATE</p><h3>Sponsored and authorized</h3><p class="flow-lede">The recorded mandate names both its sponsor and initiative, with authorization tied to a named approver and approval time.</p><div class="flow-meta"><p><span>SPONSOR</span><strong>${escapeHtml(funding.program)}</strong> · ${escapeHtml(funding.initiative)}</p><p><span>AUTHORIZED</span><strong>${escapeHtml(authorization.approved_by)}</strong> · <time datetime="${escapeHtml(approvalTime)}">${escapeHtml(approvalTime)}</time></p></div></article></li>
    <li><article><p class="flow-index">02 / WORK</p><h3>Demand became scoped work</h3><p class="flow-lede">An external issue invitation became a stable task and a recorded code-and-test scope, without treating scope as a measure of value.</p><div class="flow-meta"><p><span>TASK</span><code>${escapeHtml(task.task_id)}</code> · ${escapeHtml(readableKey(task.work_category))} · attempt ${task.attempt_sequence}</p><p><span>INVITATION</span>${link(task.external_demand.issue_url, issueLabel(task.external_demand.issue_url))} · ${escapeHtml(readableKey(task.external_demand.invitation_type))}</p><p><span>SCOPE</span>${work.files_changed} files · ${work.changed_lines} changed lines · ${work.production_files} production files · ${work.test_files} test files · ${work.checks_declared} declared ${work.checks_declared === 1 ? 'check' : 'checks'}</p></div></article></li>
    <li><article><p class="flow-index">03 / EXTERNAL OUTCOME</p><h3>Transfer and upstream state</h3><p class="flow-lede">The recorded maintainer transfer and its contingency are separate from upstream state, which remains a mutable external observation.</p><div class="flow-meta"><p><span>MAINTAINER TRANSFER</span><strong>${escapeHtml(economic.external_transfers.maintainer_payment)}</strong> · ${economic.external_transfers.merge_contingent ? 'merge contingent' : 'not merge contingent'}</p><p><span>UPSTREAM</span><strong>${escapeHtml(outcomeLabel(upstreamState))}</strong> · mutable external observation</p></div></article></li>
  </ol>
</section>
<section class="economic-unknowns" aria-labelledby="economic-unknowns-title">
  <div><p class="section-kicker">04 / COST COMPLETENESS</p><h2 id="economic-unknowns-title">Known, unknown, and unpriced</h2><p><strong>Known:</strong> maintainer payment was ${escapeHtml(economic.external_transfers.maintainer_payment)}. A known zero external transfer is not a zero total cost.</p></div>
  <div><h3>Missing or unpriced components</h3><ul>${missing}</ul></div>
</section>
<section class="receipt-cost-total" data-cost-state="${costIncomplete ? 'incomplete' : 'complete'}" aria-label="Recorded total economic cost">
  <span>TOTAL COST</span><strong>${escapeHtml(totalCost)}</strong><p>${escapeHtml(totalCostExplanation)}</p>
</section>`;
}

function renderEconomicEvidence(receipt) {
  if (receipt.version !== 2) return '';
  const economic = receipt.economic_identity;
  const {attempt_lineage: lineage, usage, costs, outcome} = economic;
  const evidenceNull = (label) => `<span class="evidence-null">${escapeHtml(label)}</span>`;
  const evidenceValue = (value, missingLabel) => value === null || value === undefined
    ? evidenceNull(missingLabel)
    : escapeHtml(String(value));
  const durationEvidence = (milliseconds) => {
    const label = formatDuration(milliseconds);
    return label === null ? evidenceNull('not captured') : escapeHtml(label);
  };
  const orderedAttempts = [...lineage.attempts].sort((left, right) => left.attempt_sequence - right.attempt_sequence);
  const attempts = orderedAttempts.map((attempt) => `<li><code>${escapeHtml(attempt.attempt_id)}</code><span>attempt ${attempt.attempt_sequence} · ${escapeHtml(readableKey(attempt.state))}${attempt.terminal_reason_class === null ? '' : ` · ${escapeHtml(readableKey(attempt.terminal_reason_class))}`}</span></li>`).join('');
  const costLines = costs.lines.length === 0
    ? '<p class="evidence-null">No public priced cost lines were recorded.</p>'
    : `<ul class="cost-lines">${costs.lines.map((line) => {
      const quantity = line.quantity === null
        ? evidenceNull('quantity unavailable')
        : `${escapeHtml(String(line.quantity))} ${escapeHtml(readableKey(line.unit))}`;
      const currency = line.currency ?? costs.currency;
      const amount = line.amount === null
        ? evidenceNull('amount unavailable')
        : `${currency === null ? `${evidenceNull('currency not recorded')} ` : `${escapeHtml(currency)} `}${escapeHtml(line.amount)}`;
      return `<li><strong>${escapeHtml(readableKey(line.component))}</strong><span>${escapeHtml(readableKey(line.measurement_class))} · ${quantity} · ${amount}</span></li>`;
    }).join('')}</ul>`;
  const resource = usage.resource_envelope;
  return `<details class="annex-chapter annex-economic" open>
  <summary class="annex-heading"><span>01</span><div><p>Economic evidence</p><small>Lineage, usage, caps, outcome, and cost provenance</small></div></summary>
  <div class="drawer-grid">
    <section class="evidence-group evidence-lineage"><h4>Attempt lineage</h4><ul class="attempt-list">${attempts}</ul></section>
    <section class="evidence-group evidence-usage"><h4>Recorded usage</h4><dl class="facts"><dt>requested reviewer model</dt><dd>${escapeHtml(usage.qualification.requested_model)}</dd><dt>actual reviewer model</dt><dd>${evidenceValue(usage.qualification.actual_model, 'not captured')}</dd><dt>requested author model</dt><dd>${escapeHtml(usage.authoring.requested_model)}</dd><dt>actual author model</dt><dd>${evidenceValue(usage.authoring.actual_model, 'not captured')}</dd><dt>networked setup phase</dt><dd>${durationEvidence(usage.verification.networked_setup_elapsed_ms)}</dd><dt>install-only duration</dt><dd>${durationEvidence(usage.verification.dependency_install_ms)}</dd><dt>declared commands</dt><dd>${durationEvidence(usage.verification.declared_commands_ms)}</dd><dt>unclassified executor time</dt><dd>${durationEvidence(usage.verification.unclassified_executor_ms)}</dd><dt>CPU time</dt><dd>${durationEvidence(usage.verification.cpu_ms)}</dd><dt>peak RSS</dt><dd>${usage.verification.peak_rss_bytes === null ? evidenceNull('not captured') : `${escapeHtml(String(usage.verification.peak_rss_bytes))} bytes`}</dd></dl></section>
    <section class="evidence-group evidence-envelope"><h4>Configured resource envelope</h4><dl class="facts"><dt>CPU cap</dt><dd>${resource.cpus}</dd><dt>memory cap</dt><dd>${resource.memory_mb} MB</dd><dt>PID cap</dt><dd>${resource.pids}</dd><dt>command wall cap</dt><dd>${resource.wall_clock_seconds_per_command}s</dd><dt>output cap / stream</dt><dd>${resource.output_bytes_per_stream} bytes</dd></dl><p class="scope-note">Configured limits are an envelope, not observed consumption.</p></section>
    <section class="evidence-group evidence-costs"><h4>Cost lines</h4>${costLines}<p class="scope-note">Cost status: ${escapeHtml(costs.status)}. Values without source-backed quantities and rates remain null.</p></section>
    <section class="evidence-group evidence-outcome"><h4>Outcome facts</h4><dl class="facts outcome-facts"><dt>technical checks passed</dt><dd>${outcome.technical_checks_passed}</dd><dt>PR opened</dt><dd>${outcome.pr_opened}</dd><dt>CI</dt><dd>${evidenceValue(outcome.ci_state, 'not observed')}</dd><dt>merged</dt><dd>${outcome.merged}</dd><dt>accepted as submitted</dt><dd>${evidenceValue(outcome.accepted_as_submitted, 'not established')}</dd><dt>external cycle time</dt><dd>${durationEvidence(outcome.time_to_close_ms)}</dd><dt>released</dt><dd>${evidenceValue(outcome.released, 'not observed')}</dd><dt>deployed</dt><dd>${evidenceValue(outcome.deployed, 'not observed')}</dd><dt>business result</dt><dd>${evidenceValue(outcome.business_result_observed, 'not observed')}</dd></dl></section>
  </div>
</details>`;
}

function outcomeLabel(status) {
  return String(status).replaceAll('_', ' ').toUpperCase();
}

function redactionsLabel(redactions) {
  if (redactions.length === 0) return 'none recorded';
  return redactions.map(({ kind, count }) => `${count} ${kind}`).join(', ');
}

function receiptClass(receipt) {
  if (receipt.variant === 'own_repo_rehearsal') return 'receipt--rehearsal';
  if (receipt.variant === 'author_contribution') return 'receipt--self-run';
  if (receipt.variant === 'V') return 'receipt--verification';
  return 'receipt--declared';
}

function isTechnicalReceipt(receipt) {
  return receipt.version !== 2;
}

function hasCompleteCommandEvidence(receipt) {
  return receipt.evidence_status !== 'incomplete';
}

function receiptSectionHeading(label, page) {
  const level = page ? 'h2' : 'h3';
  return `<${level}>${escapeHtml(label)}</${level}>`;
}

function renderCodeLines(receipt, { page = false } = {}) {
  const lines = [
    receipt.code.base_commit === null ? '' : `<dt>base</dt><dd><code>${escapeHtml(receipt.code.base_commit)}</code></dd>`,
    receipt.code.recorded_patch_commit === null ? '' : `<dt>recorded patch commit</dt><dd><code>${escapeHtml(receipt.code.recorded_patch_commit)}</code><br><span>${escapeHtml(receipt.code.patch_commit_binding)}</span></dd>`,
    receipt.code.tested_tree_oid === undefined || receipt.code.tested_tree_oid === null ? '' : `<dt>verified tested tree</dt><dd><code>${escapeHtml(receipt.code.tested_tree_oid)}</code></dd>`,
    receipt.code.patch_diff_hash === null ? '' : `<dt>patch diff SHA-256</dt><dd>${isTechnicalReceipt(receipt) ? renderCopyableHash(receipt.code.patch_diff_hash, 'patch diff SHA-256') : `<code>${escapeHtml(receipt.code.patch_diff_hash)}</code>`}<br><span>${escapeHtml(receipt.code.patch_diff_binding)}</span></dd>`,
  ].filter(Boolean).join('');
  return lines.length === 0
    ? ''
    : `<section class="receipt-section">${receiptSectionHeading('Code', page)}<dl class="facts">${lines}</dl></section>`;
}

function factoryProofAttestation(receipt) {
  const publication = receipt.source?.factory_publication;
  return publication?.attestation_state === 'RECEIPT_ATTESTED' &&
    typeof publication.attestation_url === 'string'
    ? publication.attestation_url
    : null;
}

function hasRecordedAttestation(receipt) {
  return coherentAttestationEvidence(receipt) !== null || factoryProofAttestation(receipt) !== null;
}

function renderV1Overview(receipt, attestationEvidence) {
  if (!isTechnicalReceipt(receipt)) return '';
  const titleId = `technical-result-${receipt.mission_id}`;
  const publication = receipt.publication ?? null;
  const upstreamState = publication?.state
    ?? (receipt.variant === 'own_repo_rehearsal' ? 'own-repository rehearsal' : 'no upstream publication');
  const upstreamDetail = publication?.review_decision === null || publication?.review_decision === undefined
    ? (publication === null && receipt.variant === 'own_repo_rehearsal'
        ? 'rehearsal record; not external validation'
        : 'mutable external state')
    : `${outcomeLabel(publication.review_decision)} review signal`;
  const complete = hasCompleteCommandEvidence(receipt);
  const commandLabel = complete
    ? `declared command${receipt.declared_checks === 1 ? '' : 's'} passed`
    : 'structured command evidence unavailable';
  const proofAttestation = factoryProofAttestation(receipt);
  const signature = attestationEvidence !== null
    ? `<strong>verified ${renderHumanTimestamp(attestationEvidence.verifiedAt)}</strong><span>Northset signing workflow provenance</span>`
    : proofAttestation !== null
      ? `<strong>${link(proofAttestation, 'proof attested')}</strong><span>GitHub artifact attestation for the exact proof bytes</span>`
      : '<strong>not attested</strong><span>No verified signing record is present.</span>';
  return `<section class="economic-overview v1-overview" aria-labelledby="${escapeHtml(titleId)}">
  <p class="section-kicker">01 / TECHNICAL RESULT</p>
  <h2 class="visually-hidden" id="${escapeHtml(titleId)}">Technical result</h2>
  <div class="proof-hero">
    <div class="proof-result">
      <div class="proof-score">${complete ? `${receipt.successful_checks}/${receipt.declared_checks}` : '—'}</div>
      <p class="proof-statement"><strong>${escapeHtml(commandLabel)}</strong></p>
      <p>${escapeHtml(receipt.execution_summary)}</p>
    </div>
    <dl class="proof-status-rail" data-receipt-version="${receipt.version}">
      <div><dt>Upstream</dt><dd><strong>${escapeHtml(outcomeLabel(upstreamState))}</strong><span>${escapeHtml(upstreamDetail)}</span></dd></div>
      <div><dt>Environment</dt><dd><strong>${escapeHtml(receipt.environment.container_image_ref)}</strong><span>network ${escapeHtml(receipt.environment.network_policy)}</span></dd></div>
      <div><dt>Signature</dt><dd>${signature}</dd></div>
    </dl>
  </div>
</section>`;
}

function renderV1CompactIdentities(receipt, attestationEvidence, sectionNumber) {
  if (!isTechnicalReceipt(receipt)) return '';
  const fields = [
    ['Patch diff SHA-256', receipt.code.patch_diff_hash],
    ['Container image digest', receipt.environment.container_image_digest],
    ['Immutable image ID', receipt.environment.container_image_id],
    ['Bundle contents digest', receipt.bundle_digest],
    ['Signed asset SHA-256', attestationEvidence?.releaseAssetSha256 ?? null],
  ].filter(([, value]) => value !== null);
  const values = fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${renderCopyableHash(value, label)}</dd>`).join('');
  return `<section class="receipt-section compact-identities"><p class="section-kicker">${sectionNumber} / RECORDED IDENTITIES</p><h2>Compact hashes</h2><dl class="facts">${values}</dl></section>`;
}

function renderCryptographicDetail(receipt, attestationEvidence, { page = false } = {}) {
  if (!isTechnicalReceipt(receipt)) return '';
  const fields = [
    ['Patch diff SHA-256', receipt.code.patch_diff_hash],
    ['Container image digest', receipt.environment.container_image_digest],
    ['Immutable image ID', receipt.environment.container_image_id],
    ['Bundle contents digest', receipt.bundle_digest],
    ['Signed asset SHA-256', attestationEvidence?.releaseAssetSha256 ?? null],
  ].filter(([, value]) => value !== null);
  if (fields.length === 0) return '';
  const values = fields.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd><code>${escapeHtml(value)}</code><button type="button" class="copy-hash" data-copy="${escapeHtml(value)}" aria-label="Copy full ${escapeHtml(label)}">Copy</button></dd>`).join('');
  return `<section class="receipt-section cryptographic-detail">${receiptSectionHeading('Full cryptographic values', page)}<p>Full recorded values. The compact receipt above shortens these for legibility only.</p><dl class="facts">${values}</dl></section>`;
}

function renderHeadDriftDisclosure(receipt) {
  const outcome = receipt.live_outcome;
  if (outcome?.head_drift !== true || outcome.pr_head_oid === null) return '';
  return `<p class="outcome-drift"><strong>PR changed since this record.</strong> ${receipt.code.recorded_patch_commit === null ? 'No patch commit was recorded;' : `Recorded patch commit <code>${escapeHtml(receipt.code.recorded_patch_commit)}</code>;`} current PR head observed ${renderHumanTimestamp(receipt.publication.observed_at)}: <code>${escapeHtml(outcome.pr_head_oid)}</code>. The patch commit is declared source metadata, not an execution-bound identity; only the recorded patch bytes are bound to this receipt.</p>`;
}

function renderOutcomeStub(receipt) {
  if (receipt.live_outcome === null) return '';
  const outcome = receipt.live_outcome;
  const label = outcomeLabel(outcome.status);
  const state = outcome.link === null
    ? `<strong>${escapeHtml(label)}</strong><p>${escapeHtml(outcome.attribution)}; no decision link was recorded.</p>`
    : `<strong>${link(outcome.link, label, 'outcome-link')}</strong><p>${escapeHtml(outcome.attribution)} · ${link(outcome.link, 'open linked record')}</p>`;
  const drift = renderHeadDriftDisclosure(receipt);
  const facts = `<dl class="facts external-facts"><dt>PR state</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.state))}</dd><dt>Review signal</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.review_decision ?? 'none'))}</dd><dt>CI state</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.ci_state))}</dd><dt>Upstream updated</dt><dd>${renderHumanTimestamp(receipt.publication.updated_at)}</dd><dt>Observed</dt><dd>${renderHumanTimestamp(receipt.publication.observed_at)}</dd></dl>`;
  return `<section class="outcome-stub" aria-label="External status"><p class="stub-cut">- - - detach here - - -</p><h2>External status</h2><p>Mutable upstream observation; unattested and separate from the signed run record.</p>${facts}${state}${drift}</section>`;
}

function renderReceipt(receipt, { featured = false, page = false, generatedAt = null } = {}) {
  const attestationEvidence = coherentAttestationEvidence(receipt);
  const commandLines = receipt.commands.map((command) => {
    const durationLabel = formatDuration(command.duration_ms);
    const status = command.timed_out ? 'timed out' : `exit ${command.exit_code}`;
    return `<li><pre><code>${escapeHtml(command.cmd)}</code></pre><p class="command-result">${escapeHtml(status)}${durationLabel === null ? '' : ` · ${escapeHtml(durationLabel)}`}</p></li>`;
  }).join('');
  const work = [
    receipt.issue_or_task === null ? '' : link(
      receipt.issue_or_task,
      receipt.issue_title === null ? issueLabel(receipt.issue_or_task) : receipt.issue_title,
    ),
    receipt.publication?.pr_url ? link(receipt.publication.pr_url, prLabel(receipt.publication)) : '',
  ].filter(Boolean).join(' · ') || 'No issue or pull request recorded';
  const folioNumber = receipt.mission_id.match(/\d+/g)?.join('') ?? '';
  const setupDuration = receipt.version === 2 || receipt.setup_install_duration_ms === null
    ? ''
    : `<p class="duration-line">unclassified executor time (derived residual) <span>${escapeHtml(formatDuration(receipt.setup_install_duration_ms))}</span></p>`;
  const wallDuration = receipt.wall_duration_ms === null
    ? ''
    : `<p class="duration-line">run wall (derived from recorded timestamps) <span>${escapeHtml(formatDuration(receipt.wall_duration_ms))}</span></p>`;
  const completeCommandEvidence = hasCompleteCommandEvidence(receipt);
  const scopeNote = completeCommandEvidence
    ? 'Every command listed returned exit 0 in the declared environment. Only the listed commands are in scope. Unlisted test, lint, typecheck, build, coverage, compiler, full-suite, and CI gates are not implied or recorded.'
    : 'No command-level PASS is claimed. The immutable legacy proof did not record a structured executed command or verification timestamps.';
  const correction = receipt.correction_note === null
    ? ''
    : `<section class="correction">${receiptSectionHeading('Correction', page)}<p>${escapeHtml(receipt.correction_note)}</p></section>`;
  const patch = page && receipt.patch_diff !== null
    ? `<details class="patch"><summary>Committed patch.diff</summary><pre><code>${escapePreformatted(receipt.patch_diff)}</code></pre></details>`
    : '';
  const rawOutput = page
    ? [
      receipt.stdout_redacted === null
        ? ''
        : `<details class="evidence-output"><summary>Redacted stdout</summary><pre><code>${escapePreformatted(receipt.stdout_redacted)}</code></pre></details>`,
      receipt.stderr_redacted === null
        ? ''
        : `<details class="evidence-output"><summary>Redacted stderr</summary><pre><code>${escapePreformatted(receipt.stderr_redacted)}</code></pre></details>`,
    ].filter(Boolean).join('')
    : '';
  const qr = createReceiptQr(receipt.canonical_url);
  const verification = attestationEvidence === null
    ? '<p>Attestation URL was not recorded.</p>'
    : `<p>${link(attestationEvidence.attestationUri, 'Download signed bundle', 'button-link')}</p>`;
  const attestationScope = attestationEvidence === null
    ? ''
    : '<p class="attestation-scope">Attestation confirms that Northset\'s signing workflow produced this exact bundle. The signer does not witness the recorded run, and verification does not turn it into maintainer verification.</p>';
  const verifyCommand = attestationEvidence === null ? null : formatVerifyCommand(attestationEvidence.attestationUri);
  const verify = verifyCommand === null
    ? ''
    : `<div class="verify-command"><p><strong>Verify this receipt</strong></p><pre><code>${escapeHtml(verifyCommand)}</code></pre><button type="button" data-copy="${escapeHtml(verifyCommand)}">Copy verify command</button></div>`;
  const articleId = featured ? ` id="${escapeHtml(receipt.mission_id)}"` : '';
  const pageLink = page ? '' : `<p class="receipt-open">${relativeLink(`${receipt.canonical_path}`, 'Open full receipt →')}</p>`;
  const qrLink = page ? './index.html' : receipt.canonical_path;
  const folioHeadingLevel = page ? 'h1' : 'h2';
  const consent = receipt.consent_artifact === null
    ? ''
    : `<p class="consent-artifact"><strong>${receipt.variant === 'V' ? 'Maintainer consent' : 'Consent artifact'}</strong><br>${link(receipt.consent_artifact, 'Open recorded consent')}</p>`;
  const fundingDisclosure = '<p><strong>SELF-FUNDED FIELD-TESTING.</strong></p>';
  const projectSection = `<section class="receipt-section">${receiptSectionHeading('Project', page)}<p>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p>${receiptSectionHeading('Work', page)}<p>${work}</p>${receiptSectionHeading('Verification execution', page)}<p>runtime: ${escapeHtml(receipt.worker_identity.runtime)}<br>human operator: ${escapeHtml(receipt.worker_identity.human_operator)}</p></section>`;
  const environmentDigest = receipt.environment.container_image_digest;
  const environmentDigestRow = environmentDigest === null
    ? ''
    : `<dt>repository digest</dt><dd>${isTechnicalReceipt(receipt) ? renderCopyableHash(environmentDigest, 'container image digest') : `<code>${escapeHtml(environmentDigest)}</code>`}</dd>`;
  const environmentSection = `<section class="receipt-section">${receiptSectionHeading('Environment', page)}<dl class="facts"><dt>image reference</dt><dd>${escapeHtml(receipt.environment.container_image_ref)}</dd>${environmentDigestRow}${receipt.environment.container_image_id === null ? '' : `<dt>immutable image ID</dt><dd>${isTechnicalReceipt(receipt) ? renderCopyableHash(receipt.environment.container_image_id, 'immutable image ID') : `<code>${escapeHtml(receipt.environment.container_image_id)}</code>`}</dd>`}${receipt.environment.container_os === null ? '' : `<dt>platform</dt><dd>${escapeHtml(receipt.environment.container_os)}/${escapeHtml(receipt.environment.container_architecture)}</dd>`}<dt>network</dt><dd>${escapeHtml(receipt.environment.network_policy)}</dd></dl></section>`;
  const commandEvidence = receipt.commands.length === 0
    ? '<p class="evidence-unavailable">No structured executed command was recorded.</p>'
    : `<ol class="commands">${commandLines}</ol>`;
  const checksNotRun = (receipt.checks_not_run ?? []).length === 0
    ? ''
    : `<h3>Checks not run</h3><ul class="checks-not-run">${receipt.checks_not_run.map((item) => `<li><code>${escapeHtml(item.check)}</code> — ${escapeHtml(item.reason)}</li>`).join('')}</ul>`;
  const legacyChecks = (receipt.legacy_checks ?? []).length === 0
    ? ''
    : `<h3>Legacy declarations</h3><p class="scope-note">Preserved verbatim from the immutable proof; not interpreted as executed command evidence.</p><ul class="legacy-checks">${receipt.legacy_checks.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul>`;
  const checksBody = `<p><strong>Execution summary</strong><br>${escapeHtml(receipt.execution_summary)}</p>${commandEvidence}${checksNotRun}${legacyChecks}${setupDuration}${wallDuration}${receipt.version === 2 ? `<p class="total">${escapeHtml(receipt.result)}</p>` : ''}<p class="scope-note">${escapeHtml(scopeNote)}</p>`;
  const checksSection = `<section class="receipt-section proof-scope">${receiptSectionHeading('Declared checks', page)}${checksBody}</section>`;
  const signedAssetHash = attestationEvidence?.releaseAssetSha256 ?? 'not recorded';
  const bundleDigest = receipt.bundle_digest === null
    ? '<span class="evidence-unavailable">not recorded; raw proof identity is listed below</span>'
    : isTechnicalReceipt(receipt)
      ? renderCopyableHash(receipt.bundle_digest, 'bundle contents digest')
      : `<code>${escapeHtml(receipt.bundle_digest)}</code>`;
  const rawProof = receipt.source === undefined
    ? ''
    : `<dt>Immutable raw proof</dt><dd>${link(receipt.source.raw_proof_url, 'inspect source proof')}</dd><dt>Raw proof SHA-256</dt><dd>${renderCopyableHash(receipt.source.proof_sha256, 'raw proof SHA-256')}</dd>${receipt.source.raw_publication_url === undefined ? '' : `<dt>Publication observation</dt><dd>${link(receipt.source.raw_publication_url, 'inspect source publication status')}</dd>`}${receipt.source.factory_publication === undefined ? '' : `<dt>Factory PR state</dt><dd>${escapeHtml(receipt.source.factory_publication.pr_state)}</dd><dt>Factory CI state</dt><dd>${escapeHtml(receipt.source.factory_publication.ci_state ?? 'not observed')}</dd><dt>Factory attestation state</dt><dd>${escapeHtml(receipt.source.factory_publication.attestation_state)}</dd><dt>Factory status observed</dt><dd>${renderHumanTimestamp(receipt.source.factory_publication.observed_at)}</dd>`}`;
  const recordSection = `<section class="receipt-section">${receiptSectionHeading('Record details', page)}<dl class="facts"><dt>payment</dt><dd>${escapeHtml(receipt.payment.maintainer_payment)} · ${receipt.payment.merge_contingent ? 'merge-contingent' : 'not merge-contingent'}</dd><dt>redactions</dt><dd>${escapeHtml(redactionsLabel(receipt.redactions))}</dd><dt>Bundle contents digest</dt><dd>${bundleDigest}</dd>${rawProof}<dt>Signed asset SHA-256</dt><dd>${isTechnicalReceipt(receipt) ? renderCopyableHash(signedAssetHash, 'signed asset SHA-256') : `<code>${escapeHtml(signedAssetHash)}</code>`}</dd><dt>Signed provenance recorded</dt><dd>${attestationEvidence === null ? 'not verified' : `verified ${renderHumanTimestamp(attestationEvidence.verifiedAt)}`}</dd></dl></section>`;
  const limitations = isTechnicalReceipt(receipt) && receipt.scope_note !== null
    ? receipt.limitations.filter((item) => item !== receipt.scope_note)
    : receipt.limitations;
  const limitationsSection = `<section class="receipt-section limitations">${receiptSectionHeading('NOT INCLUDED', page)}<ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
  const signedSection = `<section class="receipt-section verification">${receiptSectionHeading('Signed bundle', page)}${verification}${verify}${attestationScope}<a class="qr-link" href="${escapeHtml(qrLink)}" aria-label="Canonical receipt page for ${escapeHtml(receipt.mission_id)}">${qr.svg}<span>QR → receipt page</span></a></section>`;
  const generatedProvenance = generatedAt === null
    ? ''
    : `<dt>Generated at</dt><dd><time datetime="${escapeHtml(generatedAt)}">${escapeHtml(generatedAt)}</time></dd>`;
  const receiptProvenance = `<footer class="receipt-provenance"><p>RECEIPT PROVENANCE</p><dl class="facts"><dt>Canonical receipt</dt><dd>${link(receipt.canonical_url, receipt.canonical_url)}</dd>${generatedProvenance}</dl></footer>`;
  const publicScopeInterpretation = receipt.scope_note === null
    ? ''
    : `<section class="receipt-section public-scope-interpretation">${receiptSectionHeading('Public scope interpretation', page)}<p>${escapeHtml(receipt.scope_note)}</p></section>`;
  const technicalChapter = `<details class="annex-chapter annex-technical"><summary class="annex-heading"><span>02</span><div><p>Technical evidence</p><small>Code, environment, exact commands, patch, and outputs</small></div></summary><div class="drawer-body">${projectSection}${renderCodeLines(receipt, { page })}${environmentSection}${checksSection}${publicScopeInterpretation}${patch}${rawOutput}</div></details>`;
  const provenanceChapter = `<details class="annex-chapter annex-provenance"><summary class="annex-heading"><span>03</span><div><p>Provenance &amp; limitations</p><small>Bundle identity, attestation, verification, and claims boundary</small></div></summary><div class="drawer-body">${recordSection}${limitationsSection}${correction}${signedSection}${receiptProvenance}</div></details>`;
  let v1Visible = '';
  let evidence;
  if (receipt.version === 2) {
    evidence = `<details class="evidence-drawer evidence-annex"><summary><span>Evidence annex</span><small>Economic · technical · provenance · limitations</small></summary><div class="annex-body">${renderEconomicEvidence(receipt)}${technicalChapter}${provenanceChapter}</div></details>`;
  } else {
    let nextSection = 2;
    const sectionNumber = () => String(nextSection++).padStart(2, '0');
    const declaredChecks = `<section class="receipt-section proof-scope"><p class="section-kicker">${sectionNumber()} / DECLARED CHECKS</p>${receiptSectionHeading('Command evidence', page)}${checksBody}</section>`;
    const compactIdentities = renderV1CompactIdentities(receipt, attestationEvidence, sectionNumber());
    const publicScope = receipt.scope_note === null
      ? ''
      : `<section class="receipt-section public-scope-interpretation"><p class="section-kicker">${sectionNumber()} / PUBLIC SCOPE INTERPRETATION</p>${receiptSectionHeading('Public scope interpretation', page)}<p>${escapeHtml(receipt.scope_note)}</p></section>`;
    const visibleLimitations = `<section class="receipt-section limitations"><p class="section-kicker">${sectionNumber()} / CLAIMS BOUNDARY</p>${receiptSectionHeading('NOT INCLUDED', page)}<ul>${limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
    const visibleCorrection = receipt.correction_note === null
      ? ''
      : `<section class="correction"><p class="section-kicker">${sectionNumber()} / CORRECTION</p>${receiptSectionHeading('Correction', page)}<p>${escapeHtml(receipt.correction_note)}</p></section>`;
    const annexNumber = sectionNumber();
    const v1TechnicalChapter = `<details class="annex-chapter annex-technical"><summary class="annex-heading"><span>01</span><div><p>Technical evidence</p><small>Code, full environment, patch, and redacted outputs</small></div></summary><div class="drawer-body">${projectSection}${renderCodeLines(receipt, { page })}${environmentSection}${patch}${rawOutput}</div></details>`;
    const v1ProvenanceChapter = `<details class="annex-chapter annex-provenance"><summary class="annex-heading"><span>02</span><div><p>Provenance &amp; record</p><small>Full hashes, bundle identity, attestation, and record details</small></div></summary><div class="drawer-body">${recordSection}${renderCryptographicDetail(receipt, attestationEvidence, { page })}${signedSection}${receiptProvenance}</div></details>`;
    v1Visible = `${declaredChecks}${compactIdentities}${publicScope}${visibleLimitations}${visibleCorrection}`;
    evidence = `<details class="evidence-drawer evidence-annex evidence-annex--v1"><summary><span>${annexNumber} / Evidence annex</span><small>Technical · provenance · full recorded values</small></summary><div class="annex-body">${v1TechnicalChapter}${v1ProvenanceChapter}</div></details>`;
  }
  const receiptHeader = `<header class="receipt-head">
    <span class="folio-watermark" aria-hidden="true">${escapeHtml(folioNumber)}</span>
    <div class="folio-title"><p class="brand">NORTHSET</p><${folioHeadingLevel}>${completeCommandEvidence ? 'Proof-of-Pass Receipt' : 'Receipt Evidence Record'}</${folioHeadingLevel}><p class="folio-receipt-id"><span>Receipt ID</span> <code>${escapeHtml(receipt.mission_id)}</code></p></div>
    <p class="folio-work"><span>ISSUE / WORK</span>${work}</p>
    <p class="class-stamp">${escapeHtml(receipt.classification)}</p>
    ${consent}
    <p class="run-interval"><span>RUN</span>${renderRunInterval(receipt.started_at, receipt.finished_at, receipt.wall_duration_ms)}</p>
  </header>`;
  return `<article class="receipt ${receiptClass(receipt)} receipt--economic${isTechnicalReceipt(receipt) ? ' receipt--v1' : ''}${featured ? ' receipt--featured' : ''}"${articleId}>
  ${receiptHeader}
  ${renderV1Overview(receipt, attestationEvidence)}
  ${renderEconomicOverview(receipt)}
  ${v1Visible}
  ${evidence}
  ${receipt.version === 2 ? renderHeadDriftDisclosure(receipt) : ''}
  <footer class="receipt-disclosure"><strong>${escapeHtml(receipt.disclosure_label)}</strong><p>${completeCommandEvidence ? 'Evidence of what ran — not a verdict that the code is good.' : 'Legacy evidence is incomplete — no command-level PASS is claimed.'}</p>${fundingDisclosure}</footer>
  ${pageLink}
</article>${receipt.version === 2 ? '' : renderOutcomeStub(receipt)}`.replaceAll(/^[ \t]+$/gm, '');
}

function renderFeaturedStub(receipt) {
  const attestationEvidence = coherentAttestationEvidence(receipt);
  const qr = createReceiptQr(receipt.canonical_url);
  const work = [
    receipt.issue_or_task === null ? '' : link(receipt.issue_or_task, issueLabel(receipt.issue_or_task)),
    receipt.publication?.pr_url ? link(receipt.publication.pr_url, prLabel(receipt.publication)) : '',
  ].filter(Boolean).join(' · ') || 'No issue or pull request recorded';
  const signedProvenance = attestationEvidence === null
    ? 'Signed provenance not recorded.'
    : `Signed provenance verified ${renderHumanTimestamp(attestationEvidence.verifiedAt)}; the signer does not witness the recorded run, and this remains not maintainer verification.`;
  return `<article class="receipt featured-stub ${receiptClass(receipt)}" id="${escapeHtml(receipt.mission_id)}" aria-labelledby="featured-stub-title">
  <header class="receipt-head featured-stub-head">
    <div><p class="brand">NORTHSET</p><h3 id="featured-stub-title">Proof-of-Pass Receipt</h3><p class="featured-receipt-id">Receipt ${escapeHtml(receipt.mission_id)}</p></div>
    <p class="class-stamp">${escapeHtml(receipt.classification)}</p>
  </header>
  <section class="featured-work" aria-label="Repository and work"><p class="featured-repo"><span>Repository</span>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p><p class="featured-work-links"><span>Work</span>${work}</p></section>
  <section class="featured-verdict" aria-label="Scoped technical result"><p class="featured-result">${escapeHtml(receipt.result)}</p><p>${escapeHtml(receipt.execution_summary)}</p></section>
  <dl class="featured-facts"><div><dt>Recorded run</dt><dd>${renderRunInterval(receipt.started_at, receipt.finished_at, receipt.wall_duration_ms)}</dd></div><div><dt>Environment</dt><dd>${escapeHtml(receipt.environment.container_image_ref)} · network ${escapeHtml(receipt.environment.network_policy)}</dd></div><div><dt>Bundle digest</dt><dd>${renderCopyableHash(receipt.bundle_digest, 'bundle contents digest')}</dd></div></dl>
  <p class="featured-provenance">${signedProvenance}</p>
  <div class="featured-finish"><a class="featured-qr" href="${escapeHtml(receipt.canonical_path)}" aria-label="Canonical receipt page for ${escapeHtml(receipt.mission_id)}">${qr.svg}<span>Canonical receipt</span></a>${relativeLink(receipt.canonical_path, 'Unfold the full receipt →', 'unfold-link')}</div>
  <footer class="featured-disclosure"><strong>${escapeHtml(receipt.disclosure_label)}</strong><p>Evidence of what ran — not a verdict that the code is good.</p><p><strong>SELF-FUNDED FIELD-TESTING.</strong></p></footer>
</article>`.replaceAll(/^[ \t]+$/gm, '');
}

function renderPreview(receipt, {
  includeAnchor = true,
  sitePrefix = '',
  showRepositoryLink = true,
  repositorySlugs = null,
} = {}) {
  const attestation = hasRecordedAttestation(receipt) ? 'recorded' : 'not recorded';
  const anchor = includeAnchor ? ` id="${escapeHtml(receipt.mission_id)}"` : '';
  const labelId = `preview-title-${receipt.mission_id}`;
  const publicationState = receipt.publication?.state ?? 'unpublished';
  const reviewDecision = receipt.publication?.review_decision ?? 'none';
  const statusTone = reviewDecision === 'changes_requested'
    ? 'changes-requested'
    : publicationState === 'merged'
      ? 'merged'
      : publicationState === 'closed_unmerged'
        ? 'closed'
        : 'open';
  const statusLabel = statusTone === 'changes-requested'
    ? 'Changes requested'
    : publicationState === 'merged'
      ? 'Merged upstream'
      : publicationState === 'closed_unmerged'
        ? 'Closed unmerged'
        : reviewDecision === 'approved'
          ? 'Open · approved review'
          : publicationState === 'open'
            ? 'Open · awaiting review'
            : outcomeLabel(publicationState);
  const workLabel = receipt.issue_title ?? (receipt.issue_or_task === null ? 'No issue or task recorded' : issueLabel(receipt.issue_or_task));
  const work = receipt.issue_or_task === null ? escapeHtml(workLabel) : link(receipt.issue_or_task, workLabel);
  const drift = receipt.publication?.head_drift === true
    ? `<p class="preview-outcome"><strong>PR changed since this record.</strong> ${receipt.code.recorded_patch_commit === null ? 'No patch commit was recorded;' : `recorded patch commit <code>${escapeHtml(receipt.code.recorded_patch_commit)}</code>;`} current PR head <code>${escapeHtml(receipt.publication.pr_head_oid)}</code>. The current head is mutable external status and was not executed by this record.</p>`
    : '';
  const repository = repositoryIdentity(receipt.target_repo);
  const repositoryLink = showRepositoryLink && repository !== null
    && (repositorySlugs === null || repositorySlugs.has(repository.slug))
    ? `<p class="preview-repo-ledger">${relativeLink(`${sitePrefix}repo/${repository.slug}/`, `All Northset work in ${repository.label} →`)}</p>`
    : '';
  return `<article class="receipt-preview ${receiptClass(receipt)}"${anchor} aria-labelledby="${escapeHtml(labelId)}" data-publication-state="${escapeHtml(publicationState)}" data-review-decision="${escapeHtml(reviewDecision)}" data-status-tone="${escapeHtml(statusTone)}">
  <p class="preview-id">Receipt ${escapeHtml(receipt.mission_id)}</p>
  <h3 id="${escapeHtml(labelId)}" class="preview-repo">${link(receipt.target_repo, repoLabel(receipt.target_repo))}</h3>
  <p class="preview-work"><span>Work</span>${work}</p>
  <p class="preview-status"><strong>${escapeHtml(statusLabel)}</strong></p>
  <p class="preview-result">${escapeHtml(receipt.result)}</p>
  <p class="preview-state-detail">PR state: ${escapeHtml(outcomeLabel(publicationState))} · Review signal: ${escapeHtml(outcomeLabel(reviewDecision))}</p>
  <p class="preview-scope">Command evidence and NOT INCLUDED are on the full receipt.</p>
  <p class="preview-attestation">attestation: ${attestation}</p>
  <p class="preview-class">${escapeHtml(receipt.classification)}</p>
  ${drift}
  ${relativeLink(`${sitePrefix}${receipt.canonical_path}`, 'Open receipt →', 'preview-link')}
  ${repositoryLink}
</article>`.replaceAll(/^[ \t]+$/gm, '');
}

function renderNorthsetWordmark() {
  return `<svg class="northset-wordmark" role="img" aria-label="NORTHSET" viewBox="0 18.35 475 96">
  <g transform="translate(-11.52,10.89) scale(1.075)"><g transform="translate(5.24,-0.04)"><rect x="18.5" y="26.0" width="11.0" height="56.0" fill="currentColor"/><polygon points="26.6,26.0 29.4,26.0 56.79,62.82 74.03,20.0 85.97,20.0 59.4,83.0 19.64,31.36" fill="currentColor"/></g></g><g transform="translate(110.18,99.0)"><path d="M5.93 0V-60.2H25.71L39.9 -6.97H41.28V-60.2H51.51V0H31.82L17.63 -53.23H16.17V0Z M81.25 1.2Q74.89 1.2 69.85 -1.42Q64.82 -4.04 61.94 -8.9Q59.06 -13.76 59.06 -20.55V-21.93Q59.06 -28.72 61.94 -33.63Q64.82 -38.53 69.85 -41.11Q74.89 -43.69 81.25 -43.69Q87.61 -43.69 92.6 -41.11Q97.59 -38.53 100.47 -33.63Q103.35 -28.72 103.35 -21.93V-20.55Q103.35 -13.76 100.47 -8.9Q97.59 -4.04 92.6 -1.42Q87.61 1.2 81.25 1.2ZM81.25 -7.57Q86.67 -7.57 90.11 -11.05Q93.55 -14.53 93.55 -20.81V-21.67Q93.55 -27.95 90.11 -31.43Q86.67 -34.92 81.25 -34.92Q75.83 -34.92 72.39 -31.43Q68.95 -27.95 68.95 -21.67V-20.81Q68.95 -14.53 72.39 -11.05Q75.83 -7.57 81.25 -7.57Z M111.24 0V-42.48H120.96V-37.58H122.42Q123.37 -40.25 125.61 -41.45Q127.84 -42.66 130.94 -42.66H136.1V-33.88H130.77Q126.47 -33.88 123.8 -31.6Q121.13 -29.33 121.13 -24.6V0Z M158.44 0Q154.31 0 151.86 -2.45Q149.41 -4.9 149.41 -9.12V-34.31H138.31V-42.48H149.41V-56.16H159.3V-42.48H171.51V-34.31H159.3V-10.75Q159.3 -8.17 161.71 -8.17H170.22V0Z M178.97 0V-60.2H188.86V-36.89H190.32Q191.01 -38.36 192.56 -39.82Q194.11 -41.28 196.64 -42.23Q199.18 -43.17 203.05 -43.17Q207.95 -43.17 211.74 -40.98Q215.52 -38.79 217.63 -34.83Q219.74 -30.87 219.74 -25.46V0H209.85V-24.68Q209.85 -29.84 207.31 -32.38Q204.77 -34.92 200.13 -34.92Q194.88 -34.92 191.87 -31.43Q188.86 -27.95 188.86 -21.5V0Z M246.81 1.2Q238.55 1.2 233.22 -2.41Q227.89 -6.02 226.77 -12.99L235.88 -15.31Q236.49 -12.04 238.03 -10.15Q239.58 -8.26 241.86 -7.48Q244.14 -6.71 246.81 -6.71Q250.85 -6.71 252.87 -8.17Q254.89 -9.63 254.89 -11.87Q254.89 -14.19 252.95 -15.31Q251.02 -16.43 247.06 -17.2L244.4 -17.63Q240.01 -18.49 236.4 -19.99Q232.79 -21.5 230.59 -24.12Q228.4 -26.75 228.4 -30.79Q228.4 -36.98 233 -40.33Q237.6 -43.69 245.09 -43.69Q252.22 -43.69 256.87 -40.51Q261.51 -37.32 262.89 -31.99L253.77 -29.24Q253.08 -32.85 250.76 -34.36Q248.44 -35.86 245.09 -35.86Q241.65 -35.86 239.8 -34.66Q237.95 -33.45 237.95 -31.22Q237.95 -28.98 239.84 -27.86Q241.73 -26.75 244.91 -26.23L247.58 -25.71Q252.31 -24.85 256.14 -23.48Q259.96 -22.1 262.2 -19.52Q264.44 -16.94 264.44 -12.56Q264.44 -5.93 259.66 -2.36Q254.89 1.2 246.81 1.2Z M291.25 1.2Q284.88 1.2 280.02 -1.5Q275.17 -4.21 272.46 -9.16Q269.75 -14.1 269.75 -20.73V-21.76Q269.75 -28.47 272.41 -33.37Q275.08 -38.27 279.9 -40.98Q284.71 -43.69 290.99 -43.69Q297.18 -43.69 301.83 -40.98Q306.47 -38.27 309.05 -33.37Q311.63 -28.47 311.63 -21.93V-18.4H279.72Q279.9 -13.42 283.25 -10.41Q286.6 -7.4 291.51 -7.4Q296.32 -7.4 298.64 -9.5Q300.97 -11.61 302.17 -14.28L310.34 -10.06Q309.14 -7.74 306.86 -5.12Q304.58 -2.49 300.79 -0.64Q297.01 1.2 291.25 1.2ZM279.81 -25.89H301.57Q301.22 -30.1 298.34 -32.59Q295.46 -35.09 290.9 -35.09Q286.17 -35.09 283.34 -32.59Q280.5 -30.1 279.81 -25.89Z M333.88 0Q329.76 0 327.3 -2.45Q324.85 -4.9 324.85 -9.12V-34.31H313.76V-42.48H324.85V-56.16H334.74V-42.48H346.96V-34.31H334.74V-10.75Q334.74 -8.17 337.15 -8.17H345.67V0Z" fill="currentColor"/></g>
</svg>`;
}

function presentationCounts(receipts) {
  const externalReceipts = receipts.filter((receipt) => receipt.variant !== 'own_repo_rehearsal');
  return {
    external: externalReceipts.length,
    attested: externalReceipts.filter(hasRecordedAttestation).length,
    repositories: new Set(externalReceipts.map((receipt) => receipt.target_repo).filter((value) => value !== null)).size,
    merged: externalReceipts.filter((receipt) => receipt.publication?.state === 'merged').length,
    closed: externalReceipts.filter((receipt) => receipt.publication?.state === 'closed_unmerged').length,
    open: externalReceipts.filter((receipt) => receipt.publication?.state === 'open').length,
    changesRequested: externalReceipts.filter((receipt) => receipt.publication?.review_decision === 'changes_requested').length,
  };
}

function renderVerifyFirst(receipt) {
  const evidence = coherentAttestationEvidence(receipt);
  const command = evidence === null ? null : formatVerifyCommand(evidence.attestationUri);
  if (typeof command !== 'string' || command.length === 0) {
    return `<section class="verify-first" aria-labelledby="verify-first-title"><h2 id="verify-first-title">Check this receipt without trusting this site</h2><p>A copy-paste attestation command is unavailable because signed provenance has not been recorded for this receipt.</p></section>`;
  }
  return `<section class="verify-first" aria-labelledby="verify-first-title"><h2 id="verify-first-title">Check this receipt without trusting this site</h2><pre><code>${escapeHtml(command)}</code></pre><button type="button" data-copy="${escapeHtml(command)}">Copy verify command</button><p>Expected output includes <code>Verification succeeded!</code></p></section>`;
}

function renderSocialMeta({ title, description, canonicalUrl, imageUrl }) {
  return `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">`;
}

function ogImageUrl(name) {
  return new URL(`og/${name}.png`, SITE_BASE_URL).href;
}

function receiptSocialDescription(receipt) {
  if (!hasCompleteCommandEvidence(receipt)) {
    return 'Legacy factory evidence is incomplete: no structured executed command or verification timestamps were recorded. No public PASS is claimed.';
  }
  return `${receipt.successful_checks}/${receipt.declared_checks} declared command${receipt.declared_checks === 1 ? '' : 's'} returned exit 0 in the recorded environment. Not maintainer verification.`;
}

function truncateOgText(value, maximumCharacters) {
  const characters = Array.from(String(value));
  if (characters.length <= maximumCharacters) return characters.join('');
  return `${characters.slice(0, maximumCharacters - 1).join('')}…`;
}

function renderReceiptOgSvg(receipt) {
  const repository = truncateOgText(repoLabel(receipt.target_repo), 40);
  const complete = hasCompleteCommandEvidence(receipt);
  const commandLabel = complete
    ? `declared command${receipt.declared_checks === 1 ? '' : 's'} passed`
    : 'structured evidence incomplete';
  const receiptTitle = complete ? 'Proof-of-Pass Receipt' : 'Receipt Evidence Record';
  const upstream = receipt.publication?.state ?? null;
  const classificationSize = Array.from(receipt.classification).length > 48 ? 22 : 25;
  const upstreamChip = upstream === null
    ? ''
    : `<rect x="836" y="83" width="258" height="48" fill="#d9f0e4" stroke="#0b6849"/><text x="965" y="114" text-anchor="middle" class="chip">${escapeHtml(outcomeLabel(upstream))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="og-title og-description">
  <title id="og-title">${escapeHtml(receipt.mission_id)} ${receiptTitle}</title>
  <desc id="og-description">${escapeHtml(receiptSocialDescription(receipt))}</desc>
  <style>
    text { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#182323; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
    .brand { font-size:23px; font-weight:800; letter-spacing:8px; fill:#0b6849; }
    .receipt-label { font-size:33px; font-weight:760; letter-spacing:-1px; }
    .receipt-id { font-size:20px; font-weight:700; fill:#45534c; }
    .kicker { font-size:17px; font-weight:800; letter-spacing:2px; fill:#526159; }
    .repository { font-size:48px; font-weight:800; letter-spacing:-2px; }
    .score { font-size:89px; font-weight:850; letter-spacing:-7px; fill:#07583e; }
    .verdict { font-size:29px; font-weight:780; fill:#15382d; }
    .class-stamp { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; font-weight:800; letter-spacing:.5px; fill:#33483f; }
    .chip { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; font-size:18px; font-weight:850; fill:#07583e; }
  </style>
  <rect width="1200" height="630" fill="#182323"/>
  <rect x="54" y="38" width="1092" height="554" fill="#faf7ef" stroke="#0b6849" stroke-width="4"/>
  <rect x="74" y="58" width="1052" height="514" fill="none" stroke="#9eaaa1"/>
  <text x="104" y="112" class="brand">NORTHSET</text>
  <text x="104" y="158" class="receipt-label">${receiptTitle}</text>
  <text x="104" y="190" class="receipt-id mono">RECEIPT ID · ${escapeHtml(receipt.mission_id)}</text>
  ${upstreamChip}
  <line x1="104" y1="218" x2="1094" y2="218" stroke="#9eaaa1"/>
  <text x="104" y="259" class="kicker mono">REPOSITORY</text>
  <text x="104" y="313" class="repository">${escapeHtml(repository)}</text>
  <text x="104" y="409" class="score mono">${complete ? `${receipt.successful_checks}/${receipt.declared_checks}` : '—'}</text>
  <text x="322" y="398" class="verdict">${escapeHtml(commandLabel)}</text>
  <rect x="104" y="472" width="990" height="59" fill="none" stroke="#526159" stroke-width="2"/>
  <text x="125" y="510" class="class-stamp" font-size="${classificationSize}px">${escapeHtml(receipt.classification)}</text>
  <text x="104" y="558" class="receipt-id mono">EVIDENCE OF WHAT RAN · NOT A CODE-QUALITY VERDICT</text>
</svg>
`;
}

function renderHomepageOgSvg(index) {
  const receipts = index.missions.map((mission) => mission.receipt);
  const counts = presentationCounts(receipts);
  const stats = [
    [counts.external, 'EXTERNAL RECEIPTS'],
    [counts.merged, 'MERGED UPSTREAM'],
    [counts.repositories, 'DISTINCT REPOSITORIES'],
    [counts.attested, 'ATTESTED'],
  ];
  const renderedStats = stats.map(([value, label], indexPosition) => {
    const x = 111 + (indexPosition * 258);
    return `<g transform="translate(${x} 0)"><text x="0" y="426" class="stat-value mono">${value}</text><text x="0" y="463" class="stat-label mono">${label}</text></g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="og-title og-description">
  <title id="og-title">Northset Proof-of-Pass Receipts</title>
  <desc id="og-description">Ledger headline statistics for scoped proof-of-pass receipts.</desc>
  <style>
    text { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; fill:#182323; }
    .mono { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
    .brand { font-size:28px; font-weight:850; letter-spacing:10px; fill:#0b6849; }
    .title { font-size:67px; font-weight:850; letter-spacing:-3px; }
    .lede { font-size:24px; font-weight:600; fill:#45534c; }
    .stat-value { font-size:66px; font-weight:850; letter-spacing:-5px; fill:#07583e; }
    .stat-label { font-size:16px; font-weight:850; letter-spacing:1px; fill:#45534c; }
    .generated { font-size:18px; font-weight:700; fill:#526159; }
  </style>
  <rect width="1200" height="630" fill="#182323"/>
  <rect x="54" y="38" width="1092" height="554" fill="#faf7ef" stroke="#0b6849" stroke-width="4"/>
  <rect x="74" y="58" width="1052" height="514" fill="none" stroke="#9eaaa1"/>
  <text x="106" y="126" class="brand">NORTHSET</text>
  <text x="104" y="222" class="title">Proof-of-Pass Receipts</text>
  <text x="106" y="270" class="lede">Scoped command evidence · named code · named environment</text>
  <line x1="104" y1="323" x2="1094" y2="323" stroke="#9eaaa1"/>
  ${renderedStats}
  <text x="106" y="548" class="generated mono">LEDGER GENERATED ${escapeHtml(formatHumanDate(index.generated_at).toUpperCase())} · EVIDENCE, NOT A CODE-QUALITY VERDICT</text>
</svg>
`;
}

function renderLedgerHtml(index) {
  const receipts = index.missions.map((mission) => mission.receipt);
  const repositorySlugs = new Set(repositoryReceiptGroups(receipts).keys());
  const byRecency = (left, right) => {
    const leftTime = left.finished_at ?? '';
    const rightTime = right.finished_at ?? '';
    return rightTime.localeCompare(leftTime) || left.mission_id.localeCompare(right.mission_id);
  };
  const externalReceipts = receipts
    .filter((receipt) => receipt.variant !== 'own_repo_rehearsal')
    .sort(byRecency);
  const rehearsals = receipts
    .filter((receipt) => receipt.variant === 'own_repo_rehearsal')
    .sort(byRecency);
  const featured = receipts.find((receipt) => receipt.mission_id === 'M-008') ?? null;
  const counts = presentationCounts(receipts);
  const externalPreviews = externalReceipts.map((receipt) => renderPreview(receipt, {
    includeAnchor: receipt.mission_id !== 'M-008', repositorySlugs,
  })).join('');
  const rehearsalPreviews = rehearsals.map((receipt) => renderPreview(receipt, { repositorySlugs })).join('');
  const hero = featured === null
    ? '<p class="hero-missing">No committed M-008 receipt is available.</p>'
    : renderFeaturedStub(featured);
  const heroNotes = '<ol class="hero-notes" aria-label="How to read the featured receipt"><li class="hero-note"><strong>Declared commands</strong><span>Exact command evidence unfolds on the canonical receipt.</span></li><li class="hero-note"><strong>Recorded environment</strong><span>Image, digest, and network policy remain named.</span></li><li class="hero-note"><strong>Separate outcome</strong><span>Later upstream decisions stay detached from run evidence.</span></li></ol>';
  const generatedLabel = formatHumanDate(index.generated_at);
  return renderDocument({
    title: 'Northset Proof-of-Pass Receipts',
    headExtras: renderSocialMeta({
      title: 'Northset Proof-of-Pass Receipts',
      description: 'Proof-of-pass receipts record which declared commands returned exit 0 in named environments. Not a code-quality verdict.',
      canonicalUrl: SITE_BASE_URL,
      imageUrl: ogImageUrl('index'),
    }),
    body: `<main>
  <header class="mast"><a class="northset-brand" href="https://northset.ai">${renderNorthsetWordmark()}</a><p class="northset-domain"><a href="https://northset.ai">northset.ai</a></p><h1>Proof-of-Pass Receipts</h1><p>Proof-of-pass receipts for open-source work record exactly which declared commands returned exit 0, on named code and in a named environment. Each receipt is scoped evidence, not a verdict on code quality or maintainer approval.</p><p class="mast-cta"><a class="button-link mast-request request-primary" href="${escapeHtml(PUBLIC_RUN_REQUEST_URL)}">Open a public request</a><a class="button-link request-secondary" href="${escapeHtml(requestRunMailto())}">Email a private request</a></p></header>
  <nav class="hero-stats" aria-label="Ledger headline statistics"><a href="#receipt-gallery" data-select-filter="all"><strong>${counts.external}</strong><span>External receipts</span></a><a href="#receipt-gallery" data-select-filter="merged"><strong>${counts.merged}</strong><span>Merged upstream</span></a><a href="#receipt-gallery"><strong>${counts.repositories}</strong><span>Distinct repositories</span></a><a href="#receipt-gallery"><strong>${counts.attested}</strong><span>Attested</span></a></nav>
  <p class="ci-agreement-stat">Where maintainers ran upstream CI on a receipt head, it agreed with the receipt in <strong>${index.ci_agreement.agreed} of ${index.ci_agreement.total}</strong> runs.</p>
  <section class="hero"><div class="hero-intro"><p class="eyebrow">FEATURED RECEIPT</p><h2>One real receipt, readable top to bottom.</h2>${heroNotes}</div>${hero}</section>
  <section class="external-status" aria-label="External status"><h2>External status</h2><p>Pull-request state and review signals are mutable upstream observations, recorded at each publication envelope's observed time. They are unattested metadata and are separate from the signed run bundle.</p></section>
  <section class="gallery" aria-labelledby="receipt-gallery"><div class="gallery-head"><div><p class="eyebrow">EXTERNAL RECEIPTS</p><h2 id="receipt-gallery">Find a receipt</h2></div><div class="filters" aria-label="Filter external receipt previews"><button type="button" data-filter="all" aria-pressed="true">All (${counts.external})</button><button type="button" data-filter="merged">Merged (${counts.merged})</button><button type="button" data-filter="open">Open (${counts.open})</button><button type="button" data-filter="closed_unmerged">Closed (${counts.closed})</button><button type="button" data-filter="changes_requested">Changes requested (${counts.changesRequested})</button></div></div><noscript><p class="noscript">All external receipt previews are shown. Filters are optional.</p></noscript><div class="preview-grid external-receipts">${externalPreviews}</div></section>
  <details class="rehearsal-archive"><summary>Own-repository rehearsal archive (${rehearsals.length})</summary><p>Rehearsals exercise the receipt system. They are not external validation.</p><div class="preview-grid">${rehearsalPreviews}</div></details>
  ${renderRequestRunCta()}
  ${renderDiscrepancyPledge()}
  <section class="claims"><p class="eyebrow">CLAIMS BOUNDARY</p><h2>What a receipt does and does not say</h2><p>A complete proof-of-pass receipt reports the exact declared commands, their recorded exit status, and the recorded execution environment from immutable evidence. Migrated legacy records that lack structured command evidence are marked incomplete and do not claim PASS.</p><p>It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Live upstream outcomes are detached because a later maintainer decision is a different fact from the recorded run. Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section>
  <footer class="site-footer"><span class="footer-generated">Ledger generated <time datetime="${escapeHtml(index.generated_at)}">${escapeHtml(generatedLabel)}</time>.</span> <strong>SELF-FUNDED FIELD-TESTING.</strong> A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment. Maintainer outcome is reported separately and remains fully outside Northset’s control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>. Machine-readable: <a href="ledger.json">ledger.json</a> · <a href="schema/ledger.schema.json">JSON Schemas</a>. <a class="footer-request" href="${escapeHtml(requestRunMailto())}">Request a private run</a>.</footer>
</main>`,
  });
}

function renderReceiptPage(receipt, generatedAt, repositorySlugs) {
  const pageActions = '<div class="page-actions"><a href="../../index.html">← Receipts</a><span class="page-action-buttons"><a class="button-link" href="receipt.json" download aria-label="Download receipt.json">JSON</a><button type="button" data-print aria-label="Print / Save receipt">Print / Save</button></span></div>';
  const receiptTitle = hasCompleteCommandEvidence(receipt) ? 'Proof-of-Pass Receipt' : 'Receipt Evidence Record';
  const claimsDescription = hasCompleteCommandEvidence(receipt)
    ? 'This page reports scoped proof-of-pass receipt evidence.'
    : 'This page preserves incomplete legacy factory evidence and does not claim a command-level PASS.';
  const socialTitle = `${receipt.mission_id} ${receiptTitle} · ${repoLabel(receipt.target_repo)}`;
  const repository = repositoryIdentity(receipt.target_repo);
  const repositoryLink = repository === null || !repositorySlugs.has(repository.slug)
    ? ''
    : `<p class="repository-ledger-nav">${relativeLink(`../../repo/${repository.slug}/`, `All Northset work in ${repository.label} →`, 'repository-ledger-link')}</p>`;
  return renderDocument({
    title: `${receipt.mission_id} ${receiptTitle}`,
    headExtras: renderSocialMeta({
      title: socialTitle,
      description: receiptSocialDescription(receipt),
      canonicalUrl: receipt.canonical_url,
      imageUrl: ogImageUrl(receipt.mission_id),
    }),
    body: `<main class="receipt-page"><header class="page-nav">${pageActions}</header>${renderVerifyFirst(receipt)}${renderReceipt(receipt, { page: true, generatedAt })}${repositoryLink}${renderCiAgreementLine(receipt)}${renderRequestRunCta(repository?.label ?? repoLabel(receipt.target_repo))}${renderDiscrepancyPledge()}<section class="claims receipt-page-claims" aria-labelledby="receipt-claims-boundary"><h2 id="receipt-claims-boundary">Claims boundary</h2><p>${claimsDescription} It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section><footer class="site-footer receipt-page-footer">A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment. Maintainer outcome is reported separately and remains fully outside Northset’s control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>.</footer></main>`,
  });
}

function renderRepositoryPage(repository, receipts, generatedAt) {
  const agreement = ciAgreementForReceipts(receipts);
  const previews = receipts
    .slice()
    .sort((left, right) => (right.finished_at ?? '').localeCompare(left.finished_at ?? '') || left.mission_id.localeCompare(right.mission_id))
    .map((receipt) => renderPreview(receipt, {
      includeAnchor: false,
      sitePrefix: '../../',
      showRepositoryLink: false,
    }))
    .join('');
  return renderDocument({
    title: `${repository.label} · Northset receipts`,
    body: `<main class="repository-page"><header class="page-nav"><a href="../../index.html">← Receipt ledger</a></header><p class="eyebrow">REPOSITORY LEDGER</p><h1>${escapeHtml(repository.label)}</h1><p>All Northset external receipts recorded for this repository, with mutable upstream outcomes kept separate from run evidence.</p><p class="ci-agreement-stat">Upstream CI agreed with the receipt in <strong>${agreement.agreed} of ${agreement.total}</strong> conclusive runs for this repository.</p><section class="gallery" aria-labelledby="repository-receipts"><h2 id="repository-receipts">Receipts</h2><div class="preview-grid external-receipts">${previews}</div></section>${renderRequestRunCta(repository.label)}<footer class="site-footer">Ledger generated <time datetime="${escapeHtml(generatedAt)}">${escapeHtml(formatHumanDate(generatedAt))}</time>. <a href="../../index.html">Back to the full ledger</a>.</footer></main>`,
  });
}

function publicReceiptSummary(receipt, generatedAt) {
  const attestationEvidence = coherentAttestationEvidence(receipt);
  return {
    schema_version: receipt.version,
    generated_at: generatedAt,
    receipt_id: receipt.mission_id,
    receipt_result: receipt.result,
    passed_commands: receipt.successful_checks,
    declared_commands: receipt.declared_checks,
    timestamps: {
      started_at: receipt.started_at,
      finished_at: receipt.finished_at,
    },
    commands: receipt.commands.map((command) => ({
      cmd: command.cmd,
      exit_code: command.exit_code,
      timed_out: command.timed_out,
      duration_ms: command.duration_ms,
    })),
    environment: {
      container_image_ref: receipt.environment.container_image_ref,
      container_image_digest: receipt.environment.container_image_digest,
      container_image_id: receipt.environment.container_image_id,
      container_os: receipt.environment.container_os,
      container_architecture: receipt.environment.container_architecture,
      network_policy: receipt.environment.network_policy,
      workspace_mode: receipt.environment.workspace_mode,
      workspace_write_allowlist: [...(receipt.environment.workspace_write_allowlist ?? [])],
      workspace_file_count_limit: receipt.environment.workspace_file_count_limit ?? null,
      workspace_bytes_limit: receipt.environment.workspace_bytes_limit ?? null,
      initial_workspace_manifest_digest: receipt.environment.initial_workspace_manifest_digest,
      post_run_changed_tracked_paths: [...(receipt.environment.post_run_changed_tracked_paths ?? [])],
      post_run_untracked_paths: [...(receipt.environment.post_run_untracked_paths ?? [])],
      post_run_mode_changes: [...(receipt.environment.post_run_mode_changes ?? [])],
      source_commit: receipt.environment.source_commit,
      install_commands: [...receipt.environment.install_commands],
    },
    code: { ...receipt.code },
    execution_summary: receipt.execution_summary,
    bundle: {
      bundle_contents_digest: receipt.bundle_digest,
      signed_asset_sha256: attestationEvidence?.releaseAssetSha256 ?? null,
      attestation_uri: attestationEvidence?.attestationUri ?? null,
      attestation_verified_at: attestationEvidence?.verifiedAt ?? null,
      provenance: attestationEvidence === null
        ? 'Signed provenance has not been verified.'
        : 'Signed provenance recorded; the signer records artifact origin, not execution witnessing or maintainer approval.',
    },
    classification: receipt.classification,
    links: {
      canonical_url: receipt.canonical_url,
      target_repo: receipt.target_repo,
      issue_or_task: receipt.issue_or_task,
      publication_pr: receipt.publication?.pr_url ?? null,
    },
    issue_title: receipt.issue_title,
    limitations: [...receipt.limitations],
    correction: receipt.correction_note,
    scope_note: receipt.scope_note,
    upstream_outcome: receipt.live_outcome,
    ...(receipt.version === 2 ? {economic_identity: receipt.economic_identity} : {}),
    ...(receipt.version === 3 ? {
      evidence_status: receipt.evidence_status,
      checks_not_run: receipt.checks_not_run.map((item) => ({...item})),
      legacy_checks: [...receipt.legacy_checks],
      source: {...receipt.source},
    } : {}),
  };
}

function renderDocument({ title, body, headExtras = '' }) {
  const renderedHeadExtras = headExtras === '' ? '' : `  ${headExtras}\n`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>${escapeHtml(title)}</title>
${renderedHeadExtras}  <style>
    :root { color-scheme:dark; --bg:#182323; --ink:#edf3ed; --muted:#b8c7bf; --paper:#fffdf7; --paper-ink:#1b211e; --rule:#d5d0c2; --green:#087f55; --green-pale:#d9f0e4; --rehearsal:#e6e2db; --self:#e3f0ec; --line:#4d615a; --focus:#ffcd57; --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; min-width:0; background:var(--bg); color:var(--ink); font:16px/1.5 var(--mono); }
    main { width:min(1120px,100%); margin:auto; padding:clamp(1.1rem,4vw,3.5rem) 1rem 4rem; }
    h1,h2,h3,p { margin-top:0; } h1 { max-width:18ch; margin-bottom:.65rem; font-size:clamp(2rem,7vw,4.8rem); line-height:1.02; letter-spacing:-.06em; } h2 { line-height:1.15; } h3,.eyebrow { font-size:.73rem; letter-spacing:.12em; text-transform:uppercase; }
    a { color:inherit; overflow-wrap:anywhere; text-decoration-thickness:1px; text-underline-offset:3px; } a:focus-visible,button:focus-visible { outline:3px solid var(--focus); outline-offset:3px; }
    .visually-hidden { position:absolute !important; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    .mast { max-width:68ch; margin-bottom:2rem; } .mast-cta { margin:1.2rem 0 .8rem; display:flex; flex-wrap:wrap; gap:.65rem; }
    .northset-brand { display:block; width:min(100%,32rem); margin-bottom:.2rem; color:var(--ink); line-height:0; text-decoration:none; } .northset-wordmark { display:block; width:min(100%,32rem); height:auto; } .northset-domain { margin:0 0 1.75rem; font-size:clamp(1.15rem,3vw,1.5rem); font-weight:800; letter-spacing:.04em; } .northset-domain a { color:#b5edce; text-decoration:none; } .northset-domain a:hover { text-decoration:underline; }
    .hero-stats { margin:0 0 2.2rem; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-block:1px solid var(--line); } .hero-stats a { min-width:0; padding:.8rem .75rem; display:flex; flex-direction:column; color:var(--muted); text-decoration:none; } .hero-stats a + a { border-left:1px solid var(--line); } .hero-stats strong { color:#b5edce; font:800 clamp(1.7rem,4vw,2.7rem)/1 var(--sans); letter-spacing:-.04em; } .hero-stats span { margin-top:.3rem; font-size:.68rem; line-height:1.3; text-transform:uppercase; letter-spacing:.04em; } .hero-stats a:hover span { color:var(--ink); text-decoration:underline; text-underline-offset:3px; }
    .eyebrow { margin-bottom:.45rem; color:#9dd9bd; font-weight:700; } .hero { display:grid; grid-template-columns:minmax(15rem,1fr) minmax(0,34rem); gap:1rem 3rem; align-items:start; } .hero-intro { grid-column:1; grid-row:1; max-width:38rem; } .hero-intro h2 { font-size:clamp(1.2rem,3vw,1.8rem); } .hero > .receipt { grid-column:2; grid-row:1; margin-top:0; } .hero-notes { width:100%; margin:1.5rem 0 0; padding:0; display:grid; gap:.6rem; list-style:none; } .hero-note { padding:.7rem; border:1px solid var(--line); color:var(--muted); font-size:.76rem; } .hero-note strong,.hero-note span { display:block; } .hero-note strong { color:#b5edce; margin-bottom:.2rem; text-transform:uppercase; letter-spacing:.06em; }
    .receipt { width:min(100%, 34rem); margin:1rem auto; padding:1.15rem; overflow:hidden; background:var(--paper); color:var(--paper-ink); border:1px solid var(--rule); box-shadow:0 1.2rem 2.8rem #0006; position:relative; transform:rotate(-.18deg); }
    .receipt--economic { --receipt-green:#0b6849; --receipt-amber:#9a6900; width:min(100%,58rem); padding:clamp(1rem,3vw,2.2rem); transform:none; border:1px solid #bfc2b8; border-top:3px solid var(--receipt-green); box-shadow:0 1.6rem 4rem #0007; background-color:#faf7ef; background-image:radial-gradient(circle at 18% 22%,#163b2c0b 0 1px,transparent 1.5px),radial-gradient(circle at 78% 66%,#5f4a2508 0 1px,transparent 1.5px),linear-gradient(95deg,#fff9,transparent 35%,#6c6a5d08); background-size:11px 13px,17px 19px,100% 100%; font-family:var(--sans); isolation:isolate; }
    .receipt::before,.receipt::after { content:""; position:absolute; left:0; right:0; height:7px; background:linear-gradient(135deg,transparent 4px,var(--paper) 0) 0 0/8px 8px repeat-x; } .receipt::before { top:0; } .receipt::after { bottom:0; transform:rotate(180deg); }
    .receipt--economic::before { inset:0; height:auto; background:linear-gradient(90deg,transparent 0 49.92%,#1c49320a 50%,transparent 50.08%); opacity:.45; pointer-events:none; }
    .receipt--economic::after { inset:.55rem; width:auto; height:auto; background:linear-gradient(#22523d 0 0) left top/.8rem 1px no-repeat,linear-gradient(#22523d 0 0) left top/1px .8rem no-repeat,linear-gradient(#22523d 0 0) right top/.8rem 1px no-repeat,linear-gradient(#22523d 0 0) right top/1px .8rem no-repeat,linear-gradient(#22523d 0 0) left bottom/.8rem 1px no-repeat,linear-gradient(#22523d 0 0) left bottom/1px .8rem no-repeat,linear-gradient(#22523d 0 0) right bottom/.8rem 1px no-repeat,linear-gradient(#22523d 0 0) right bottom/1px .8rem no-repeat; opacity:.38; transform:none; pointer-events:none; }
    .receipt--economic > * { position:relative; z-index:1; }
    .receipt--rehearsal { --paper:#f0ede7; filter:saturate(.45); } .receipt--self-run .receipt-head { border-left:5px solid #207f6a; padding-left:.7rem; } .receipt--verification .receipt-head { border-left:5px solid var(--green); padding-left:.7rem; } .receipt--declared { --paper:#f5f0e1; border-top:5px solid #9b6c18; }
    .receipt--economic.receipt--declared { border-top:3px solid var(--receipt-green); }
    .receipt--v1 { background-color:#faf7ef; }
    .receipt-head { border-bottom:1px dashed var(--rule); padding:1rem 0 .8rem; } .brand { margin-bottom:.2rem; letter-spacing:.34em; font-weight:800; } .receipt-head h1,.receipt-head h2 { max-width:none; margin-bottom:.65rem; font-size:1.35rem; line-height:1.15; letter-spacing:normal; } .receipt-id { white-space:nowrap; } .class-stamp { display:inline-block; margin:0; padding:.18rem .35rem; border:2px solid currentColor; font-size:.68rem; font-weight:800; letter-spacing:.04em; transform:rotate(-1deg); } .consent-artifact { margin:.65rem 0 0; font-size:.72rem; }
    .receipt--economic.receipt--self-run .receipt-head,.receipt--economic.receipt--verification .receipt-head { padding-left:0; border-left:0; }
    .receipt--economic .receipt-head { min-height:9.6rem; display:grid; grid-template-columns:minmax(0,1.1fr) minmax(15rem,.9fr); grid-template-areas:"title work" "stamp interval" "consent interval"; gap:.55rem 2rem; align-items:end; padding:.25rem 0 1rem; border-bottom:1px solid #9eaaa1; }
    .folio-title { grid-area:title; min-width:0; }
    .receipt--economic .brand { margin:0 0 .25rem; color:#245a46; font:800 .7rem/1 var(--mono); letter-spacing:.24em; }
    .receipt--economic .receipt-head h1,.receipt--economic .receipt-head h2 { margin:0; font-family:var(--sans); font-size:clamp(1.45rem,3.6vw,2.3rem); font-weight:750; letter-spacing:-.035em; }
    .folio-receipt-id { margin:.35rem 0 0; color:#45534c; font:700 .7rem/1.3 var(--mono); letter-spacing:.07em; }
    .folio-receipt-id span { text-transform:uppercase; }
    .folio-receipt-id code { color:#132d24; font-size:.85rem; letter-spacing:.03em; }
    .folio-work { grid-area:work; min-width:0; margin:0; color:#34473e; font-size:clamp(.84rem,1.8vw,.98rem); font-weight:650; line-height:1.35; }
    .folio-work > span { display:block; margin-bottom:.22rem; color:#526159; font:750 .68rem/1.2 var(--mono); letter-spacing:.06em; }
    .receipt--economic .class-stamp { grid-area:stamp; justify-self:start; max-width:34rem; padding:.23rem .4rem; border-width:1px; font-family:var(--mono); font-size:.68rem; line-height:1.3; transform:none; }
    .receipt--economic .consent-artifact { grid-area:consent; margin:.15rem 0 0; color:#47564e; font-family:var(--mono); font-size:.68rem; }
    .run-interval { grid-area:interval; min-width:0; margin:0; display:flex; flex-wrap:wrap; justify-content:flex-start; align-items:baseline; gap:.18rem .45rem; color:#45534c; font:650 .68rem/1.45 var(--mono); }
    .run-interval > span { width:100%; color:#4d5c54; font-size:.68rem; letter-spacing:.05em; }
    .run-interval b { color:#839087; font-weight:400; }
    .folio-watermark { position:absolute; z-index:0; left:-2rem; top:.15rem; color:#0b68492b; font:800 1.65rem/1 var(--mono); letter-spacing:.08em; writing-mode:vertical-rl; transform:rotate(180deg); pointer-events:none; }
    .receipt--rehearsal .class-stamp { color:#5c625d; } .receipt--self-run .class-stamp { color:#155e4c; } .receipt--verification .class-stamp { color:var(--green); } .receipt--declared .class-stamp { color:#79520e; }
    .receipt--economic .class-stamp { color:#4e5e56; }
    .receipt-meta,.facts { margin:1rem 0 0; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.3rem .8rem; } .receipt-meta { grid-template-columns:minmax(6.5rem,.45fr) minmax(0,1.55fr); } .receipt-meta div { min-width:0; } dt { color:#59635d; font-size:.72rem; text-transform:uppercase; } dd { margin:0; min-width:0; overflow-wrap:anywhere; } code { font:inherit; overflow-wrap:anywhere; white-space:pre-wrap; }
    .human-run-interval { display:flex; flex-wrap:wrap; gap:.12rem .35rem; align-items:baseline; }
    .copyable-hash { min-width:0; display:inline-flex; flex-wrap:wrap; gap:.35rem; align-items:center; } .copy-hash { padding:.15rem .32rem; border-color:#80968b; background:transparent; color:#315b49; font-size:.63rem; line-height:1.25; }
    .receipt-section { padding:.9rem 0; border-bottom:1px dashed var(--rule); } .receipt-section h2,.receipt-section h3,.correction h2,.correction h3 { margin-bottom:.55rem; font-size:.73rem; letter-spacing:.12em; text-transform:uppercase; } .receipt-section p:last-child { margin-bottom:0; } .commands { margin:0; padding-left:1.2rem; } .commands li+li { margin-top:.8rem; } pre { max-width:100%; margin:.35rem 0; padding:.6rem; overflow:auto; background:#f2eee4; color:#1b211e; border:1px solid #ded8c9; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; } .command-result { margin:.25rem 0 0; color:#4d5751; font-size:.85rem; }
    .receipt--v1 .compact-identities .facts { margin-top:.55rem; }
    .receipt--v1 .compact-identities h2,.receipt--v1 .proof-scope h2,.receipt--v1 .public-scope-interpretation h2,.receipt--v1 .limitations h2 { margin-bottom:.55rem; color:#1e3d32; font-family:var(--sans); font-size:1rem; letter-spacing:-.01em; text-transform:none; }
    .receipt--v1 .proof-scope,.receipt--v1 .compact-identities,.receipt--v1 .public-scope-interpretation,.receipt--v1 .limitations { border-bottom:1px solid #9eaaa1; }
    .duration-line { display:flex; justify-content:space-between; gap:1rem; color:#4d5751; font-size:.85rem; } .total { margin:.85rem 0 .35rem; padding:.6rem; background:var(--green-pale); color:#075238; font-weight:800; } .scope-note { color:#3f4d46; font-size:.82rem; }
    .limitations ul { margin:0; padding-left:1.15rem; } .limitations li+li { margin-top:.4rem; } .correction { margin:.9rem 0; padding:.8rem; border:2px solid #9d503a; background:#fff1e8; color:#5b271b; } .correction h2,.correction h3 { margin-bottom:.35rem; } .correction p { margin:0; }
    .cryptographic-detail { margin:.9rem 0; padding:.7rem .75rem; border:1px solid #aeb8b0; background:#f3f0e7; } .cryptographic-detail > summary { cursor:pointer; color:#244b3c; font-size:.72rem; font-weight:850; letter-spacing:.05em; text-transform:uppercase; } .cryptographic-detail > p { margin:.65rem 0 0; color:#526058; font-size:.72rem; } .cryptographic-detail .facts { margin-top:.65rem; grid-template-columns:1fr; gap:.15rem; } .cryptographic-detail dd { margin-bottom:.6rem; } .cryptographic-detail code { display:block; font-size:.7rem; }
    .button-link,button { display:inline-block; padding:.48rem .65rem; border:1px solid #37685a; border-radius:0; background:#e7f3ed; color:#064b34; font:inherit; font-size:.78rem; cursor:pointer; } button:hover,.button-link:hover { background:#ccebdc; }
    .verify-command { display:grid; gap:.45rem; margin-top:.7rem; } .verify-command pre { font-size:.72rem; } .qr-link { display:flex; align-items:center; gap:.65rem; margin-top:1rem; color:#33443c; font-size:.72rem; text-decoration:none; } .qr-link svg { width:4.5rem; height:4.5rem; flex:none; border:4px solid #fff; } .receipt-disclosure { margin-top:.9rem; padding-top:.8rem; border-top:1px dashed var(--rule); font-size:.8rem; } .receipt-disclosure p { margin:.4rem 0 0; color:#4d5751; }
    .receipt-open { margin:.9rem 0 0; font-weight:800; } .patch,.evidence-output { margin-top:1rem; } .patch summary,.evidence-output summary { cursor:pointer; font-weight:700; } .patch pre,.evidence-output pre { max-height:24rem; font-size:.72rem; }
    .receipt--economic code,.receipt--economic pre,.receipt--economic dt,.section-kicker,.flow-index,.flow-meta,.proof-score,.proof-status-rail,.attempt-proofline,.proofline-stages,.receipt-cost-total,.annex-body,.receipt-provenance { font-family:var(--mono); }
    .section-kicker { margin:0 0 .35rem; color:#245944; font-size:.68rem; font-weight:800; letter-spacing:.07em; text-transform:uppercase; }
    .economic-overview { padding:1rem 0 1.2rem; border-bottom:1px solid #9eaaa1; }
    .proof-hero { display:grid; grid-template-columns:minmax(13rem,1.2fr) minmax(14rem,.8fr); gap:1.4rem 2.25rem; align-items:stretch; }
    .proof-result { min-width:0; }
    .proof-score { margin:.12rem 0 .3rem; color:#07583e; font-size:clamp(4.2rem,11vw,7.6rem); font-weight:800; letter-spacing:-.1em; line-height:.78; }
    .proof-statement { margin:0; color:#15382d; font-family:var(--sans); font-size:clamp(1.35rem,3vw,2.05rem); line-height:1; letter-spacing:-.035em; }
    .proof-result > p:last-child { max-width:43ch; margin:.65rem 0 0; color:#536058; font-size:.78rem; line-height:1.42; }
    .proof-status-rail { min-width:0; margin:0; display:grid; grid-template-rows:repeat(3,minmax(0,1fr)); border:1px solid #aab4ad; }
    .proof-status-rail > div { min-width:0; padding:.65rem .75rem; display:grid; grid-template-columns:minmax(5.8rem,.72fr) minmax(0,1fr); gap:.65rem; align-items:center; }
    .proof-status-rail > div + div { border-top:1px solid #ccd0c8; }
    .proof-status-rail dt { color:#4f5e56; font-size:.68rem; font-weight:800; letter-spacing:.04em; }
    .proof-status-rail dd { margin:0; color:#1b332b; font-size:.8rem; font-weight:800; line-height:1.2; }
    .proof-status-rail dd > strong { display:block; }
    .proof-status-rail span { display:block; margin-top:.16rem; color:#4f5e56; font-size:.68rem; font-weight:550; line-height:1.32; overflow-wrap:anywhere; }
    .proof-status-rail [data-cost-state="incomplete"] { background:#f5e8bd; color:#674900; }
    .proof-status-rail [data-cost-state="incomplete"] dt,.proof-status-rail [data-cost-state="incomplete"] dd,.proof-status-rail [data-cost-state="incomplete"] span { color:inherit; }
    .proofline,.economic-identity { padding:1.4rem 0 1.55rem; border-bottom:1px solid #9eaaa1; }
    .economic-overview h2,.proofline h2,.economic-identity h2,.economic-unknowns h2 { margin-bottom:.65rem; font-family:var(--sans); font-size:clamp(1.25rem,2.7vw,1.7rem); letter-spacing:-.025em; }
    .section-heading { display:grid; grid-template-columns:minmax(12rem,1fr) minmax(16rem,1.2fr); gap:1rem 2rem; align-items:end; }
    .section-heading > p { margin-bottom:.65rem; color:#4b5750; font-size:.78rem; }
    .proofline-instrument { margin-top:.3rem; padding:.85rem 0 .2rem; border-top:1px solid #c3c8c1; }
    .attempt-proofline { position:relative; margin:.25rem 0 1.2rem; padding:.35rem 0 0; display:flex; list-style:none; }
    .attempt-proofline::before { content:""; position:absolute; left:0; right:0; top:.68rem; border-top:1px solid #7f9187; }
    .proofline-attempt { position:relative; min-width:0; flex:var(--attempt-count,1) 1 0; padding:1.1rem .65rem 0 0; color:#46564e; }
    .attempt-tick { width:.65rem; height:.65rem; border:2px solid #7f9187; border-radius:50%; background:#faf7ef; }
    .attempt-tick { position:absolute; top:0; left:0; }
    .proofline-attempt--grouped { padding-top:1.05rem; }
    .attempt-group-bracket { position:absolute; top:-.05rem; left:0; right:.35rem; height:.78rem; display:block; border:1px solid #566f62; border-left-width:2px; border-right-width:2px; background:repeating-linear-gradient(135deg,#58726412 0 3px,transparent 3px 7px),#eef0e9; }
    .attempt-cluster { position:absolute; inset:0; padding:.14rem .22rem; display:grid; grid-template-columns:repeat(var(--attempt-count),minmax(0,1fr)); gap:.12rem; align-items:center; }
    .attempt-cluster-mark { width:.28rem; height:.34rem; display:block; justify-self:center; border:0; border-radius:0; background:#526f60; }
    .attempt-group-copy { display:block; }
    .proofline-attempt--ready .attempt-tick { border-color:#087653; }
    .proofline-attempt--current .attempt-tick { width:.85rem; height:.85rem; top:-.06rem; border:3px solid #faf7ef; background:#087653; box-shadow:0 0 0 1px #087653; }
    .proofline-attempt .attempt-sequence,.proofline-attempt code,.proofline-attempt strong,.proofline-attempt .attempt-reason { display:block; }
    .proofline-attempt .attempt-sequence { color:#526159; font-size:.67rem; letter-spacing:.035em; }
    .proofline-attempt code { margin:.1rem 0; color:#233a31; font-size:.73rem; font-weight:800; }
    .proofline-attempt strong { color:#454f49; font-size:.7rem; text-transform:uppercase; }
    .proofline-attempt--ready strong,.proofline-attempt--current code { color:#07583e; }
    .attempt-reason { color:#62564f; font-size:.67rem; line-height:1.25; }
    .proofline-stages { position:relative; padding:1.15rem 0 .2rem; }
    .proofline-stages::before { content:""; position:absolute; left:var(--current-node); top:-1.35rem; height:1.7rem; border-left:1px solid #426b58; }
    .proofline-stages::after { content:""; position:absolute; left:var(--current-node); right:0; top:.34rem; border-top:1px solid #426b58; }
    .proofline-anatomy { position:relative; padding-top:.38rem; }
    .anatomy-title { margin:0 0 .45rem; color:#244c3b; font-size:.7rem; font-weight:850; letter-spacing:.055em; text-align:right; }
    .anatomy-bar { width:100%; height:1.2rem; display:flex; overflow:hidden; border:1px solid #315a48; background:#e1e4dc; }
    .anatomy-segment { min-width:0; height:100%; flex:0 0 var(--anatomy-share); transform-origin:left; animation:proofline-reveal .7s ease-out both; }
    .anatomy-segment:nth-child(1) { background:#1f5843; }
    .anatomy-segment:nth-child(2) { background:#386b52; }
    .anatomy-segment:nth-child(3) { background:#527a62; }
    .anatomy-segment:nth-child(4) { background:#6c8b72; }
    .anatomy-segment + .anatomy-segment { box-shadow:inset 2px 0 #f8f5ed; }
    .anatomy-legend { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
    .proofline-stage { position:relative; min-width:0; padding:.55rem .58rem; display:grid; grid-template-columns:1.25rem minmax(0,1fr) max-content; grid-template-rows:auto auto; gap:.08rem .35rem; align-items:baseline; border:1px solid #c4cac2; border-top:0; }
    .proofline-stage + .proofline-stage { border-left:0; }
    .proofline-stage > span,.proofline-stage > strong { display:block; }
    .stage-index { grid-column:1; grid-row:1 / 3; color:#55655d; font-size:.67rem; }
    .stage-name { grid-column:2 / -1; grid-row:1; color:#29483b; font-size:.68rem; font-weight:800; letter-spacing:.025em; text-transform:uppercase; }
    .proofline-stage strong { grid-column:2; grid-row:2; color:#142e25; font-size:.74rem; }
    .stage-share { grid-column:3; grid-row:2; color:#52645b; font-size:.67rem; }
    .proofline-stage[data-available="false"] { background:#f0efe8; }
    .proofline-stage[data-available="false"] strong { color:#6b746f; font-style:italic; font-weight:550; }
    .identity-flow { position:relative; margin:.8rem 0 0; padding:1.1rem 0 0; display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.16fr) minmax(0,.9fr); list-style:none; }
    .identity-flow::before { content:""; position:absolute; left:0; right:0; top:.35rem; border-top:1px solid #83958b; }
    .identity-flow > li { position:relative; min-width:0; padding:.75rem 1.15rem 0 0; }
    .identity-flow > li + li { padding-left:1.15rem; border-left:1px solid #d1d3cc; }
    .identity-flow > li::before { content:""; position:absolute; top:-.79rem; left:0; width:.55rem; height:.55rem; border:1px solid #466d5b; border-radius:50%; background:#faf7ef; }
    .identity-flow > li + li::before { left:1.15rem; }
    .identity-flow > li:nth-child(2) article { margin:-.35rem -.15rem 0; padding:.55rem .7rem .65rem; border-top:2px solid #8fa196; background:#eef1ea; }
    .flow-index { margin:0 0 .3rem; color:#466459; font-size:.67rem; letter-spacing:.04em; }
    .identity-flow h3 { margin:0 0 .48rem; color:#1c3b30; font-family:var(--sans); font-size:1rem; letter-spacing:-.015em; text-transform:none; }
    .flow-lede { margin:0 0 .75rem; color:#34473e; font-family:var(--sans); font-size:.84rem; line-height:1.5; }
    .flow-meta { padding-top:.12rem; border-top:1px dashed #c3c7c0; color:#34453d; font-size:.71rem; line-height:1.42; }
    .flow-meta p { margin:.5rem 0 0; overflow-wrap:anywhere; }
    .flow-meta span { display:block; margin-bottom:.08rem; color:#506058; font-size:.67rem; font-weight:800; letter-spacing:.025em; }
    .flow-meta strong,.flow-meta code { color:#20392f; }
    .economic-unknowns { display:grid; grid-template-columns:1.25fr .9fr; gap:.8rem 2rem; padding:1.25rem 0 .85rem; margin:0; }
    .economic-unknowns p { margin-bottom:.25rem; font-size:.78rem; }
    .economic-unknowns h3 { margin:.1rem 0 .45rem; color:#42554c; }
    .economic-unknowns ul { margin:0; padding-left:1.1rem; font-family:var(--mono); font-size:.7rem; }
    .receipt-cost-total { margin:0 0 1.2rem; padding:.9rem 1.15rem; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.12rem 1.2rem; align-items:end; border-top:3px double #315a49; border-bottom:3px double #315a49; color:#123a2c; background:#e2eee8; }
    .receipt-cost-total > span { align-self:center; font-size:.65rem; font-weight:900; letter-spacing:.14em; }
    .receipt-cost-total > strong { justify-self:end; font-size:clamp(1.65rem,4vw,2.55rem); line-height:1; letter-spacing:-.05em; }
    .receipt-cost-total > p { grid-column:1 / -1; margin:.35rem 0 0; color:#4f6058; font-size:.68rem; }
    .receipt-cost-total[data-cost-state="incomplete"] { border-color:var(--receipt-amber); color:#5f4300; background:#f5e8bd; }
    .evidence-drawer { margin:0; border-top:1px solid #87988f; border-bottom:1px solid #87988f; background:#f7f3e9; }
    .evidence-drawer > summary { padding:.95rem .15rem; display:flex; justify-content:space-between; gap:1rem; align-items:center; cursor:pointer; list-style:none; color:#17352d; font-family:var(--mono); font-weight:900; }
    .evidence-drawer > summary::-webkit-details-marker { display:none; }
    .evidence-drawer > summary::after { content:'+'; width:1.4rem; height:1.4rem; display:grid; place-items:center; flex:none; border:1px solid #6f8278; }
    .evidence-drawer[open] > summary::after { content:'−'; }
    .evidence-drawer > summary span { font-size:.82rem; letter-spacing:.04em; text-transform:uppercase; }
    .evidence-drawer > summary small { margin-left:auto; color:#56645d; font-size:.67rem; font-weight:450; }
    .annex-body { border-top:1px solid #b9c2bc; background:#f7f3e9; }
    .annex-chapter { padding:0; border-bottom:1px solid #b6beb8; background:#f7f3e9; }
    .annex-chapter:last-child { border-bottom:0; }
    .annex-heading { margin:0; padding:.9rem .15rem; display:flex; gap:.85rem; align-items:flex-start; cursor:pointer; list-style:none; }
    .annex-heading::-webkit-details-marker { display:none; }
    .annex-heading::after { content:'+'; width:1.35rem; height:1.35rem; margin-left:auto; display:grid; place-items:center; flex:none; border:1px solid #788980; color:#30483d; font:800 .72rem/1 var(--mono); }
    .annex-chapter[open] > .annex-heading { border-bottom:1px dashed #bec5be; }
    .annex-chapter[open] > .annex-heading::after { content:'−'; }
    .annex-heading > span { color:#789087; font-size:1.15rem; line-height:1; }
    .annex-heading p { margin:0; color:#17352d; font-size:.8rem; font-weight:900; letter-spacing:.04em; text-transform:uppercase; }
    .annex-heading small { display:block; margin-top:.16rem; color:#506058; font-size:.67rem; }
    .drawer-body,.drawer-grid { padding:0 .8rem .8rem; border:0; background:#f7f3e9; }
    .drawer-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 1.4rem; }
    .drawer-grid > section { min-width:0; padding:1rem 0; border-bottom:1px dashed #c9c7ba; }
    .drawer-grid h4 { margin:0 0 .55rem; color:#334a40; font-size:.68rem; letter-spacing:.06em; text-transform:uppercase; }
    .annex-economic { margin:.75rem .65rem 1rem; border:1px solid #9da9a1; background:#fdfaf2; box-shadow:0 .45rem 1rem #243b3012; }
    .annex-economic > .annex-heading { padding:.85rem .9rem; background:#faf7ed; }
    .annex-economic[open] > .annex-heading { border-bottom:1px solid #b6beb7; }
    .annex-economic > .drawer-grid { padding:.15rem .9rem .9rem; grid-template-columns:repeat(2,minmax(0,1fr)); grid-template-areas:"lineage usage" "envelope costs" "outcome outcome"; gap:0 1.25rem; background:#fdfaf2; }
    .evidence-lineage { grid-area:lineage; }
    .evidence-usage { grid-area:usage; }
    .evidence-envelope { grid-area:envelope; }
    .evidence-costs { grid-area:costs; }
    .evidence-outcome { grid-area:outcome; }
    .annex-economic .evidence-group { min-width:0; }
    .annex-economic .facts { margin:.55rem 0 0; grid-template-columns:minmax(8.8rem,.92fr) minmax(0,1.08fr); gap:.3rem .65rem; color:#20362d; font-size:.71rem; line-height:1.42; }
    .annex-economic .facts dt { color:#506058; font-size:.67rem; letter-spacing:.01em; }
    .annex-economic .facts dd { color:#20362d; font-size:.71rem; }
    .annex-economic .evidence-outcome { margin-top:.45rem; padding:.85rem .9rem; border:1px solid #b6c0b8; background:#edf1eb; }
    .annex-economic .evidence-outcome h4 { color:#24483a; }
    .annex-economic .outcome-facts { grid-template-columns:max-content minmax(0,1fr) max-content minmax(0,1fr); gap:.36rem .7rem; }
    .attempt-list,.cost-lines { margin:0; padding:0; list-style:none; }
    .attempt-list li,.cost-lines li { display:grid; grid-template-columns:minmax(5rem,.5fr) minmax(0,1fr); gap:.5rem; padding:.45rem 0; border-bottom:1px solid #dedbcf; }
    .attempt-list li span,.cost-lines li span { color:#4b5952; font-size:.7rem; }
    .attempt-list code,.cost-lines strong { color:#20382e; font-size:.71rem; }
    .evidence-null { color:#6b756f !important; font-style:italic; font-weight:500; }
    .receipt-provenance { margin-top:1.1rem; padding-top:1rem; background:repeating-linear-gradient(90deg,#72857a 0 5px,transparent 5px 10px) top/100% 1px no-repeat; color:#40534a; font-size:.68rem; }
    .receipt-provenance > p { margin:0; color:#294a3c; font-size:.68rem; font-weight:900; letter-spacing:.05em; }
    .receipt-provenance .facts { margin-top:.55rem; }
    .receipt--economic .receipt-disclosure { margin-top:1.25rem; padding:.8rem 0 0; border:0; border-top:1px solid #aab4ad; background:transparent; color:#42534b; font-family:var(--sans); font-size:.72rem; }
    .receipt--economic .receipt-disclosure p { color:#59665f; }
    @keyframes proofline-reveal { from { transform:scaleX(0); } to { transform:scaleX(1); } }
    .featured-stub { padding:1.1rem 1.2rem 1.25rem; transform:rotate(-.12deg); background-color:#fffdf7; background-image:radial-gradient(circle at 18% 22%,#163b2c0b 0 1px,transparent 1.5px),radial-gradient(circle at 78% 66%,#5f4a2508 0 1px,transparent 1.5px),linear-gradient(95deg,#fff9,transparent 38%,#6c6a5d08); background-size:11px 13px,17px 19px,100% 100%; }
    .featured-stub .featured-stub-head { padding:.7rem 0 .75rem .7rem; display:flex; flex-wrap:wrap; justify-content:space-between; gap:.65rem 1rem; align-items:flex-end; }
    .featured-stub-head h3 { margin:0; color:#183a2f; font-family:var(--sans); font-size:1.35rem; letter-spacing:-.025em; text-transform:none; }
    .featured-receipt-id { margin:.25rem 0 0; color:#56635c; font-size:.68rem; font-weight:800; letter-spacing:.04em; text-transform:uppercase; }
    .featured-stub .class-stamp { max-width:18rem; font-size:.61rem; line-height:1.25; transform:none; }
    .featured-work { padding:.75rem 0; border-bottom:1px dashed var(--rule); } .featured-work p { margin:0; } .featured-work p + p { margin-top:.4rem; } .featured-work span,.featured-facts dt { display:block; margin-bottom:.08rem; color:#5b6861; font-size:.65rem; font-weight:800; letter-spacing:.05em; text-transform:uppercase; } .featured-repo a { color:#153c2f; font-family:var(--sans); font-size:clamp(1.28rem,4vw,1.72rem); font-weight:800; letter-spacing:-.03em; text-decoration-thickness:2px; } .featured-work-links { color:#354b42; font-size:.8rem; }
    .featured-verdict { margin:.85rem 0; padding:.8rem .9rem; border-left:4px solid #087f55; background:#e0eee7; } .featured-verdict .featured-result { margin:0; color:#07583e; font-family:var(--sans); font-size:clamp(1.65rem,5vw,2.35rem); font-weight:850; line-height:.98; letter-spacing:-.04em; } .featured-verdict p:last-child { margin:.55rem 0 0; color:#385047; font-size:.74rem; }
    .featured-facts { margin:0; display:grid; gap:.45rem; } .featured-facts > div { min-width:0; padding-bottom:.42rem; border-bottom:1px dashed #ddd7ca; } .featured-facts dd { color:#293d35; font-size:.72rem; line-height:1.4; } .featured-provenance { margin:.65rem 0 0; color:#4b5c54; font-size:.68rem; line-height:1.4; }
    .featured-finish { margin-top:.7rem; display:flex; justify-content:space-between; gap:1rem; align-items:center; } .featured-qr { display:flex; align-items:center; gap:.45rem; color:#40524a; font-size:.62rem; text-decoration:none; } .featured-qr svg { width:3.8rem; height:3.8rem; flex:none; border:3px solid #fff; } .unfold-link { padding:.65rem .75rem; border:2px solid #087f55; color:#075238; font-family:var(--sans); font-size:.88rem; font-weight:850; text-decoration:none; } .unfold-link:hover { background:#d9f0e4; }
    .featured-disclosure { margin-top:.75rem; padding-top:.65rem; border-top:1px dashed var(--rule); color:#4c5a54; font-size:.65rem; } .featured-disclosure > strong { color:#273e35; } .featured-disclosure p { margin:.25rem 0 0; }
    .outcome-stub { width:min(100%,34rem); margin:-1rem auto 1rem; padding:1.2rem 1.15rem 1rem; color:#ecf4ef; border:1px dashed #b7cbc0; background:#254039; text-align:center; } .receipt--v1 + .outcome-stub { width:min(100%,58rem); } .outcome-stub h2 { margin-bottom:.5rem; font-size:1rem; text-transform:uppercase; letter-spacing:.08em; } .outcome-stub strong { font-size:1.15rem; } .outcome-stub p { margin:.3rem 0 0; font-size:.78rem; } .stub-cut { color:#b7cbc0; letter-spacing:.05em; }
    .verify-ledger { width:min(100%,34rem); margin:1.6rem auto 2.5rem; padding:1rem; border-left:4px solid #9dd9bd; background:#223831; } .verify-ledger h2 { font-size:1rem; } .verify-ledger p { color:var(--muted); font-size:.86rem; } .verify-ledger pre { font-size:.72rem; }
    .gallery { margin-top:3rem; } .gallery-head { display:flex; gap:1rem; justify-content:space-between; align-items:end; flex-wrap:wrap; } .gallery-head h2 { margin-bottom:0; } .filters { display:flex; flex-wrap:wrap; gap:.4rem; } .filters button { color:var(--ink); border-color:var(--line); background:transparent; } .filters button[aria-pressed="true"] { color:#082d20; background:#b5edce; }
    .preview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(16rem,1fr)); gap:.8rem; margin-top:1rem; } .receipt-preview { min-width:0; padding:1rem; border:1px solid var(--line); border-left-width:4px; background:#21342f; } .receipt-preview[hidden] { display:none; } .receipt-preview[data-status-tone="merged"] { border-left-color:#4ed18e; background:#203932; } .receipt-preview[data-status-tone="changes-requested"] { border-left-color:#d8a94d; background:#3a3428; } .receipt-preview[data-status-tone="closed"] { border-left-color:#77867f; background:#29332f; opacity:.72; } .receipt-preview[data-status-tone="open"] { border-left-color:#7d9188; background:#24342f; } .receipt-preview.receipt--rehearsal { background:#3d4641; filter:saturate(.45); } .preview-id,.preview-repo,.preview-work,.preview-status,.preview-result,.preview-state-detail,.preview-scope,.preview-attestation,.preview-class,.preview-outcome { margin-bottom:.5rem; } .preview-id { color:#90a69c; font-size:.66rem; font-weight:800; letter-spacing:.06em; text-transform:uppercase; } .preview-repo { margin-bottom:.55rem; font-family:var(--sans); font-size:clamp(1.12rem,2.2vw,1.38rem); font-weight:800; line-height:1.08; letter-spacing:-.025em; text-transform:none; } .preview-repo a { color:#f0f5f1; text-decoration-thickness:2px; } .preview-work { color:#d4ded8; font-family:var(--sans); font-size:.88rem; line-height:1.35; } .preview-work > span { display:block; margin-bottom:.08rem; color:#91a69d; font:800 .62rem/1.2 var(--mono); letter-spacing:.05em; text-transform:uppercase; } .preview-status { margin:.8rem 0 .4rem; padding-top:.65rem; border-top:1px solid #465a52; } .preview-status strong { color:#c7d3cd; font-size:.75rem; letter-spacing:.035em; text-transform:uppercase; } .receipt-preview[data-status-tone="merged"] .preview-status strong { color:#73dba5; font-weight:900; } .receipt-preview[data-status-tone="changes-requested"] .preview-status strong { color:#f0c466; } .receipt-preview[data-status-tone="closed"] .preview-status strong { color:#9caaa4; text-decoration:line-through; } .preview-result { color:#9fd2b8; font-size:.7rem; font-weight:700; } .preview-state-detail,.preview-class,.preview-scope,.preview-attestation,.preview-outcome { color:var(--muted); font-size:.68rem; line-height:1.4; } .preview-class { display:inline-block; padding:.2rem .32rem; border:1px solid currentColor; color:#9bc8b5; font-size:.6rem; font-weight:800; } .receipt-preview.receipt--rehearsal .preview-class { color:#bdc4c0; } .receipt-preview.receipt--verification .preview-class { color:#78dca9; } .receipt-preview.receipt--declared .preview-class { color:#d4aa5e; } .preview-link { display:inline-block; margin-top:.4rem; color:#b5edce; font-weight:800; }.noscript { color:var(--muted); }
    .rehearsal-archive { margin:3rem 0 0; padding:1rem; border:1px solid var(--line); color:var(--muted); } .rehearsal-archive > summary { color:var(--ink); cursor:pointer; font-weight:800; } .rehearsal-archive > p { margin:.8rem 0 0; font-size:.82rem; }
    .request-run { max-width:58rem; margin:3.5rem 0 0; padding:clamp(1rem,3vw,1.6rem); border:1px solid #689781; border-left:6px solid #9dd9bd; background:#21342f; } .receipt-page > .request-run { width:min(100%,58rem); margin:2.4rem auto 0; } .request-run h2 { margin-bottom:.75rem; font-size:clamp(1.35rem,4vw,2rem); } .request-run > p { max-width:68ch; } .request-actions { display:flex; flex-wrap:wrap; gap:.65rem; margin:1.15rem 0 .9rem; } .request-primary { font-weight:800; } .request-secondary { background:transparent; color:var(--ink); } .request-secondary:hover { color:#b5edce; } .request-public-note,.request-onboarded { margin-bottom:.5rem; color:var(--muted); font-size:.78rem; } .request-onboarded code { color:#b5edce; }
    .claims { max-width:58rem; margin:3.5rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); }.claims h2 { color:var(--ink); }.site-footer { max-width:58rem; margin:2rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.78rem; }.page-nav { width:min(100%,58rem); margin:0 auto 1rem; color:var(--muted); font-size:.78rem; }.page-nav p { margin:.5rem 0 0; overflow-wrap:anywhere; }.page-actions,.page-action-buttons { display:flex; align-items:center; gap:.6rem; }.page-actions { justify-content:space-between; }.page-action-buttons { justify-content:flex-end; flex-wrap:wrap; }
    .verify-first { width:min(100%,58rem); margin:0 auto 1rem; padding:1rem; border:1px solid #689781; border-left:6px solid #9dd9bd; background:#21342f; } .verify-first h2 { margin-bottom:.65rem; font-size:1.15rem; } .verify-first pre { font-size:.72rem; } .verify-first p { margin:.55rem 0 0; color:var(--muted); font-size:.78rem; }
    .ci-agreement-stat,.receipt-ci-agreement,.discrepancy-pledge,.repository-ledger-nav { max-width:58rem; margin:1.25rem 0; padding:.85rem 1rem; border-left:4px solid #9dd9bd; background:#21342f; } .receipt-page > :is(.receipt-ci-agreement,.discrepancy-pledge,.repository-ledger-nav) { width:min(100%,58rem); margin-left:auto; margin-right:auto; } .preview-repo-ledger { margin:.6rem 0 0; color:var(--muted); font-size:.68rem; }
    .receipt-page-claims,.receipt-page-footer { margin-top:1.3rem; opacity:.6; font-size:.7rem; }
    .receipt-page-claims h2 { font-size:.9rem; }
    @media (max-width:58rem) { .hero { grid-template-columns:1fr; } .hero-intro,.hero > .receipt { grid-column:1; grid-row:auto; } .hero-notes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:48rem) { .section-heading,.economic-unknowns { grid-template-columns:1fr; } .drawer-grid { grid-template-columns:1fr; } .annex-economic > .drawer-grid { grid-template-columns:1fr; grid-template-areas:"lineage" "usage" "envelope" "costs" "outcome"; } .annex-economic .outcome-facts { grid-template-columns:max-content minmax(0,1fr); } }
    @media (max-width:34rem) {
      .receipt { margin-left:0; margin-right:0; padding:.85rem; }
      .hero-stats { grid-template-columns:repeat(2,minmax(0,1fr)); } .hero-stats a:nth-child(3) { border-left:0; border-top:1px solid var(--line); } .hero-stats a:nth-child(4) { border-top:1px solid var(--line); }
      .hero-notes { grid-template-columns:1fr; }
      .featured-stub .featured-stub-head { align-items:flex-start; flex-direction:column; }
      .featured-finish { align-items:stretch; flex-direction:column-reverse; } .featured-qr { align-self:flex-start; } .unfold-link { text-align:center; }
      .preview-grid { grid-template-columns:1fr; }
      .receipt--economic { padding:.85rem .9rem 1rem; }
      .receipt--economic .receipt-head { min-height:0; grid-template-columns:1fr; grid-template-areas:"title" "work" "stamp" "interval" "consent"; gap:.55rem; align-items:start; padding:.1rem 0 .8rem; }
      .receipt--economic .receipt-head h1,.receipt--economic .receipt-head h2 { font-size:1.55rem; }
      .folio-work { padding-top:.55rem; border-top:1px solid #ccd1ca; font-size:.86rem; }
      .receipt--economic .class-stamp { max-width:100%; font-size:.68rem; }
      .run-interval { font-size:.68rem; }
      .folio-watermark { left:-.87rem; top:.12rem; font-size:.8rem; }
      .receipt-meta { grid-template-columns:1fr; }
      .facts { grid-template-columns:1fr; gap:.15rem; }
      .proof-hero { grid-template-columns:1fr; gap:.85rem; }
      .proof-score { font-size:clamp(4.3rem,25vw,6.2rem); }
      .proof-statement { max-width:18ch; font-size:1.45rem; }
      .proof-result > p:last-child { font-size:.75rem; }
      .proof-status-rail > div { padding:.58rem .62rem; grid-template-columns:5.35rem minmax(0,1fr); gap:.45rem; }
      .proof-status-rail dd { font-size:.75rem; }
      .section-heading { gap:.2rem; }
      .section-heading > p { font-size:.7rem; }
      .proofline-instrument { padding-top:.65rem; }
      .attempt-proofline { display:block; margin:.15rem 0 1rem; padding:.15rem 0 .1rem 1.55rem; }
      .attempt-proofline::before { left:.31rem; right:auto; top:.25rem; bottom:.15rem; border-top:0; border-left:1px solid #7f9187; }
      .proofline-attempt { min-height:3.9rem; padding:.08rem 0 .9rem; }
      .attempt-tick { top:.16rem; left:-1.55rem; }
      .proofline-attempt--current .attempt-tick { top:.1rem; }
      .proofline-attempt--grouped { min-height:calc((var(--attempt-count) * .43rem) + .95rem); padding-top:.08rem; }
      .attempt-group-bracket { top:.08rem; bottom:.7rem; left:-1.55rem; right:auto; width:.68rem; height:auto; border-width:1px 1px 1px 2px; }
      .attempt-cluster { inset:.14rem .08rem; padding:0; grid-template-columns:1fr; grid-template-rows:repeat(var(--attempt-count),minmax(0,1fr)); gap:.08rem; }
      .attempt-cluster-mark { width:.36rem; height:.15rem; }
      .proofline-stages { padding-top:1rem; }
      .proofline-stages::before { left:.31rem; top:-1.25rem; height:1.55rem; }
      .proofline-stages::after { left:.31rem; top:.29rem; }
      .proofline-anatomy { padding-top:.35rem; }
      .anatomy-title { font-size:.68rem; text-align:left; }
      .anatomy-bar { height:1.35rem; }
      .anatomy-legend { grid-template-columns:repeat(2,minmax(0,1fr)); }
      .proofline-stage:nth-child(3) { border-left:1px solid #c4cac2; }
      .proofline-stage:nth-child(n+3) { border-top:0; }
      .identity-flow { grid-template-columns:1fr; gap:0; padding:.2rem 0 0 1.35rem; }
      .identity-flow::before { left:.22rem; right:auto; top:.25rem; bottom:.2rem; border:0; border-left:1px solid #83958b; }
      .identity-flow > li,.identity-flow > li + li { padding:.15rem 0 1.1rem; border:0; }
      .identity-flow > li::before,.identity-flow > li + li::before { top:.25rem; left:-1.35rem; }
      .identity-flow > li:nth-child(2) article { margin:0; }
      .identity-flow h3 { margin-bottom:.45rem; }
      .economic-unknowns { padding:1.1rem 0; }
      .receipt-cost-total { grid-template-columns:1fr; gap:.35rem; padding:.85rem; }
      .receipt-cost-total > strong { justify-self:start; font-size:2rem; }
      .receipt-cost-total > p { grid-column:1; }
      .evidence-drawer > summary { align-items:flex-start; }
      .evidence-drawer > summary small { display:none; }
      .annex-heading { padding:.8rem .1rem; }
      .annex-heading small { font-size:.67rem; }
      .drawer-body,.drawer-grid { min-width:0; }
      .annex-economic { margin:.55rem .2rem .8rem; }
      .annex-economic > .annex-heading { padding:.78rem .7rem; }
      .annex-economic > .drawer-grid { padding:.1rem .7rem .7rem; }
      .annex-economic .facts,.annex-economic .outcome-facts { grid-template-columns:1fr; gap:.12rem; }
      .annex-economic .facts dd { margin-bottom:.5rem; }
      .page-actions { align-items:center; flex-direction:row; flex-wrap:wrap; gap:.45rem; }
      .page-action-buttons { margin-left:auto; justify-content:flex-end; flex-wrap:nowrap; gap:.35rem; }
      .page-nav .button-link,.page-nav button { padding:.4rem .48rem; font-size:.7rem; white-space:nowrap; }
      .facts dd,.receipt-meta dd { margin-bottom:.55rem; }
    }
    @media (prefers-reduced-motion:reduce) { .anatomy-segment { animation:none; } }
    @media print { @page { margin:8mm; } :root,html,body { color-scheme:light; background:#fff; color:#000; } body { font-size:9pt; } main,.receipt-page { width:auto; padding:0; margin:0; } .mast,.hero-stats,.gallery,.claims,.site-footer,.page-nav,.verify-ledger,.verify-first,.receipt-open,.outcome-stub,.request-run,.receipt-ci-agreement,.discrepancy-pledge,.repository-ledger-nav { display:none !important; } .patch,.evidence-output { display:none !important; } .receipt { display:block; width:auto; max-width:100%; margin:0; box-shadow:none; transform:none; } .receipt--economic { background:#fff; border:1px solid #777; } .receipt--economic::before,.receipt--economic::after { display:none; } .receipt:not(.receipt--economic) { width:72mm; } .facts,.receipt-meta { grid-template-columns:1fr; gap:.15rem; } .facts dd,.receipt-meta dd { margin-bottom:.45rem; } .receipt .button-link,.receipt button { display:none; } .proof-scope,.compact-identities,.cryptographic-detail,.limitations,.verification,.receipt-disclosure,.qr-link,.proof-hero,.proofline-anatomy,.proofline-stage,.identity-flow>li,.receipt-cost-total,.receipt-provenance { break-inside:avoid; page-break-inside:avoid; } .anatomy-segment { animation:none; } .qr-link { display:flex; } .evidence-drawer:not([open]) > :not(summary),.annex-chapter:not([open]) > :not(summary) { display:block !important; } a { color:inherit; text-decoration:none; } }
  </style>
</head>
<body>
${body}
<script>
  (() => {
    for (const button of document.querySelectorAll('[data-copy]')) {
      button.addEventListener('click', async () => {
        const text = button.dataset.copy;
        try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
        catch { button.textContent = 'Copy unavailable'; }
      });
    }
    for (const button of document.querySelectorAll('[data-print]')) {
      button.addEventListener('click', () => window.print());
    }
    const filters = document.querySelectorAll('[data-filter]');
    const cards = document.querySelectorAll('.external-receipts .receipt-preview');
    const applyFilter = (button) => {
      const filter = button.dataset.filter;
      for (const candidate of filters) candidate.setAttribute('aria-pressed', String(candidate === button));
      for (const card of cards) {
        const matches = filter === 'all'
          || (filter === 'changes_requested'
            ? card.dataset.reviewDecision === 'changes_requested'
            : card.dataset.publicationState === filter);
        card.hidden = !matches;
      }
    };
    for (const button of filters) button.addEventListener('click', () => applyFilter(button));
    for (const link of document.querySelectorAll('[data-select-filter]')) link.addEventListener('click', () => {
      const button = [...filters].find((candidate) => candidate.dataset.filter === link.dataset.selectFilter);
      if (button) applyFilter(button);
    });
  })();
</script>
</body>
</html>
`;
}

/** Render the homepage and one permanent printable page per normalized receipt. */
export async function renderLedger({ indexPath, out, now = null }) {
  if (now !== null && typeof now !== 'string') throw new TypeError('now must be a string or null');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  if (typeof index !== 'object' || index === null || Array.isArray(index) || !Array.isArray(index.missions)) {
    throw new TypeError('index must be an object with a missions array');
  }
  const indexFields = ['ci_agreement', 'generated_at', 'missions', 'version'];
  if (Object.keys(index).sort().join('\0') !== indexFields.join('\0')) {
    throw new TypeError('index contains a missing or extra top-level field');
  }
  if (index.version !== '1') throw new TypeError('index version must be 1');
  validTime(index.generated_at, 'index.generated_at');
  if (now !== null && now !== index.generated_at) throw new TypeError('render now must equal index.generated_at');
  for (const mission of index.missions) {
    if (typeof mission !== 'object' || mission === null || typeof mission.receipt !== 'object' || mission.receipt === null) {
      throw new TypeError('index must contain a normalized receipt for every mission');
    }
    if (!GENERATED_RECEIPT_PATTERN.test(mission.receipt.mission_id)) {
      throw new TypeError('index receipt mission_id must match the generated receipt pattern');
    }
  }
  const computedAgreement = ciAgreementForReceipts(index.missions.map((mission) => mission.receipt));
  if (
    typeof index.ci_agreement !== 'object' || index.ci_agreement === null
    || !Number.isInteger(index.ci_agreement.agreed) || !Number.isInteger(index.ci_agreement.total)
    || index.ci_agreement.agreed !== computedAgreement.agreed
    || index.ci_agreement.total !== computedAgreement.total
  ) {
    throw new TypeError('index ci_agreement must match conclusive publication envelopes');
  }

  const siteRoot = path.dirname(out);
  const receiptsRoot = path.join(siteRoot, 'receipts');
  const ogRoot = path.join(siteRoot, 'og');
  const repositoriesRoot = path.join(siteRoot, 'repo');
  await mkdir(receiptsRoot, { recursive: true });
  await mkdir(ogRoot, { recursive: true });
  await mkdir(repositoriesRoot, { recursive: true });
  await writeOutput(out, renderLedgerHtml(index));
  await writeOutput(path.join(ogRoot, 'index.svg'), renderHomepageOgSvg(index));
  const publicReceipts = index.missions.map((mission) => publicReceiptSummary(mission.receipt, index.generated_at));
  await writeOutput(
    path.join(siteRoot, 'ledger.json'),
    `${JSON.stringify({ schema_version: 1, generated_at: index.generated_at, receipts: publicReceipts }, null, 2)}\n`,
  );
  for (const schemaFile of PUBLIC_SCHEMA_FILES) {
    await writeOutput(
      path.join(siteRoot, 'schema', schemaFile),
      await readFile(new URL(`../schema/${schemaFile}`, import.meta.url), 'utf8'),
    );
  }
  const renderedIds = new Set();
  const repositoryReceipts = repositoryReceiptGroups(index.missions.map((mission) => mission.receipt));
  const repositorySlugs = new Set(repositoryReceipts.keys());
  for (const mission of index.missions) {
    const receipt = mission.receipt;
    renderedIds.add(receipt.mission_id);
    const receiptDirectory = path.join(receiptsRoot, receipt.mission_id);
    await writeOutput(
      path.join(receiptDirectory, 'index.html'),
      renderReceiptPage(receipt, index.generated_at, repositorySlugs),
    );
    await writeOutput(path.join(ogRoot, `${receipt.mission_id}.svg`), renderReceiptOgSvg(receipt));
    await writeOutput(
      path.join(receiptDirectory, 'receipt.json'),
      `${JSON.stringify(publicReceiptSummary(receipt, index.generated_at), null, 2)}\n`,
    );
  }
  for (const [slug, group] of [...repositoryReceipts.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const repositoryDirectory = path.join(repositoriesRoot, slug);
    await writeOutput(
      path.join(repositoryDirectory, 'index.html'),
      renderRepositoryPage(group.repository, group.receipts, index.generated_at),
    );
    await writeOutput(path.join(repositoryDirectory, '.northset-ledger-generated'), GENERATED_REPOSITORY_MARKER);
  }
  for (const entry of await readdir(receiptsRoot, { withFileTypes: true })) {
    if (GENERATED_RECEIPT_PATTERN.test(entry.name) && !renderedIds.has(entry.name)) {
      await rm(path.join(receiptsRoot, entry.name), { recursive: true, force: true });
    }
  }
  for (const entry of await readdir(ogRoot, { withFileTypes: true })) {
    const missionId = entry.name.endsWith('.svg') ? entry.name.slice(0, -4) : '';
    if (GENERATED_RECEIPT_PATTERN.test(missionId) && !renderedIds.has(missionId)) {
      await rm(path.join(ogRoot, entry.name), { force: true });
    }
  }
  for (const entry of await readdir(repositoriesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !GENERATED_REPOSITORY_PATTERN.test(entry.name) || repositoryReceipts.has(entry.name)) continue;
    const marker = await readTextIfPresent(path.join(repositoriesRoot, entry.name, '.northset-ledger-generated'));
    if (marker === GENERATED_REPOSITORY_MARKER) {
      await rm(path.join(repositoriesRoot, entry.name), { recursive: true, force: true });
    }
  }
  return { missions: index.missions.length, pages: index.missions.length + repositoryReceipts.size + 1 };
}
