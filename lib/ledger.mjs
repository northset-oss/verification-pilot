import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateMission } from './mission-validator.mjs';
import { assertProofOfPass } from './proof-of-pass.mjs';
import { createReceiptQr } from './receipt-qr.mjs';
import { assertReceiptParity } from './receipt-parity.mjs';

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
const VERIFY_WORKFLOW = 'northset-oss/verification-pilot/.github/workflows/attest-bundle.yml';
const ATTESTATION_URI_PREFIX = 'https://github.com/northset-oss/verification-pilot/releases/download/';
const PUBLIC_RUN_REQUEST_URL = 'https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml';
const RUN_REQUEST_EMAIL = 'oss@northset.ai';
const GENERATED_RECEIPT_PATTERN = /^M-(?:\d{3}|E2[a-c])$/;
const CONSENT_VARIANTS = new Set(['V', 'W', 'F']);
const PUBLIC_SCHEMA_FILES = [
  'ledger.schema.json',
  'public-consent.schema.json',
  'public-receipt.schema.json',
  'publication.schema.json',
  'run-record.schema.json',
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
    if (disclosure.schema_version !== 1) {
      throw new TypeError('publication pr_disclosure.schema_version must equal 1');
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

function receiptClassification(variant) {
  if (variant === 'own_repo_rehearsal') return 'REHEARSAL — NOT EXTERNAL VALIDATION';
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
  const publication = suppliedPublication === undefined
    ? await publicationFor(missionFile, mission.mission_id)
    : suppliedPublication;
  const manifest = await readJsonIfPresent(path.join(missionDirectory, 'bundle', 'bundle.manifest.json'), 'bundle/bundle.manifest.json');
  const issueSnapshot = await readJsonIfPresent(path.join(missionDirectory, 'bundle', 'issue_snapshot.json'), 'bundle/issue_snapshot.json');
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

  return {
    version: 1,
    mission_id: mission.mission_id,
    canonical_path: `receipts/${mission.mission_id}/`,
    canonical_url: `${RECEIPT_BASE_URL}/${mission.mission_id}/`,
    variant: mission.variant,
    classification: receiptClassification(mission.variant),
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
  const index = { version: '0', generated_at: now, missions };
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

function requestRunMailto() {
  const subject = 'Northset run request: owner/repository#123';
  const body = [
    'PR URL:',
    'Repository:',
    'I am a maintainer or authorized representative:',
    'Checks to run, if different from repo defaults:',
    'Anything Northset should know:',
  ].join('\n');
  return `mailto:${RUN_REQUEST_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function renderRequestRunCta() {
  return `<section class="request-run" aria-labelledby="request-run-title">
  <p class="eyebrow">FOR MAINTAINERS</p>
  <h2 id="request-run-title">Request a private run</h2>
  <p><strong>Maintain an open-source project?</strong> Send Northset a PR already in your queue. We run its repository-declared checks in an isolated container and return the run record privately. We do not modify the PR. Nothing is published without your approval. Free during the pilot.</p>
  <div class="request-actions"><a class="button-link request-primary" href="${escapeHtml(requestRunMailto())}">Email a private request</a><a class="button-link request-secondary" href="${escapeHtml(PUBLIC_RUN_REQUEST_URL)}">Open a public request</a></div>
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

function receiptSectionHeading(label, page) {
  const level = page ? 'h2' : 'h3';
  return `<${level}>${escapeHtml(label)}</${level}>`;
}

function renderCodeLines(receipt, { page = false } = {}) {
  const lines = [
    receipt.code.base_commit === null ? '' : `<dt>base</dt><dd><code>${escapeHtml(receipt.code.base_commit)}</code></dd>`,
    receipt.code.recorded_patch_commit === null ? '' : `<dt>recorded patch commit</dt><dd><code>${escapeHtml(receipt.code.recorded_patch_commit)}</code><br><span>${escapeHtml(receipt.code.patch_commit_binding)}</span></dd>`,
    receipt.code.patch_diff_hash === null ? '' : `<dt>patch diff SHA-256</dt><dd><code>${escapeHtml(receipt.code.patch_diff_hash)}</code><br><span>${escapeHtml(receipt.code.patch_diff_binding)}</span></dd>`,
  ].filter(Boolean).join('');
  return lines.length === 0
    ? ''
    : `<section class="receipt-section">${receiptSectionHeading('Code', page)}<dl class="facts">${lines}</dl></section>`;
}

function renderOutcomeStub(receipt) {
  if (receipt.live_outcome === null) return '';
  const outcome = receipt.live_outcome;
  const label = outcomeLabel(outcome.status);
  const state = outcome.link === null
    ? `<strong>${escapeHtml(label)}</strong><p>${escapeHtml(outcome.attribution)}; no decision link was recorded.</p>`
    : `<strong>${link(outcome.link, label, 'outcome-link')}</strong><p>${escapeHtml(outcome.attribution)} · ${link(outcome.link, 'open linked record')}</p>`;
  const drift = outcome.head_drift === true && outcome.pr_head_oid !== null
    ? `<p class="outcome-drift"><strong>PR changed since this record.</strong> ${receipt.code.recorded_patch_commit === null ? 'No patch commit was recorded;' : `Recorded patch commit <code>${escapeHtml(receipt.code.recorded_patch_commit)}</code>;`} current PR head observed at ${escapeHtml(receipt.publication.observed_at)}: <code>${escapeHtml(outcome.pr_head_oid)}</code>. The patch commit is declared source metadata, not an execution-bound identity; only the recorded patch bytes are bound to this receipt.</p>`
    : '';
  const facts = `<dl class="facts external-facts"><dt>PR state</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.state))}</dd><dt>Review signal</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.review_decision ?? 'none'))}</dd><dt>CI state</dt><dd>${escapeHtml(outcomeLabel(receipt.publication.ci_state))}</dd><dt>Upstream updated at</dt><dd>${escapeHtml(receipt.publication.updated_at)}</dd><dt>Observed at</dt><dd>${escapeHtml(receipt.publication.observed_at)}</dd></dl>`;
  return `<section class="outcome-stub" aria-label="External status"><p class="stub-cut">- - - detach here - - -</p><h2>External status</h2><p>Mutable upstream observation; unattested and separate from the signed run record.</p>${facts}${state}${drift}</section>`;
}

function renderReceipt(receipt, { featured = false, page = false } = {}) {
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
  const setupDuration = receipt.setup_install_duration_ms === null
    ? ''
    : `<p class="duration-line">setup + install (derived) <span>${escapeHtml(formatDuration(receipt.setup_install_duration_ms))}</span></p>`;
  const wallDuration = receipt.wall_duration_ms === null
    ? ''
    : `<p class="duration-line">run wall (derived from recorded timestamps) <span>${escapeHtml(formatDuration(receipt.wall_duration_ms))}</span></p>`;
  const scopeNote = 'Every command listed returned exit 0 in the declared environment. Only the listed commands are in scope. Unlisted test, lint, typecheck, build, coverage, compiler, full-suite, and CI gates are not implied or recorded.';
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
  const heading = page
    ? `<h1>Proof-of-Pass Receipt — ${escapeHtml(receipt.mission_id)}</h1>`
    : '<h2>Proof-of-Pass Receipt</h2>';
  const consent = receipt.consent_artifact === null
    ? ''
    : `<p class="consent-artifact"><strong>${receipt.variant === 'V' ? 'Maintainer consent' : 'Consent artifact'}</strong><br>${link(receipt.consent_artifact, 'Open recorded consent')}</p>`;
  const fundingDisclosure = '<p><strong>SELF-FUNDED FIELD-TESTING.</strong></p>';
  const publicScopeInterpretation = receipt.scope_note === null
    ? ''
    : `<section class="receipt-section public-scope-interpretation">${receiptSectionHeading('Public scope interpretation', page)}<p>${escapeHtml(receipt.scope_note)}</p></section>`;
  return `<article class="receipt ${receiptClass(receipt)}${featured ? ' receipt--featured' : ''}"${articleId}>
  <header class="receipt-head">
    <p class="brand">NORTHSET</p>
    ${heading}
    <p class="class-stamp">${escapeHtml(receipt.classification)}</p>
    ${consent}
    <dl class="receipt-meta"><div><dt>Receipt ID</dt><dd>${escapeHtml(receipt.mission_id)}</dd></div><div><dt>Run start</dt><dd>${escapeHtml(receipt.started_at)}</dd></div><div><dt>Run finish</dt><dd>${escapeHtml(receipt.finished_at)}</dd></div></dl>
  </header>
  <section class="receipt-section">${receiptSectionHeading('Project', page)}<p>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p>${receiptSectionHeading('Work', page)}<p>${work}</p>${receiptSectionHeading('Verification execution', page)}<p>runtime: ${escapeHtml(receipt.worker_identity.runtime)}<br>human operator: ${escapeHtml(receipt.worker_identity.human_operator)}</p></section>
  ${renderCodeLines(receipt, { page })}
  <section class="receipt-section">${receiptSectionHeading('Environment', page)}<dl class="facts"><dt>image reference</dt><dd>${escapeHtml(receipt.environment.container_image_ref)}</dd><dt>repository digest</dt><dd><code>${escapeHtml(receipt.environment.container_image_digest ?? 'not available in this legacy record')}</code></dd>${receipt.environment.container_image_id === null ? '' : `<dt>immutable image ID</dt><dd><code>${escapeHtml(receipt.environment.container_image_id)}</code></dd>`}${receipt.environment.container_os === null ? '' : `<dt>platform</dt><dd>${escapeHtml(receipt.environment.container_os)}/${escapeHtml(receipt.environment.container_architecture)}</dd>`}<dt>network</dt><dd>${escapeHtml(receipt.environment.network_policy)}</dd></dl></section>
  <section class="receipt-section proof-scope">${receiptSectionHeading('Declared checks', page)}<p><strong>Execution summary</strong><br>${escapeHtml(receipt.execution_summary)}</p><ol class="commands">${commandLines}</ol>${setupDuration}${wallDuration}<p class="total">${escapeHtml(receipt.result)}</p><p class="scope-note">${escapeHtml(scopeNote)}</p></section>
  ${publicScopeInterpretation}
  <section class="receipt-section">${receiptSectionHeading('Record details', page)}<dl class="facts"><dt>payment</dt><dd>${escapeHtml(receipt.payment.maintainer_payment)} · ${receipt.payment.merge_contingent ? 'merge-contingent' : 'not merge-contingent'}</dd><dt>redactions</dt><dd>${escapeHtml(redactionsLabel(receipt.redactions))}</dd><dt>Bundle contents digest</dt><dd><code>${escapeHtml(receipt.bundle_digest)}</code></dd><dt>Signed asset SHA-256</dt><dd><code>${escapeHtml(attestationEvidence?.releaseAssetSha256 ?? 'not recorded')}</code></dd><dt>Signed provenance recorded</dt><dd>${attestationEvidence === null ? 'not verified' : `verified ${escapeHtml(attestationEvidence.verifiedAt)}`}</dd></dl></section>
  <section class="receipt-section limitations">${receiptSectionHeading('NOT INCLUDED', page)}<ul>${receipt.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
  ${correction}
  <section class="receipt-section verification">${receiptSectionHeading('Signed bundle', page)}${verification}${verify}${attestationScope}<a class="qr-link" href="${escapeHtml(qrLink)}" aria-label="Canonical receipt page for ${escapeHtml(receipt.mission_id)}">${qr.svg}<span>QR → receipt page</span></a></section>
  <footer class="receipt-disclosure"><strong>${escapeHtml(receipt.disclosure_label)}</strong><p>Evidence of what ran — not a verdict that the code is good.</p>${fundingDisclosure}</footer>
  ${patch}
  ${rawOutput}
  ${pageLink}
</article>${renderOutcomeStub(receipt)}`.replaceAll(/^[ \t]+$/gm, '');
}

function renderPreview(receipt, { includeAnchor = true } = {}) {
  const attestation = coherentAttestationEvidence(receipt) === null ? 'not recorded' : 'recorded';
  const anchor = includeAnchor ? ` id="${escapeHtml(receipt.mission_id)}"` : '';
  const labelId = `preview-title-${receipt.mission_id}`;
  const publicationState = receipt.publication?.state ?? 'unpublished';
  const reviewDecision = receipt.publication?.review_decision ?? 'none';
  const issue = receipt.issue_title === null ? '' : `<p class="preview-issue">${link(receipt.issue_or_task, receipt.issue_title)}</p>`;
  const drift = receipt.publication?.head_drift === true
    ? `<p class="preview-outcome"><strong>PR changed since this record.</strong> ${receipt.code.recorded_patch_commit === null ? 'No patch commit was recorded;' : `recorded patch commit <code>${escapeHtml(receipt.code.recorded_patch_commit)}</code>;`} current PR head <code>${escapeHtml(receipt.publication.pr_head_oid)}</code>. The current head is mutable external status and was not executed by this record.</p>`
    : '';
  return `<article class="receipt-preview ${receiptClass(receipt)}"${anchor} aria-labelledby="${escapeHtml(labelId)}" data-publication-state="${escapeHtml(publicationState)}" data-review-decision="${escapeHtml(reviewDecision)}"><h3 id="${escapeHtml(labelId)}" class="preview-id">${escapeHtml(receipt.mission_id)}</h3><p class="preview-class">${escapeHtml(receipt.classification)}</p><p>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p>${issue}<p class="preview-result">${escapeHtml(receipt.result)}</p><p class="preview-scope">Command evidence and NOT INCLUDED are on the full receipt.</p><p class="preview-attestation">attestation: ${attestation}</p><p class="preview-outcome"><strong>PR state</strong>: ${escapeHtml(outcomeLabel(publicationState))}</p><p class="preview-outcome"><strong>Review signal</strong>: ${escapeHtml(outcomeLabel(reviewDecision))}</p>${drift}${relativeLink(receipt.canonical_path, 'Open receipt →', 'preview-link')}</article>`;
}

function renderNorthsetWordmark() {
  return `<svg class="northset-wordmark" role="img" aria-label="NORTHSET" viewBox="0 18.35 475 96">
  <g transform="translate(-11.52,10.89) scale(1.075)"><g transform="translate(5.24,-0.04)"><rect x="18.5" y="26.0" width="11.0" height="56.0" fill="currentColor"/><polygon points="26.6,26.0 29.4,26.0 56.79,62.82 74.03,20.0 85.97,20.0 59.4,83.0 19.64,31.36" fill="currentColor"/></g></g><g transform="translate(110.18,99.0)"><path d="M5.93 0V-60.2H25.71L39.9 -6.97H41.28V-60.2H51.51V0H31.82L17.63 -53.23H16.17V0Z M81.25 1.2Q74.89 1.2 69.85 -1.42Q64.82 -4.04 61.94 -8.9Q59.06 -13.76 59.06 -20.55V-21.93Q59.06 -28.72 61.94 -33.63Q64.82 -38.53 69.85 -41.11Q74.89 -43.69 81.25 -43.69Q87.61 -43.69 92.6 -41.11Q97.59 -38.53 100.47 -33.63Q103.35 -28.72 103.35 -21.93V-20.55Q103.35 -13.76 100.47 -8.9Q97.59 -4.04 92.6 -1.42Q87.61 1.2 81.25 1.2ZM81.25 -7.57Q86.67 -7.57 90.11 -11.05Q93.55 -14.53 93.55 -20.81V-21.67Q93.55 -27.95 90.11 -31.43Q86.67 -34.92 81.25 -34.92Q75.83 -34.92 72.39 -31.43Q68.95 -27.95 68.95 -21.67V-20.81Q68.95 -14.53 72.39 -11.05Q75.83 -7.57 81.25 -7.57Z M111.24 0V-42.48H120.96V-37.58H122.42Q123.37 -40.25 125.61 -41.45Q127.84 -42.66 130.94 -42.66H136.1V-33.88H130.77Q126.47 -33.88 123.8 -31.6Q121.13 -29.33 121.13 -24.6V0Z M158.44 0Q154.31 0 151.86 -2.45Q149.41 -4.9 149.41 -9.12V-34.31H138.31V-42.48H149.41V-56.16H159.3V-42.48H171.51V-34.31H159.3V-10.75Q159.3 -8.17 161.71 -8.17H170.22V0Z M178.97 0V-60.2H188.86V-36.89H190.32Q191.01 -38.36 192.56 -39.82Q194.11 -41.28 196.64 -42.23Q199.18 -43.17 203.05 -43.17Q207.95 -43.17 211.74 -40.98Q215.52 -38.79 217.63 -34.83Q219.74 -30.87 219.74 -25.46V0H209.85V-24.68Q209.85 -29.84 207.31 -32.38Q204.77 -34.92 200.13 -34.92Q194.88 -34.92 191.87 -31.43Q188.86 -27.95 188.86 -21.5V0Z M246.81 1.2Q238.55 1.2 233.22 -2.41Q227.89 -6.02 226.77 -12.99L235.88 -15.31Q236.49 -12.04 238.03 -10.15Q239.58 -8.26 241.86 -7.48Q244.14 -6.71 246.81 -6.71Q250.85 -6.71 252.87 -8.17Q254.89 -9.63 254.89 -11.87Q254.89 -14.19 252.95 -15.31Q251.02 -16.43 247.06 -17.2L244.4 -17.63Q240.01 -18.49 236.4 -19.99Q232.79 -21.5 230.59 -24.12Q228.4 -26.75 228.4 -30.79Q228.4 -36.98 233 -40.33Q237.6 -43.69 245.09 -43.69Q252.22 -43.69 256.87 -40.51Q261.51 -37.32 262.89 -31.99L253.77 -29.24Q253.08 -32.85 250.76 -34.36Q248.44 -35.86 245.09 -35.86Q241.65 -35.86 239.8 -34.66Q237.95 -33.45 237.95 -31.22Q237.95 -28.98 239.84 -27.86Q241.73 -26.75 244.91 -26.23L247.58 -25.71Q252.31 -24.85 256.14 -23.48Q259.96 -22.1 262.2 -19.52Q264.44 -16.94 264.44 -12.56Q264.44 -5.93 259.66 -2.36Q254.89 1.2 246.81 1.2Z M291.25 1.2Q284.88 1.2 280.02 -1.5Q275.17 -4.21 272.46 -9.16Q269.75 -14.1 269.75 -20.73V-21.76Q269.75 -28.47 272.41 -33.37Q275.08 -38.27 279.9 -40.98Q284.71 -43.69 290.99 -43.69Q297.18 -43.69 301.83 -40.98Q306.47 -38.27 309.05 -33.37Q311.63 -28.47 311.63 -21.93V-18.4H279.72Q279.9 -13.42 283.25 -10.41Q286.6 -7.4 291.51 -7.4Q296.32 -7.4 298.64 -9.5Q300.97 -11.61 302.17 -14.28L310.34 -10.06Q309.14 -7.74 306.86 -5.12Q304.58 -2.49 300.79 -0.64Q297.01 1.2 291.25 1.2ZM279.81 -25.89H301.57Q301.22 -30.1 298.34 -32.59Q295.46 -35.09 290.9 -35.09Q286.17 -35.09 283.34 -32.59Q280.5 -30.1 279.81 -25.89Z M333.88 0Q329.76 0 327.3 -2.45Q324.85 -4.9 324.85 -9.12V-34.31H313.76V-42.48H324.85V-56.16H334.74V-42.48H346.96V-34.31H334.74V-10.75Q334.74 -8.17 337.15 -8.17H345.67V0Z" fill="currentColor"/></g>
</svg>`;
}

function renderLedgerHtml(index) {
  const receipts = index.missions.map((mission) => mission.receipt);
  const externalReceipts = receipts
    .filter((receipt) => receipt.variant !== 'own_repo_rehearsal')
    .sort((left, right) => right.finished_at.localeCompare(left.finished_at) || left.mission_id.localeCompare(right.mission_id));
  const rehearsals = receipts
    .filter((receipt) => receipt.variant === 'own_repo_rehearsal')
    .sort((left, right) => right.finished_at.localeCompare(left.finished_at) || left.mission_id.localeCompare(right.mission_id));
  const featured = receipts.find((receipt) => receipt.mission_id === 'M-008') ?? null;
  const counts = {
    external: externalReceipts.length,
    attested: externalReceipts.filter((receipt) => receipt.attestation_uri !== null).length,
    merged: externalReceipts.filter((receipt) => receipt.publication?.state === 'merged').length,
    closed: externalReceipts.filter((receipt) => receipt.publication?.state === 'closed_unmerged').length,
    approved: externalReceipts.filter((receipt) => receipt.publication?.state === 'open' && receipt.publication.review_decision === 'approved').length,
    changesRequested: externalReceipts.filter((receipt) => receipt.publication?.state === 'open' && receipt.publication.review_decision === 'changes_requested').length,
    awaiting: externalReceipts.filter((receipt) => (
      receipt.publication?.state === 'open'
      && (receipt.publication.review_decision === null || receipt.publication.review_decision === 'review_required')
    )).length,
  };
  const externalPreviews = externalReceipts.map((receipt) => renderPreview(receipt, { includeAnchor: receipt.mission_id !== 'M-008' })).join('');
  const rehearsalPreviews = rehearsals.map((receipt) => renderPreview(receipt)).join('');
  const hero = featured === null
    ? '<p class="hero-missing">No committed M-008 receipt is available.</p>'
    : `${renderReceipt(featured, { featured: true })}<section class="verify-ledger"><h2>Verify this receipt</h2><p>Confirm where the attested bundle came from. This does not turn the recorded run into maintainer verification.</p>${featured.verify_command === null ? '' : `<pre><code>${escapeHtml(featured.verify_command)}</code></pre><button type="button" data-copy="${escapeHtml(featured.verify_command)}">Copy verify command</button>`}</section>`;
  const heroNotes = '<ol class="hero-notes" aria-label="How to read the featured receipt"><li class="hero-note"><strong>Exact commands</strong><span>Copied verbatim from the signed receipt evidence.</span></li><li class="hero-note"><strong>Recorded environment</strong><span>Image, digest, and network policy stay visible.</span></li><li class="hero-note"><strong>Scoped result</strong><span>Counted declared commands; never a bare PASS.</span></li><li class="hero-note"><strong>Separate outcome</strong><span>Later upstream decisions detach from receipt evidence.</span></li></ol>';
  return renderDocument({
    title: 'Northset Proof-of-Pass Receipts',
    body: `<main>
  <header class="mast"><a class="northset-brand" href="https://northset.ai">${renderNorthsetWordmark()}</a><p class="northset-domain"><a href="https://northset.ai">northset.ai</a></p><h1>Proof-of-Pass Receipts</h1><p>Proof-of-pass receipts for open-source work record exactly which declared commands returned exit 0, on named code and in a named environment. Each receipt is scoped evidence, not a verdict on code quality or maintainer approval.</p><p class="mast-cta"><a class="button-link mast-request" href="${escapeHtml(requestRunMailto())}">Request a private run</a></p><p class="generated-at">Generated at ${escapeHtml(index.generated_at)}</p></header>
  <section class="hero"><div class="hero-intro"><p class="eyebrow">FEATURED RECEIPT</p><h2>One real receipt, readable top to bottom.</h2>${heroNotes}</div>${hero}</section>
  <section class="external-status" aria-label="External status"><h2>External status</h2><p>Pull-request state and review signals are mutable upstream observations, recorded at each publication envelope's observed time. They are unattested metadata and are separate from the signed run bundle.</p></section>
  <section class="counts" aria-label="External receipt counts"><p><strong>${counts.external}</strong> External receipts</p><p><strong>${counts.merged}</strong> Merged upstream</p><p><strong>${counts.closed}</strong> Closed unmerged</p><p><strong>${counts.approved}</strong> Open approved</p><p><strong>${counts.changesRequested}</strong> Open changes requested</p><p><strong>${counts.awaiting}</strong> Open awaiting review</p></section>
  <section class="gallery" aria-labelledby="receipt-gallery"><div class="gallery-head"><div><p class="eyebrow">EXTERNAL RECEIPTS</p><h2 id="receipt-gallery">Find a receipt</h2></div><div class="filters" aria-label="Filter external receipt previews"><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="merged">Merged</button><button type="button" data-filter="open">Open</button><button type="button" data-filter="closed_unmerged">Closed</button><button type="button" data-filter="changes_requested">Changes requested</button></div></div><noscript><p class="noscript">All external receipt previews are shown. Filters are optional.</p></noscript><div class="preview-grid external-receipts">${externalPreviews}</div></section>
  <details class="rehearsal-archive"><summary>Own-repository rehearsal archive (${rehearsals.length})</summary><p>Rehearsals exercise the receipt system. They are not external validation.</p><div class="preview-grid">${rehearsalPreviews}</div></details>
  ${renderRequestRunCta()}
  <section class="claims"><p class="eyebrow">CLAIMS BOUNDARY</p><h2>What a receipt does and does not say</h2><p>A receipt reports the exact declared commands, their recorded exit status, and the recorded execution environment from an immutable run bundle.</p><p>It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Live upstream outcomes are detached because a later maintainer decision is a different fact from the recorded run. Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section>
  <footer class="site-footer"><strong>SELF-FUNDED FIELD-TESTING.</strong> A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment. Maintainer outcome is reported separately and remains fully outside Northset’s control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>. Machine-readable: <a href="ledger.json">ledger.json</a> · <a href="schema/ledger.schema.json">JSON Schemas</a>. <a class="footer-request" href="${escapeHtml(requestRunMailto())}">Request a private run</a>.</footer>
</main>`,
  });
}

function renderReceiptPage(receipt, generatedAt) {
  return renderDocument({
    title: `${receipt.mission_id} Proof-of-Pass Receipt`,
    body: `<main class="receipt-page"><header class="page-nav"><div class="page-actions"><a href="../../index.html">← All Proof-of-Pass Receipts</a><span class="page-action-buttons"><a class="button-link" href="receipt.json" download>Download receipt.json</a><button type="button" data-print>Print / Save receipt</button></span></div><p>Canonical receipt · ${escapeHtml(receipt.canonical_url)}</p><p>Generated at ${escapeHtml(generatedAt)}</p></header>${renderReceipt(receipt, { page: true })}${renderRequestRunCta()}<section class="claims receipt-page-claims" aria-labelledby="receipt-claims-boundary"><h2 id="receipt-claims-boundary">Claims boundary</h2><p>This page reports scoped proof-of-pass receipt evidence. It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section><footer class="site-footer receipt-page-footer">A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment. Maintainer outcome is reported separately and remains fully outside Northset’s control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>.</footer></main>`,
  });
}

function publicReceiptSummary(receipt, generatedAt) {
  const attestationEvidence = coherentAttestationEvidence(receipt);
  return {
    schema_version: 1,
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
  };
}

function renderDocument({ title, body }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme:dark; --bg:#182323; --ink:#edf3ed; --muted:#b8c7bf; --paper:#fffdf7; --paper-ink:#1b211e; --rule:#d5d0c2; --green:#087f55; --green-pale:#d9f0e4; --rehearsal:#e6e2db; --self:#e3f0ec; --line:#4d615a; --focus:#ffcd57; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; }
    * { box-sizing:border-box; }
    html { background:var(--bg); }
    body { margin:0; min-width:0; background:var(--bg); color:var(--ink); font:16px/1.5 var(--mono); }
    main { width:min(1120px,100%); margin:auto; padding:clamp(1.1rem,4vw,3.5rem) 1rem 4rem; }
    h1,h2,h3,p { margin-top:0; } h1 { max-width:18ch; margin-bottom:.65rem; font-size:clamp(2rem,7vw,4.8rem); line-height:1.02; letter-spacing:-.06em; } h2 { line-height:1.15; } h3,.eyebrow { font-size:.73rem; letter-spacing:.12em; text-transform:uppercase; }
    a { color:inherit; overflow-wrap:anywhere; text-decoration-thickness:1px; text-underline-offset:3px; } a:focus-visible,button:focus-visible { outline:3px solid var(--focus); outline-offset:3px; }
    .mast { max-width:68ch; margin-bottom:2rem; } .mast > p:last-child { color:var(--muted); } .mast-cta { margin:1.2rem 0 .8rem; }
    .northset-brand { display:block; width:min(100%,32rem); margin-bottom:.2rem; color:var(--ink); line-height:0; text-decoration:none; } .northset-wordmark { display:block; width:min(100%,32rem); height:auto; } .northset-domain { margin:0 0 1.75rem; font-size:clamp(1.15rem,3vw,1.5rem); font-weight:800; letter-spacing:.04em; } .northset-domain a { color:#b5edce; text-decoration:none; } .northset-domain a:hover { text-decoration:underline; }
    .eyebrow { margin-bottom:.45rem; color:#9dd9bd; font-weight:700; } .hero { display:grid; grid-template-columns:minmax(15rem,1fr) minmax(0,34rem); gap:1rem 3rem; align-items:start; } .hero-intro { grid-column:1; grid-row:1 / span 3; max-width:38rem; } .hero-intro h2 { font-size:clamp(1.2rem,3vw,1.8rem); } .hero > .receipt { grid-column:2; grid-row:1; margin-top:0; } .hero > .outcome-stub { grid-column:2; grid-row:2; } .hero > .verify-ledger { grid-column:2; grid-row:3; } .hero-notes { width:100%; margin:2rem 0 0; padding:0; display:grid; gap:.6rem; list-style:none; } .hero-note { padding:.7rem; border:1px solid var(--line); color:var(--muted); font-size:.76rem; } .hero-note strong,.hero-note span { display:block; } .hero-note strong { color:#b5edce; margin-bottom:.2rem; text-transform:uppercase; letter-spacing:.06em; }
    .receipt { width:min(100%, 34rem); margin:1rem auto; padding:1.15rem; overflow:hidden; background:var(--paper); color:var(--paper-ink); border:1px solid var(--rule); box-shadow:0 1.2rem 2.8rem #0006; position:relative; transform:rotate(-.18deg); }
    .receipt::before,.receipt::after { content:""; position:absolute; left:0; right:0; height:7px; background:linear-gradient(135deg,transparent 4px,var(--paper) 0) 0 0/8px 8px repeat-x; } .receipt::before { top:0; } .receipt::after { bottom:0; transform:rotate(180deg); }
    .receipt--rehearsal { --paper:#f0ede7; filter:saturate(.45); } .receipt--self-run .receipt-head { border-left:5px solid #207f6a; padding-left:.7rem; } .receipt--verification .receipt-head { border-left:5px solid var(--green); padding-left:.7rem; } .receipt--declared { --paper:#f5f0e1; border-top:5px solid #9b6c18; }
    .receipt-head { border-bottom:1px dashed var(--rule); padding:1rem 0 .8rem; } .brand { margin-bottom:.2rem; letter-spacing:.34em; font-weight:800; } .receipt-head h1,.receipt-head h2 { max-width:none; margin-bottom:.65rem; font-size:1.35rem; line-height:1.15; letter-spacing:normal; } .class-stamp { display:inline-block; margin:0; padding:.18rem .35rem; border:2px solid currentColor; font-size:.68rem; font-weight:800; letter-spacing:.04em; transform:rotate(-1deg); } .consent-artifact { margin:.65rem 0 0; font-size:.72rem; }
    .receipt--rehearsal .class-stamp { color:#5c625d; } .receipt--self-run .class-stamp { color:#155e4c; } .receipt--verification .class-stamp { color:var(--green); } .receipt--declared .class-stamp { color:#79520e; }
    .receipt-meta,.facts { margin:1rem 0 0; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:.3rem .8rem; } .receipt-meta { grid-template-columns:1fr 1fr; } .receipt-meta div { min-width:0; } dt { color:#59635d; font-size:.72rem; text-transform:uppercase; } dd { margin:0; min-width:0; overflow-wrap:anywhere; } code { font:inherit; overflow-wrap:anywhere; white-space:pre-wrap; }
    .receipt-section { padding:.9rem 0; border-bottom:1px dashed var(--rule); } .receipt-section h2,.receipt-section h3,.correction h2,.correction h3 { margin-bottom:.55rem; font-size:.73rem; letter-spacing:.12em; text-transform:uppercase; } .receipt-section p:last-child { margin-bottom:0; } .commands { margin:0; padding-left:1.2rem; } .commands li+li { margin-top:.8rem; } pre { max-width:100%; margin:.35rem 0; padding:.6rem; overflow:auto; background:#f2eee4; color:#1b211e; border:1px solid #ded8c9; font:inherit; white-space:pre-wrap; overflow-wrap:anywhere; } .command-result { margin:.25rem 0 0; color:#4d5751; font-size:.85rem; }
    .duration-line { display:flex; justify-content:space-between; gap:1rem; color:#4d5751; font-size:.85rem; } .total { margin:.85rem 0 .35rem; padding:.6rem; background:var(--green-pale); color:#075238; font-weight:800; } .scope-note { color:#3f4d46; font-size:.82rem; }
    .limitations ul { margin:0; padding-left:1.15rem; } .limitations li+li { margin-top:.4rem; } .correction { margin:.9rem 0; padding:.8rem; border:2px solid #9d503a; background:#fff1e8; color:#5b271b; } .correction h2,.correction h3 { margin-bottom:.35rem; } .correction p { margin:0; }
    .button-link,button { display:inline-block; padding:.48rem .65rem; border:1px solid #37685a; border-radius:0; background:#e7f3ed; color:#064b34; font:inherit; font-size:.78rem; cursor:pointer; } button:hover,.button-link:hover { background:#ccebdc; }
    .verify-command { display:grid; gap:.45rem; margin-top:.7rem; } .verify-command pre { font-size:.72rem; } .qr-link { display:flex; align-items:center; gap:.65rem; margin-top:1rem; color:#33443c; font-size:.72rem; text-decoration:none; } .qr-link svg { width:4.5rem; height:4.5rem; flex:none; border:4px solid #fff; } .receipt-disclosure { margin-top:.9rem; padding-top:.8rem; border-top:1px dashed var(--rule); font-size:.8rem; } .receipt-disclosure p { margin:.4rem 0 0; color:#4d5751; }
    .receipt-open { margin:.9rem 0 0; font-weight:800; } .patch,.evidence-output { margin-top:1rem; } .patch summary,.evidence-output summary { cursor:pointer; font-weight:700; } .patch pre,.evidence-output pre { max-height:24rem; font-size:.72rem; }
    .outcome-stub { width:min(100%,34rem); margin:-1rem auto 1rem; padding:1.2rem 1.15rem 1rem; color:#ecf4ef; border:1px dashed #b7cbc0; background:#254039; text-align:center; } .outcome-stub h2 { margin-bottom:.5rem; font-size:1rem; text-transform:uppercase; letter-spacing:.08em; } .outcome-stub strong { font-size:1.15rem; } .outcome-stub p { margin:.3rem 0 0; font-size:.78rem; } .stub-cut { color:#b7cbc0; letter-spacing:.05em; }
    .verify-ledger { width:min(100%,34rem); margin:1.6rem auto 2.5rem; padding:1rem; border-left:4px solid #9dd9bd; background:#223831; } .verify-ledger h2 { font-size:1rem; } .verify-ledger p { color:var(--muted); font-size:.86rem; } .verify-ledger pre { font-size:.72rem; }
    .counts { display:flex; flex-wrap:wrap; gap:.6rem; margin:2rem 0; } .counts p { margin:0; padding:.35rem .6rem; border:1px solid var(--line); color:var(--muted); font-size:.78rem; } .counts strong { color:#b5edce; }
    .gallery { margin-top:3rem; } .gallery-head { display:flex; gap:1rem; justify-content:space-between; align-items:end; flex-wrap:wrap; } .gallery-head h2 { margin-bottom:0; } .filters { display:flex; flex-wrap:wrap; gap:.4rem; } .filters button { color:var(--ink); border-color:var(--line); background:transparent; } .filters button[aria-pressed="true"] { color:#082d20; background:#b5edce; }
    .preview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:1rem; margin-top:1rem; } .receipt-preview { min-width:0; padding:1rem; border:1px solid var(--line); background:#21342f; } .receipt-preview[hidden] { display:none; } .receipt-preview.receipt--rehearsal { background:#3d4641; } .receipt-preview.receipt--self-run { border-top:5px solid #3c9b80; } .receipt-preview.receipt--verification { border:3px double #4ed18e; border-top-width:7px; } .receipt-preview.receipt--declared { border-top:5px dashed #d4aa5e; } .preview-id,.preview-class,.preview-issue,.preview-result,.preview-scope,.preview-attestation,.preview-outcome { margin-bottom:.5rem; } .preview-id { font-size:inherit; font-weight:800; letter-spacing:normal; text-transform:none; } .preview-result { padding:.55rem; background:#d9f0e4; color:#075238; font-weight:800; } .preview-class,.preview-scope,.preview-attestation,.preview-outcome { color:var(--muted); font-size:.75rem; } .preview-issue { font-size:.82rem; } .preview-link { display:inline-block; margin-top:.4rem; color:#b5edce; font-weight:800; }.noscript { color:var(--muted); }
    .rehearsal-archive { margin:3rem 0 0; padding:1rem; border:1px solid var(--line); color:var(--muted); } .rehearsal-archive > summary { color:var(--ink); cursor:pointer; font-weight:800; } .rehearsal-archive > p { margin:.8rem 0 0; font-size:.82rem; }
    .request-run { max-width:58rem; margin:3.5rem 0 0; padding:clamp(1rem,3vw,1.6rem); border:1px solid #689781; border-left:6px solid #9dd9bd; background:#21342f; } .receipt-page > .request-run { width:min(100%,46rem); margin:2.4rem auto 0; } .request-run h2 { margin-bottom:.75rem; font-size:clamp(1.35rem,4vw,2rem); } .request-run > p { max-width:68ch; } .request-actions { display:flex; flex-wrap:wrap; gap:.65rem; margin:1.15rem 0 .9rem; } .request-primary { font-weight:800; } .request-secondary { background:transparent; color:var(--ink); } .request-secondary:hover { color:#064b34; } .request-public-note,.request-onboarded { margin-bottom:.5rem; color:var(--muted); font-size:.78rem; } .request-onboarded code { color:#b5edce; }
    .claims { max-width:58rem; margin:3.5rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); }.claims h2 { color:var(--ink); }.site-footer { max-width:58rem; margin:2rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.78rem; }.page-nav { width:min(100%,34rem); margin:0 auto 1rem; color:var(--muted); font-size:.78rem; }.page-nav p { margin:.5rem 0 0; overflow-wrap:anywhere; }.page-actions,.page-action-buttons { display:flex; align-items:center; gap:.6rem; }.page-actions { justify-content:space-between; }.page-action-buttons { justify-content:flex-end; flex-wrap:wrap; }
    @media (max-width:58rem) { .hero { grid-template-columns:1fr; } .hero-intro,.hero > .receipt,.hero > .outcome-stub,.hero > .verify-ledger { grid-column:1; grid-row:auto; } .hero-notes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:34rem) { .receipt { margin-left:0; margin-right:0; padding:.85rem; } .receipt-meta { grid-template-columns:1fr; } .facts { grid-template-columns:1fr; gap:.15rem; } .hero-notes { grid-template-columns:1fr; } .page-actions { align-items:flex-start; flex-direction:column; } .page-action-buttons { justify-content:flex-start; } dd { margin-bottom:.55rem; } }
    @media print { @page { size:80mm 800mm; margin:4mm; } :root,html,body { color-scheme:light; background:#fff; color:#000; } body { font-size:9pt; } main,.receipt-page { width:auto; padding:0; margin:0; } .mast,.counts,.gallery,.claims,.site-footer,.page-nav,.verify-ledger,.receipt-open,.outcome-stub,.request-run { display:none !important; } .patch,.evidence-output { display:none !important; } .receipt { display:block; width:72mm; max-width:100%; margin:0; box-shadow:none; transform:none; } .facts,.receipt-meta { grid-template-columns:1fr; gap:.15rem; } .facts dd,.receipt-meta dd { margin-bottom:.45rem; } .receipt .button-link,.receipt button { display:none; } .proof-scope,.limitations,.verification,.receipt-disclosure,.qr-link { break-inside:avoid; page-break-inside:avoid; } .qr-link { display:flex; } a { color:inherit; text-decoration:none; } }
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
    for (const button of filters) button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      for (const candidate of filters) candidate.setAttribute('aria-pressed', String(candidate === button));
      for (const card of cards) {
        const matches = filter === 'all'
          || (filter === 'changes_requested'
            ? card.dataset.reviewDecision === 'changes_requested'
            : card.dataset.publicationState === filter);
        card.hidden = !matches;
      }
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
  const indexFields = ['generated_at', 'missions', 'version'];
  if (Object.keys(index).sort().join('\0') !== indexFields.join('\0')) {
    throw new TypeError('index contains a missing or extra top-level field');
  }
  if (index.version !== '0') throw new TypeError('index version must be 0');
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

  const siteRoot = path.dirname(out);
  const receiptsRoot = path.join(siteRoot, 'receipts');
  await mkdir(receiptsRoot, { recursive: true });
  await writeOutput(out, renderLedgerHtml(index));
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
  for (const mission of index.missions) {
    const receipt = mission.receipt;
    renderedIds.add(receipt.mission_id);
    const receiptDirectory = path.join(receiptsRoot, receipt.mission_id);
    await writeOutput(path.join(receiptDirectory, 'index.html'), renderReceiptPage(receipt, index.generated_at));
    await writeOutput(
      path.join(receiptDirectory, 'receipt.json'),
      `${JSON.stringify(publicReceiptSummary(receipt, index.generated_at), null, 2)}\n`,
    );
  }
  for (const entry of await readdir(receiptsRoot, { withFileTypes: true })) {
    if (GENERATED_RECEIPT_PATTERN.test(entry.name) && !renderedIds.has(entry.name)) {
      await rm(path.join(receiptsRoot, entry.name), { recursive: true, force: true });
    }
  }
  return { missions: index.missions.length, pages: index.missions.length + 1 };
}
