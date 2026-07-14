import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateMission } from './mission-validator.mjs';
import { createReceiptQr } from './receipt-qr.mjs';

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
const RECEIPT_BASE_URL = 'https://northset-oss.github.io/verification-pilot/receipts';
const VERIFY_WORKFLOW = 'northset-oss/verification-pilot/.github/workflows/attest-bundle.yml';
const ATTESTATION_URI_PREFIX = 'https://github.com/northset-oss/verification-pilot/releases/download/';
const GENERATED_RECEIPT_PATTERN = /^M-(?:\d{3}|E2[a-c])$/;
const CONSENT_VARIANTS = new Set(['V', 'W', 'F']);

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
  if (value.schema_version !== 1 || value.mission_id !== missionId) {
    throw new TypeError('publication schema_version or mission_id is invalid');
  }
  if (!PUBLICATION_STATES.has(value.state)) throw new TypeError(`publication state is invalid: ${value.state}`);
  if (value.review_decision !== null && !REVIEW_DECISIONS.has(value.review_decision)) {
    throw new TypeError(`publication review_decision is invalid: ${value.review_decision}`);
  }
  for (const field of ['pr_url', 'pr_head_oid', 'decision_url', 'opened_at', 'closed_at', 'updated_at',
    'correction_note', 'attestation_uri', 'bundle_digest', 'release_asset_sha256', 'ci_state',
    'merge_commit_oid', 'base_branch']) {
    if (value[field] !== undefined && value[field] !== null && typeof value[field] !== 'string') {
      throw new TypeError(`publication ${field} must be a string or null`);
    }
  }
  if (value.pr_url !== null && value.pr_url !== undefined && !/^https:\/\/github\.com\//.test(value.pr_url)) {
    throw new TypeError('publication pr_url must be a GitHub URL or null');
  }
  if (value.pr_head_oid !== null && value.pr_head_oid !== undefined && !/^[0-9a-f]{40}$/i.test(value.pr_head_oid)) {
    throw new TypeError('publication pr_head_oid must be a full commit OID or null');
  }
  if (value.merge_commit_oid !== null && value.merge_commit_oid !== undefined && !/^[0-9a-f]{40}$/i.test(value.merge_commit_oid)) {
    throw new TypeError('publication merge_commit_oid must be a full commit OID or null');
  }
  if (value.pr_number !== null && value.pr_number !== undefined && (!Number.isInteger(value.pr_number) || value.pr_number < 1)) {
    throw new TypeError('publication pr_number must be a positive integer or null');
  }
  if (value.head_drift !== null && value.head_drift !== undefined && typeof value.head_drift !== 'boolean') {
    throw new TypeError('publication head_drift must be boolean or null');
  }
  if (
    typeof value.attestation_uri === 'string'
    && !value.attestation_uri.startsWith(ATTESTATION_URI_PREFIX)
  ) {
    throw new TypeError('publication attestation_uri must point to the signing repository release');
  }
  return value;
}

async function publicationFor(missionFile, missionId) {
  const file = path.join(path.dirname(missionFile), 'publication.json');
  try {
    return validatePublication(JSON.parse(await readFile(file, 'utf8')), missionId);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
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
    return {
      status: publicationOutcome(publication),
      link: decisionUrl ?? prUrl,
      attribution: decisionUrl === null ? 'Live upstream pull request' : 'Maintainer decision',
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
  const runRecord = await readJson(path.join(missionDirectory, 'bundle', 'run_record.json'), 'bundle/run_record.json');
  const publication = suppliedPublication === undefined
    ? await publicationFor(missionFile, mission.mission_id)
    : suppliedPublication;
  const manifest = await readJsonIfPresent(path.join(missionDirectory, 'bundle', 'bundle.manifest.json'), 'bundle/bundle.manifest.json');
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

  const imageRef = requiredString(environment.container_image_ref, 'bundle/run_record.json:environment.container_image_ref');
  const imageDigest = requiredString(environment.container_image_digest, 'bundle/run_record.json:environment.container_image_digest');
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
  const attestationUri = requireAgreement(
    [publicationAttestation, missionAttestation],
    'attestation URI',
  );
  const baseCommit = optionalString(mission.base_commit, 'mission.json:base_commit');
  const sourceCommit = optionalString(environment.source_commit, 'bundle/run_record.json:environment.source_commit');
  if (baseCommit !== null && sourceCommit !== null && baseCommit !== sourceCommit) {
    throw new TypeError('mission.json:base_commit must equal bundle/run_record.json:environment.source_commit');
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
  const allPassed = successfulChecks === commands.length;
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
    issue_or_task: validUrl(mission.issue_or_task, 'mission.json:issue_or_task'),
    worker_identity: {
      runtime: requiredString(identity.runtime, 'mission.json:worker_identity.runtime'),
      human_operator: requiredString(identity.human_operator, 'mission.json:worker_identity.human_operator'),
    },
    code: {
      base_commit: baseCommit,
      tested_commit: optionalString(mission.patch_commit, 'mission.json:patch_commit'),
      patch_diff_hash: patchDiffHash,
    },
    started_at: startedAt,
    finished_at: finishedAt,
    environment: {
      container_image_ref: imageRef,
      container_image_digest: imageDigest,
      network_policy: networkPolicy,
      source_commit: sourceCommit,
      install_commands: Array.isArray(environment.install_commands)
        ? environment.install_commands.map((command, index) => requiredString(command, `bundle/run_record.json:environment.install_commands[${index}]`))
        : [],
    },
    commands,
    declared_checks: declared.length,
    successful_checks: successfulChecks,
    result: allPassed
      ? `PASS — ${successfulChecks}/${declared.length} declared check${declared.length === 1 ? '' : 's'}`
      : `NOT PASS — ${successfulChecks}/${declared.length} declared check${declared.length === 1 ? '' : 's'} returned exit 0`,
    wall_duration_ms: timingConsistent ? wallDurationMs : null,
    setup_install_duration_ms: setupInstallDurationMs,
    payment: {
      maintainer_payment: requiredString(payment.maintainer_payment, 'mission.json:payment.maintainer_payment'),
      merge_contingent: payment.merge_contingent === true,
    },
    redactions: redactionEntries(runRecord.redactions),
    limitations,
    bundle_digest: bundleDigest,
    attestation_uri: attestationUri,
    verify_command: formatVerifyCommand(attestationUri),
    download_url: attestationUri,
    patch_diff: patch,
    stdout_redacted: stdoutRedacted,
    stderr_redacted: stderrRedacted,
    correction_note: optionalString(publication?.correction_note, 'publication.json:correction_note'),
    publication,
    live_outcome: outcomeFor(mission, publication),
  };
}

/**
 * Build and write a deterministic public ledger index with normalized receipt view models.
 */
export async function buildLedger({ missionsDir, out, now = null, onWarning = () => {} }) {
  const directoryEntries = await readdir(missionsDir, { withFileTypes: true });
  const missionFiles = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(missionsDir, entry.name, 'mission.json'))
    .sort();
  const missions = [];
  let skipped = 0;

  for (const missionFile of missionFiles) {
    let mission;
    try {
      mission = JSON.parse(await readFile(missionFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${error.message}`);
      continue;
    }
    const validation = validateMission(mission);
    if (!validation.valid) {
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${formatValidationErrors(validation.errors)}`);
      continue;
    }

    const publication = await publicationFor(missionFile, mission.mission_id);
    const receipt = await buildReceiptViewModel({ missionFile, mission, publication });
    const projected = projectMission(mission);
    projected.receipt = receipt;
    projected.publication = publication;
    if (publication !== null) {
      projected.maintainer_outcome = {
        status: publicationOutcome(publication),
        link: publication.decision_url ?? publication.pr_url,
      };
      if (publication.bundle_digest) projected.run_record_bundle_digest = publication.bundle_digest;
      if (publication.attestation_uri) projected.attestation_uri = publication.attestation_uri;
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
    receipt.code.tested_commit === null ? '' : `<dt>tested</dt><dd><code>${escapeHtml(receipt.code.tested_commit)}</code></dd>`,
    receipt.code.patch_diff_hash === null ? '' : `<dt>patch</dt><dd><code>${escapeHtml(receipt.code.patch_diff_hash)}</code></dd>`,
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
  return `<section class="outcome-stub" aria-label="Live upstream outcome"><p class="stub-cut">- - - detach here - - -</p><h2>Live upstream outcome</h2>${state}</section>`;
}

function renderReceipt(receipt, { featured = false, page = false } = {}) {
  const commandLines = receipt.commands.map((command) => {
    const durationLabel = formatDuration(command.duration_ms);
    const status = command.timed_out ? 'timed out' : `exit ${command.exit_code}`;
    return `<li><pre><code>${escapeHtml(command.cmd)}</code></pre><p class="command-result">${escapeHtml(status)}${durationLabel === null ? '' : ` · ${escapeHtml(durationLabel)}`}</p></li>`;
  }).join('');
  const work = [
    receipt.issue_or_task === null ? '' : link(receipt.issue_or_task, issueLabel(receipt.issue_or_task)),
    receipt.publication?.pr_url ? link(receipt.publication.pr_url, prLabel(receipt.publication)) : '',
  ].filter(Boolean).join(' · ') || 'No issue or pull request recorded';
  const setupDuration = receipt.setup_install_duration_ms === null
    ? ''
    : `<p class="duration-line">setup + install (derived) <span>${escapeHtml(formatDuration(receipt.setup_install_duration_ms))}</span></p>`;
  const wallDuration = receipt.wall_duration_ms === null
    ? ''
    : `<p class="duration-line">run wall (derived from recorded timestamps) <span>${escapeHtml(formatDuration(receipt.wall_duration_ms))}</span></p>`;
  const scopeNote = receipt.successful_checks === receipt.declared_checks
    ? 'Every command listed returned exit 0 in the declared environment.'
    : `${receipt.successful_checks}/${receipt.declared_checks} declared checks returned exit 0 in the declared environment.`;
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
  const verification = receipt.attestation_uri === null
    ? '<p>Attestation URL was not recorded.</p>'
    : `<p>${link(receipt.attestation_uri, 'Download attested bundle', 'button-link')}</p>`;
  const attestationScope = '<p class="attestation-scope">Attestation confirms that Northset\'s signing workflow produced this exact bundle. The signer does not witness the recorded run, and verification does not turn it into maintainer verification.</p>';
  const verify = receipt.verify_command === null
    ? ''
    : `<div class="verify-command"><pre><code>${escapeHtml(receipt.verify_command)}</code></pre><button type="button" data-copy="${escapeHtml(receipt.verify_command)}">Copy verify command</button></div>`;
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
  return `<article class="receipt ${receiptClass(receipt)}${featured ? ' receipt--featured' : ''}"${articleId}>
  <header class="receipt-head">
    <p class="brand">NORTHSET</p>
    ${heading}
    <p class="class-stamp">${escapeHtml(receipt.classification)}</p>
    ${consent}
    <dl class="receipt-meta"><div><dt>Receipt</dt><dd>${escapeHtml(receipt.mission_id)}</dd></div><div><dt>Run start</dt><dd>${escapeHtml(receipt.started_at)}</dd></div><div><dt>Run finish</dt><dd>${escapeHtml(receipt.finished_at)}</dd></div></dl>
  </header>
  <section class="receipt-section">${receiptSectionHeading('Project', page)}<p>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p>${receiptSectionHeading('Work', page)}<p>${work}</p>${receiptSectionHeading('Served by', page)}<p>${escapeHtml(receipt.worker_identity.runtime)}<br>operator: ${escapeHtml(receipt.worker_identity.human_operator)}</p></section>
  ${renderCodeLines(receipt, { page })}
  <section class="receipt-section">${receiptSectionHeading('Environment', page)}<dl class="facts"><dt>image</dt><dd>${escapeHtml(receipt.environment.container_image_ref)}<br><code>${escapeHtml(receipt.environment.container_image_digest)}</code></dd><dt>network</dt><dd>${escapeHtml(receipt.environment.network_policy)}</dd></dl></section>
  <section class="receipt-section proof-scope">${receiptSectionHeading('Declared checks', page)}<ol class="commands">${commandLines}</ol>${setupDuration}${wallDuration}<p class="total">${escapeHtml(receipt.result)}</p><p class="scope-note">${escapeHtml(scopeNote)}</p></section>
  <section class="receipt-section">${receiptSectionHeading('Record details', page)}<dl class="facts"><dt>payment</dt><dd>${escapeHtml(receipt.payment.maintainer_payment)} · ${receipt.payment.merge_contingent ? 'merge-contingent' : 'not merge-contingent'}</dd><dt>redactions</dt><dd>${escapeHtml(redactionsLabel(receipt.redactions))}</dd><dt>bundle</dt><dd><code>${escapeHtml(receipt.bundle_digest)}</code></dd></dl></section>
  <section class="receipt-section limitations">${receiptSectionHeading('NOT INCLUDED', page)}<ul>${receipt.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
  ${correction}
  <section class="receipt-section verification">${receiptSectionHeading('Attestation and bundle', page)}${verification}${verify}${attestationScope}<a class="qr-link" href="${escapeHtml(qrLink)}" aria-label="Canonical receipt page for ${escapeHtml(receipt.mission_id)}">${qr.svg}<span>QR → receipt page</span></a></section>
  <footer class="receipt-disclosure"><strong>${escapeHtml(receipt.disclosure_label)}</strong><p>Evidence of what ran — not a verdict that the code is good.</p>${fundingDisclosure}</footer>
  ${patch}
  ${rawOutput}
  ${pageLink}
</article>${renderOutcomeStub(receipt)}`.replaceAll(/^[ \t]+$/gm, '');
}

function renderPreview(receipt, { includeAnchor = true } = {}) {
  const status = receipt.live_outcome === null ? 'rehearsal' : receipt.live_outcome.status;
  const attestation = receipt.attestation_uri === null ? 'not recorded' : 'recorded';
  const anchor = includeAnchor ? ` id="${escapeHtml(receipt.mission_id)}"` : '';
  return `<article class="receipt-preview ${receiptClass(receipt)}"${anchor} data-outcome="${escapeHtml(status)}"><p class="preview-id">${escapeHtml(receipt.mission_id)}</p><p class="preview-class">${escapeHtml(receipt.classification)}</p><p>${link(receipt.target_repo, repoLabel(receipt.target_repo))}</p><p class="preview-scope">${receipt.declared_checks} declared check${receipt.declared_checks === 1 ? '' : 's'} · command evidence and NOT INCLUDED on full receipt</p><p class="preview-attestation">attestation: ${attestation}</p><p class="preview-outcome">upstream: ${escapeHtml(outcomeLabel(status))}</p>${relativeLink(receipt.canonical_path, 'Open receipt →', 'preview-link')}</article>`;
}

function renderLedgerHtml(index) {
  const receipts = index.missions.map((mission) => mission.receipt);
  const featured = receipts.find((receipt) => receipt.mission_id === 'M-008') ?? null;
  const counts = {
    total: receipts.length,
    rehearsal: receipts.filter((receipt) => receipt.variant === 'own_repo_rehearsal').length,
    selfRun: receipts.filter((receipt) => receipt.variant === 'author_contribution').length,
    verification: receipts.filter((receipt) => receipt.variant === 'V').length,
  };
  const previews = receipts.map((receipt) => renderPreview(receipt, { includeAnchor: receipt.mission_id !== 'M-008' })).join('');
  const hero = featured === null
    ? '<p class="hero-missing">No committed M-008 receipt is available.</p>'
    : `${renderReceipt(featured, { featured: true })}<section class="verify-ledger"><h2>Verify this receipt</h2><p>Confirm where the attested bundle came from. This does not turn the recorded run into maintainer verification.</p>${featured.verify_command === null ? '' : `<pre><code>${escapeHtml(featured.verify_command)}</code></pre><button type="button" data-copy="${escapeHtml(featured.verify_command)}">Copy verify command</button>`}</section>`;
  const heroNotes = '<ol class="hero-notes" aria-label="How to read the featured receipt"><li class="hero-note"><strong>Exact commands</strong><span>Copied verbatim from the run record.</span></li><li class="hero-note"><strong>Recorded environment</strong><span>Image, digest, and network policy stay visible.</span></li><li class="hero-note"><strong>Scoped result</strong><span>Counted declared checks; never a bare PASS.</span></li><li class="hero-note"><strong>Separate outcome</strong><span>Later upstream decisions detach from run evidence.</span></li></ol>';
  return renderDocument({
    title: 'Northset Proof-of-Pass Receipts',
    body: `<main>
  <header class="mast"><p class="eyebrow">NORTHSET · PUBLIC LEDGER</p><h1>Proof-of-Pass Receipts</h1><p>Each receipt records exactly which declared commands ran, on recorded code and in a recorded environment. It is evidence of that run, not a verdict on code quality or maintainer approval.</p></header>
  <section class="hero"><div class="hero-intro"><p class="eyebrow">FEATURED RECEIPT</p><h2>One real run record, readable top to bottom.</h2>${heroNotes}</div>${hero}</section>
  <section class="counts" aria-label="Generated receipt counts"><p><strong>${counts.total}</strong> receipt${counts.total === 1 ? '' : 's'} generated from committed sources</p><p><strong>${counts.selfRun}</strong> contributor self-run</p><p><strong>${counts.rehearsal}</strong> rehearsal</p><p><strong>${counts.verification}</strong> maintainer-invited verification</p></section>
  <section class="gallery" aria-labelledby="receipt-gallery"><div class="gallery-head"><div><p class="eyebrow">RECEIPT LEDGER</p><h2 id="receipt-gallery">Find a receipt</h2></div><div class="filters" aria-label="Filter receipt previews"><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="merged">Merged</button><button type="button" data-filter="open">Open</button><button type="button" data-filter="closed_unmerged">Closed</button><button type="button" data-filter="changes_requested">Changes requested</button></div></div><noscript><p class="noscript">All receipt previews are shown. Filters are optional.</p></noscript><div class="preview-grid">${previews}</div></section>
  <section class="claims"><p class="eyebrow">CLAIMS BOUNDARY</p><h2>What a receipt does and does not say</h2><p>A receipt reports the exact declared commands, their recorded exit status, and the recorded execution environment from an immutable run bundle.</p><p>It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Live upstream outcomes are detached because a later maintainer decision is a different fact from the recorded run. Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section>
  <footer class="site-footer"><strong>SELF-FUNDED FIELD-TESTING.</strong> The reported external signal is the maintainer decision, which Northset does not control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>.</footer>
</main>`,
  });
}

function renderReceiptPage(receipt) {
  return renderDocument({
    title: `${receipt.mission_id} Proof-of-Pass Receipt`,
    body: `<main class="receipt-page"><header class="page-nav"><div class="page-actions"><a href="../../index.html">← All Proof-of-Pass Receipts</a><button type="button" data-print>Print 80 mm receipt</button></div><p>Canonical receipt · ${escapeHtml(receipt.canonical_url)}</p></header>${renderReceipt(receipt, { page: true })}<section class="claims receipt-page-claims" aria-labelledby="receipt-claims-boundary"><h2 id="receipt-claims-boundary">Claims boundary</h2><p>This page reports recorded run evidence. It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval. An attestation confirms bundle provenance; it does not broaden the receipt's claim.</p><p>Read the full <a href="https://github.com/northset-oss/verification-pilot/blob/main/policies/claims_boundary.md">Claims Boundary policy</a>.</p></section><footer class="site-footer receipt-page-footer">The reported external signal is the maintainer decision, which Northset does not control. Source: <a href="https://github.com/northset-oss/verification-pilot">northset-oss/verification-pilot</a>.</footer></main>`,
  });
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
    .mast { max-width:68ch; margin-bottom:2rem; } .mast > p:last-child { color:var(--muted); }
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
    .preview-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); gap:1rem; margin-top:1rem; } .receipt-preview { min-width:0; padding:1rem; border:1px solid var(--line); background:#21342f; } .receipt-preview[hidden] { display:none; } .receipt-preview.receipt--rehearsal { background:#3d4641; } .receipt-preview.receipt--self-run { border-top:5px solid #3c9b80; } .receipt-preview.receipt--verification { border:3px double #4ed18e; border-top-width:7px; } .receipt-preview.receipt--declared { border-top:5px dashed #d4aa5e; } .preview-id,.preview-class,.preview-scope,.preview-attestation,.preview-outcome { margin-bottom:.5rem; } .preview-id { font-weight:800; } .preview-class,.preview-scope,.preview-attestation,.preview-outcome { color:var(--muted); font-size:.75rem; } .preview-link { display:inline-block; margin-top:.4rem; color:#b5edce; font-weight:800; }.noscript { color:var(--muted); }
    .claims { max-width:58rem; margin:3.5rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); }.claims h2 { color:var(--ink); }.site-footer { max-width:58rem; margin:2rem 0 0; padding-top:1rem; border-top:1px solid var(--line); color:var(--muted); font-size:.78rem; }.page-nav { width:min(100%,34rem); margin:0 auto 1rem; color:var(--muted); font-size:.78rem; }.page-nav p { margin:.5rem 0 0; overflow-wrap:anywhere; }.page-actions { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
    @media (max-width:58rem) { .hero { grid-template-columns:1fr; } .hero-intro,.hero > .receipt,.hero > .outcome-stub,.hero > .verify-ledger { grid-column:1; grid-row:auto; } .hero-notes { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:34rem) { .receipt { margin-left:0; margin-right:0; padding:.85rem; } .receipt-meta { grid-template-columns:1fr; } .facts { grid-template-columns:1fr; gap:.15rem; } .hero-notes { grid-template-columns:1fr; } dd { margin-bottom:.55rem; } }
    @media print { @page { size:80mm 800mm; margin:4mm; } :root,html,body { color-scheme:light; background:#fff; color:#000; } body { font-size:9pt; } main,.receipt-page { width:auto; padding:0; margin:0; } .mast,.counts,.gallery,.claims,.site-footer,.page-nav,.verify-ledger,.receipt-open,.outcome-stub,.patch,.evidence-output { display:none !important; } .receipt { display:block; width:72mm; max-width:100%; margin:0; box-shadow:none; transform:none; } .receipt .button-link,.receipt button { display:none; } .proof-scope,.limitations,.verification,.receipt-disclosure,.qr-link { break-inside:avoid; page-break-inside:avoid; } .qr-link { display:flex; } a { color:inherit; text-decoration:none; } }
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
    const cards = document.querySelectorAll('.receipt-preview');
    for (const button of filters) button.addEventListener('click', () => {
      const filter = button.dataset.filter;
      for (const candidate of filters) candidate.setAttribute('aria-pressed', String(candidate === button));
      for (const card of cards) card.hidden = filter !== 'all' && card.dataset.outcome !== filter;
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
  if (typeof index !== 'object' || index === null || !Array.isArray(index.missions)) {
    throw new TypeError('index must be an object with a missions array');
  }
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
  const renderedIds = new Set();
  for (const mission of index.missions) {
    const receipt = mission.receipt;
    renderedIds.add(receipt.mission_id);
    await writeOutput(path.join(receiptsRoot, receipt.mission_id, 'index.html'), renderReceiptPage(receipt));
  }
  for (const entry of await readdir(receiptsRoot, { withFileTypes: true })) {
    if (GENERATED_RECEIPT_PATTERN.test(entry.name) && !renderedIds.has(entry.name)) {
      await rm(path.join(receiptsRoot, entry.name), { recursive: true, force: true });
    }
  }
  return { missions: index.missions.length, pages: index.missions.length + 1 };
}
