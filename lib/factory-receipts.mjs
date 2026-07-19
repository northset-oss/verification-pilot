import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const MISSION_PATTERN = /^M-(?:\d{3,}|E2[a-c])$/;
const OID_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_REPOSITORY_URL = 'https://github.com/northset-oss/verification-pilot';
const RECEIPT_BASE_URL = 'https://northset-oss.github.io/verification-pilot/receipts';
const execFileAsync = promisify(execFile);

async function git(repositoryPath, args, {buffer = false} = {}) {
  const {stdout} = await execFileAsync('git', ['-C', repositoryPath, ...args], {
    encoding: buffer ? null : 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  });
  return buffer ? stdout : stdout.trim();
}

function nulPaths(value) {
  return value.toString('utf8').split('\0').filter(Boolean);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function validMissionId(value) {
  if (typeof value !== 'string' || !MISSION_PATTERN.test(value)) {
    throw new TypeError('invalid factory receipt mission_id');
  }
  return value;
}

function validOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a full git OID`);
  }
  return value;
}

function validDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a sha256 digest`);
  }
  return value;
}

function validTime(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 time`);
  }
  return value;
}

function validRepository(value, label) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validIssueNumber(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} is invalid`);
  return value;
}

function nonBlank(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-blank string`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${label} must be a string array`);
  }
  return [...value];
}

function validateCommonProof(proof, missionId, commitOid) {
  if (proof.mission_id !== missionId) throw new TypeError(`${missionId} proof identity is invalid`);
  validOid(proof.base_oid, `${missionId} base_oid`);
  validOid(proof.commit_oid, `${missionId} commit_oid`);
  validOid(proof.tested_tree_oid, `${missionId} tested_tree_oid`);
  if (proof.commit_oid !== commitOid) throw new TypeError(`${missionId} proof path does not match commit_oid`);
  validDigest(proof.patch_sha256, `${missionId} patch_sha256`);
  validDigest(proof.batch_approval_digest, `${missionId} batch_approval_digest`);
  validRepository(proof.repository, `${missionId} repository`);
  validIssueNumber(proof.issue_number, `${missionId} issue_number`);
  if (!Array.isArray(proof.checks) || proof.checks.length === 0) {
    throw new TypeError(`${missionId} checks must be a non-empty array`);
  }
  if (!isObject(proof.claim) || typeof proof.claim.type !== 'string' || typeof proof.claim.statement !== 'string') {
    throw new TypeError(`${missionId} claim is invalid`);
  }
  if (!isObject(proof.environment) || !isObject(proof.base_observation) || !isObject(proof.patched_observation)) {
    throw new TypeError(`${missionId} recorded environment or observations are invalid`);
  }
}

function validateLegacyProof(proof, missionId, commitOid) {
  const required = [
    'schema_version', 'mission_id', 'task_id', 'repository', 'issue_number', 'candidate',
    'base_oid', 'patch_sha256', 'commit_oid', 'tested_tree_oid', 'checks', 'claim',
    'batch_approval_digest', 'environment', 'base_observation', 'patched_observation',
  ];
  if (!exactKeys(proof, required) || proof.schema_version !== 1) {
    throw new TypeError(`${missionId} legacy proof.json has an invalid shape`);
  }
  validateCommonProof(proof, missionId, commitOid);
  if (proof.checks.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new TypeError(`${missionId} legacy checks must be non-blank strings`);
  }
  return proof;
}

function validateExecutedCommand(value, missionId, index) {
  const label = `${missionId} executed_commands[${index}]`;
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  const required = [
    'phase', 'command', 'network', 'expected_result', 'result', 'expectation_met',
    'started_at', 'finished_at', 'duration_ms', 'exit_code', 'stdout_sha256',
    'stderr_sha256', 'output_sha256',
  ];
  if (!exactKeys(value, required)) throw new TypeError(`${label} has an invalid shape`);
  nonBlank(value.phase, `${label}.phase`);
  if (!(typeof value.command === 'string' || (Array.isArray(value.command)
    && value.command.length > 0 && value.command.every((part) => typeof part === 'string')))) {
    throw new TypeError(`${label}.command must be a string or string array`);
  }
  nonBlank(value.network, `${label}.network`);
  if (!['success', 'failure', 'nonzero'].includes(value.expected_result)) {
    throw new TypeError(`${label}.expected_result is invalid`);
  }
  if (!['PASS', 'FAIL'].includes(value.result) || typeof value.expectation_met !== 'boolean') {
    throw new TypeError(`${label} result is invalid`);
  }
  validTime(value.started_at, `${label}.started_at`);
  validTime(value.finished_at, `${label}.finished_at`);
  if (Date.parse(value.finished_at) < Date.parse(value.started_at)) {
    throw new TypeError(`${label} timestamps are reversed`);
  }
  if (!Number.isInteger(value.duration_ms) || value.duration_ms < 0) {
    throw new TypeError(`${label}.duration_ms is invalid`);
  }
  if (!Number.isInteger(value.exit_code)) throw new TypeError(`${label}.exit_code is invalid`);
  for (const field of ['stdout_sha256', 'stderr_sha256', 'output_sha256']) {
    validDigest(value[field], `${label}.${field}`);
  }
  if ((value.exit_code === 0) !== (value.result === 'PASS')) {
    throw new TypeError(`${label} result does not match its exit code`);
  }
  const expectedSuccess = value.expected_result === 'success';
  if (value.expectation_met !== (expectedSuccess ? value.exit_code === 0 : value.exit_code !== 0)) {
    throw new TypeError(`${label} expectation does not match its exit code`);
  }
  return value;
}

function validateCheckNotRun(value, missionId, index) {
  const label = `${missionId} checks_not_run[${index}]`;
  if (!isObject(value) || !exactKeys(value, ['check', 'reason'])) {
    throw new TypeError(`${label} has an invalid shape`);
  }
  const check = typeof value.check === 'string' ? value.check : JSON.stringify(value.check);
  return {check: nonBlank(check, `${label}.check`), reason: nonBlank(value.reason, `${label}.reason`)};
}

function validateStructuredProof(proof, missionId, commitOid) {
  const required = [
    'schema_version', 'mission_id', 'task_id', 'repository', 'issue_number', 'candidate',
    'base_oid', 'patch_sha256', 'commit_oid', 'tested_tree_oid', 'checks', 'claim',
    'batch_approval_digest', 'environment', 'base_observation', 'patched_observation',
    'executed_commands', 'checks_not_run', 'limitations', 'verification_started_at',
    'verification_finished_at',
  ];
  if (!exactKeys(proof, required) || proof.schema_version !== 2) {
    throw new TypeError(`${missionId} structured proof.json has an invalid shape`);
  }
  validateCommonProof(proof, missionId, commitOid);
  if (!Array.isArray(proof.executed_commands) || proof.executed_commands.length !== 2) {
    throw new TypeError(`${missionId} executed_commands must contain base and patched observations`);
  }
  proof.executed_commands.forEach((entry, index) => validateExecutedCommand(entry, missionId, index));
  if (proof.executed_commands[0].phase !== 'base_observation' ||
      proof.executed_commands[1].phase !== 'patched_observation') {
    throw new TypeError(`${missionId} executed_commands must be ordered base then patched`);
  }
  if (JSON.stringify(proof.base_observation) !== JSON.stringify(proof.executed_commands[0]) ||
      JSON.stringify(proof.patched_observation) !== JSON.stringify(proof.executed_commands[1])) {
    throw new TypeError(`${missionId} structured observations contradict executed_commands`);
  }
  if (!Array.isArray(proof.checks_not_run)) throw new TypeError(`${missionId} checks_not_run must be an array`);
  if (!Array.isArray(proof.limitations)) throw new TypeError(`${missionId} limitations must be an array`);
  proof.checks_not_run = proof.checks_not_run.map((entry, index) => validateCheckNotRun(entry, missionId, index));
  proof.limitations = stringArray(proof.limitations, `${missionId} limitations`);
  validTime(proof.verification_started_at, `${missionId} verification_started_at`);
  validTime(proof.verification_finished_at, `${missionId} verification_finished_at`);
  if (Date.parse(proof.verification_finished_at) < Date.parse(proof.verification_started_at)) {
    throw new TypeError(`${missionId} verification timestamps are reversed`);
  }
  if (proof.executed_commands.some((entry) => entry.expectation_met !== true)) {
    throw new TypeError(`${missionId} cannot publish PASS when an executed command missed its declared expectation`);
  }
  const passCommands = proof.executed_commands.filter((entry) => entry.expected_result === 'success');
  const patchedCommands = proof.executed_commands.filter((entry) => entry.phase === 'patched_observation');
  if (passCommands.length === 0 || passCommands.some((entry) => entry.exit_code !== 0 || entry.result !== 'PASS')) {
    throw new TypeError(`${missionId} cannot publish PASS without successful structured command evidence`);
  }
  if (patchedCommands.length !== 1 || patchedCommands[0].exit_code !== 0 || patchedCommands[0].result !== 'PASS') {
    throw new TypeError(`${missionId} cannot publish PASS without a successful patched observation`);
  }
  return proof;
}

function validateProof(proof, missionId, commitOid) {
  if (!isObject(proof)) throw new TypeError(`${missionId} proof.json must be an object`);
  if (proof.schema_version === 1) return validateLegacyProof(proof, missionId, commitOid);
  if (proof.schema_version === 2) return validateStructuredProof(proof, missionId, commitOid);
  throw new TypeError(`${missionId} proof schema_version is unsupported`);
}

function validatePointer(pointer, missionId) {
  const required = ['schema_version', 'mission_id', 'contribution_commit_oid', 'proof_sha256'];
  if (!exactKeys(pointer, required) || pointer.schema_version !== 1 || pointer.mission_id !== missionId) {
    throw new TypeError(`${missionId} current.json is invalid`);
  }
  validOid(pointer.contribution_commit_oid, `${missionId} current contribution_commit_oid`);
  validDigest(pointer.proof_sha256, `${missionId} current proof_sha256`);
  return pointer;
}

function validHttpsUrl(value, label, {nullable = false} = {}) {
  if (value === null && nullable) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('not HTTPS');
    return url.href;
  } catch {
    throw new TypeError(`${label} must be an HTTPS URL${nullable ? ' or null' : ''}`);
  }
}

function validateFactoryPublication(value, missionId, commitOid) {
  const required = [
    'schema_version', 'mission_id', 'contribution_commit_oid', 'receipt_url', 'pr_url',
    'pr_number', 'pr_state', 'merged', 'ci_state', 'attestation_state',
    'attestation_url', 'observed_at',
  ];
  if (!exactKeys(value, required) || value.schema_version !== 1 || value.mission_id !== missionId) {
    throw new TypeError(`${missionId} publication.json has an invalid shape`);
  }
  if (value.contribution_commit_oid !== commitOid) {
    throw new TypeError(`${missionId} publication contribution commit does not match current proof`);
  }
  validHttpsUrl(value.receipt_url, `${missionId} publication receipt_url`);
  validHttpsUrl(value.pr_url, `${missionId} publication pr_url`);
  validIssueNumber(value.pr_number, `${missionId} publication pr_number`);
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(value.pr_state)) {
    throw new TypeError(`${missionId} publication pr_state is invalid`);
  }
  if (typeof value.merged !== 'boolean' || value.merged !== (value.pr_state === 'MERGED')) {
    throw new TypeError(`${missionId} publication merged state is inconsistent`);
  }
  if (!(value.ci_state === null || (typeof value.ci_state === 'string' && value.ci_state.length > 0))) {
    throw new TypeError(`${missionId} publication ci_state is invalid`);
  }
  nonBlank(value.attestation_state, `${missionId} publication attestation_state`);
  validHttpsUrl(value.attestation_url, `${missionId} publication attestation_url`, {nullable: true});
  validTime(value.observed_at, `${missionId} publication observed_at`);
  return value;
}

async function publicationFor(missionDirectory, missionId, commitOid) {
  const file = path.join(missionDirectory, commitOid, 'publication.json');
  try {
    const {bytes, value} = await readJson(file, `${missionId} publication.json`);
    return {bytes, value: validateFactoryPublication(value, missionId, commitOid)};
  } catch (error) {
    if (/unreadable: ENOENT/.test(error.message)) return null;
    throw error;
  }
}

async function readJson(file, label) {
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new TypeError(`${label} is unreadable: ${error.message}`);
  }
  try {
    return {bytes, value: JSON.parse(bytes.toString('utf8'))};
  } catch {
    throw new TypeError(`${label} is not valid JSON`);
  }
}

async function currentPointer(missionDirectory, missionId) {
  try {
    const {value} = await readJson(path.join(missionDirectory, 'current.json'), `${missionId} current.json`);
    return validatePointer(value, missionId);
  } catch (error) {
    if (!/unreadable: ENOENT/.test(error.message)) throw error;
    const entries = (await readdir(missionDirectory, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory() && OID_PATTERN.test(entry.name));
    if (entries.length !== 1) {
      throw new TypeError(`${missionId} needs current.json when it has ${entries.length} proof directories`);
    }
    const commitOid = entries[0].name;
    const {bytes} = await readJson(path.join(missionDirectory, commitOid, 'proof.json'), `${missionId} proof.json`);
    return {
      schema_version: 1,
      mission_id: missionId,
      contribution_commit_oid: commitOid,
      proof_sha256: digest(bytes),
    };
  }
}

function commandLabel(command) {
  return Array.isArray(command) ? JSON.stringify(command) : command;
}

function environmentFor(proof) {
  const image = typeof proof.environment.image === 'string' && proof.environment.image.trim()
    ? proof.environment.image : 'not recorded';
  const architecture = typeof proof.environment.architecture === 'string'
    ? proof.environment.architecture : null;
  const network = typeof proof.environment.network === 'string' && proof.environment.network.trim()
    ? proof.environment.network : 'not recorded';
  return {
    container_image_ref: image,
    container_image_digest: SHA256_PATTERN.test(image) ? image : null,
    container_image_id: null,
    container_os: null,
    container_architecture: architecture,
    network_policy: network,
    workspace_mode: null,
    workspace_write_allowlist: [],
    workspace_file_count_limit: null,
    workspace_bytes_limit: null,
    initial_workspace_manifest_digest: null,
    post_run_changed_tracked_paths: [],
    post_run_untracked_paths: [],
    post_run_mode_changes: [],
    source_commit: proof.commit_oid,
    install_commands: [],
  };
}

function sourceFor(proof, proofSha256, rawProofUrl, publicationRecord) {
  const source = {
    receipt_class: 'factory_contributor_self_run',
    proof_schema_version: proof.schema_version,
    proof_sha256: proofSha256,
    raw_proof_url: rawProofUrl,
  };
  if (publicationRecord !== null) {
    source.publication_sha256 = digest(publicationRecord.bytes);
    source.raw_publication_url = rawProofUrl.replace(/proof\.json$/, 'publication.json');
    source.factory_publication = {
      pr_state: publicationRecord.value.pr_state,
      ci_state: publicationRecord.value.ci_state,
      merged: publicationRecord.value.merged,
      attestation_state: publicationRecord.value.attestation_state,
      attestation_url: publicationRecord.value.attestation_url,
      observed_at: publicationRecord.value.observed_at,
    };
  }
  return source;
}

function canonicalPublication(publicationRecord) {
  if (publicationRecord === null) return null;
  const value = publicationRecord.value;
  const state = value.merged || value.pr_state === 'MERGED'
    ? 'merged'
    : value.pr_state === 'CLOSED' ? 'closed_unmerged' : 'open';
  return {
    schema_version: 1,
    mission_id: value.mission_id,
    state,
    pr_number: value.pr_number,
    pr_url: value.pr_url,
    pr_head_oid: value.contribution_commit_oid,
    base_branch: null,
    head_drift: false,
    ci_state: value.ci_state === null ? null : value.ci_state.toLowerCase(),
    merge_commit_oid: null,
    review_decision: null,
    decision_url: null,
    opened_at: null,
    closed_at: state === 'open' ? null : value.observed_at,
    updated_at: value.observed_at,
    observed_at: value.observed_at,
    correction_note: null,
    scope_note: null,
    attestation_uri: null,
    bundle_digest: null,
    release_asset_sha256: null,
    attestation_verified_at: null,
  };
}

function baseReceipt(proof, proofSha256, rawProofUrl, publicationRecord) {
  const missionId = proof.mission_id;
  const publication = canonicalPublication(publicationRecord);
  return {
    version: 3,
    mission_id: missionId,
    canonical_path: `receipts/${missionId}/`,
    canonical_url: `${RECEIPT_BASE_URL}/${missionId}/`,
    variant: 'author_contribution',
    classification: 'CONTRIBUTOR SELF-RUN — NOT MAINTAINER VERIFICATION',
    disclosure_label: 'Contributor self-run from immutable factory proof; not maintainer verification.',
    consent_artifact: null,
    target_repo: `https://github.com/${proof.repository}`,
    issue_or_task: `https://github.com/${proof.repository}/issues/${proof.issue_number}`,
    issue_title: null,
    worker_identity: {
      runtime: typeof proof.environment.profile === 'string' ? `Northset factory (${proof.environment.profile})` : 'Northset factory',
      human_operator: 'Northset mission operator',
    },
    code: {
      base_commit: proof.base_oid,
      recorded_patch_commit: proof.commit_oid,
      patch_commit_binding: 'bound to verified tested tree',
      tested_tree_oid: proof.tested_tree_oid,
      patch_diff_hash: proof.patch_sha256,
      patch_diff_binding: 'bound to executed patch bytes',
    },
    environment: environmentFor(proof),
    economic_identity: null,
    payment: {maintainer_payment: 'none recorded', merge_contingent: false},
    redactions: [],
    bundle_digest: null,
    release_asset_sha256: null,
    attestation_verified_at: null,
    attestation_uri: null,
    verify_command: null,
    download_url: null,
    patch_diff: null,
    stdout_redacted: null,
    stderr_redacted: null,
    correction_note: null,
    scope_note: null,
    publication,
    live_outcome: publication === null ? null : {
      status: publication.state,
      link: publication.pr_url,
      attribution: 'Factory publication observation',
    },
    source: sourceFor(proof, proofSha256, rawProofUrl, publicationRecord),
  };
}

function structuredReceipt(proof, proofSha256, rawProofUrl, publicationRecord) {
  const passCommands = proof.executed_commands.filter((entry) => entry.expected_result === 'success');
  const commands = passCommands.map((entry) => ({
    cmd: commandLabel(entry.command),
    exit_code: entry.exit_code,
    timed_out: false,
    duration_ms: entry.duration_ms,
  }));
  const startedAt = proof.verification_started_at;
  const finishedAt = proof.verification_finished_at;
  const count = commands.length;
  const limitations = [
    ...proof.limitations,
    'Contributor self-run; not maintainer verification.',
    'Does not prove code quality, security, full CI coverage, production readiness, or maintainer approval.',
  ];
  return {
    ...baseReceipt(proof, proofSha256, rawProofUrl, publicationRecord),
    evidence_status: 'complete',
    started_at: startedAt,
    finished_at: finishedAt,
    commands,
    checks_not_run: proof.checks_not_run,
    legacy_checks: [],
    declared_checks: count,
    successful_checks: count,
    result: `PASS — ${count}/${count} declared command${count === 1 ? '' : 's'}`,
    execution_summary: `${count}/${count} expected-success command${count === 1 ? '' : 's'} returned exit 0; all structured observations met their declared expectations`,
    wall_duration_ms: Date.parse(finishedAt) - Date.parse(startedAt),
    setup_install_duration_ms: null,
    limitations: [...new Set(limitations)],
  };
}

function legacyReceipt(proof, proofSha256, rawProofUrl, publicationRecord) {
  return {
    ...baseReceipt(proof, proofSha256, rawProofUrl, publicationRecord),
    evidence_status: 'incomplete',
    started_at: null,
    finished_at: null,
    commands: [],
    checks_not_run: [],
    legacy_checks: [...proof.checks],
    declared_checks: 0,
    successful_checks: 0,
    result: 'INCOMPLETE — structured command evidence unavailable',
    execution_summary: 'The legacy proof records a patched observation with exit code 0 but does not identify the executed command or its timing; no public PASS is derived.',
    wall_duration_ms: null,
    setup_install_duration_ms: null,
    limitations: [
      'Legacy factory proof: structured executed commands and verification timestamps were not recorded.',
      'The original free-form checks are preserved as legacy declarations and are not interpreted as executed command evidence.',
      'Contributor self-run; not maintainer verification.',
      'Does not prove code quality, security, full CI coverage, production readiness, or maintainer approval.',
    ],
  };
}

function projectFactoryProof(proof, proofSha256, rawProofUrl, publicationRecord) {
  return proof.schema_version === 2
    ? structuredReceipt(proof, proofSha256, rawProofUrl, publicationRecord)
    : legacyReceipt(proof, proofSha256, rawProofUrl, publicationRecord);
}

export async function selectFactoryProofAttestationSubjects({
  repositoryPath,
  receiptRevision,
  out,
} = {}) {
  if (![repositoryPath, out].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('repositoryPath and out are required');
  }
  validOid(receiptRevision, 'receiptRevision');
  const resolved = await git(repositoryPath, ['rev-parse', `${receiptRevision}^{commit}`]);
  if (resolved !== receiptRevision) throw new TypeError('receiptRevision does not resolve exactly');

  const ancestry = (await git(repositoryPath, ['rev-list', '--parents', '--max-count=1', receiptRevision]))
    .split(/\s+/);
  if (ancestry[0] !== receiptRevision || ancestry.length > 2) {
    throw new TypeError('receiptRevision must be a root or single-parent commit');
  }
  const range = ancestry.length === 1 ? ['--root', receiptRevision] : [ancestry[1], receiptRevision];
  const pathspec = 'receipts/*/*/proof.json';
  const all = nulPaths(await git(repositoryPath, [
    'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', ...range, '--', pathspec,
  ], {buffer: true})).sort();
  const added = nulPaths(await git(repositoryPath, [
    'diff-tree', '--no-commit-id', '--name-only', '--diff-filter=A', '-r', '-z',
    ...range, '--', pathspec,
  ], {buffer: true})).sort();
  if (new Set(all).size !== all.length || JSON.stringify(all) !== JSON.stringify(added)) {
    throw new TypeError('factory proof files are immutable and may only be added');
  }

  await mkdir(out, {recursive: true});
  if ((await readdir(out)).length !== 0) throw new TypeError('attestation subject directory must be empty');
  const subjects = [];
  for (const sourcePath of added) {
    const match = /^receipts\/(M-(?:\d{3,}|E2[a-c]))\/([a-f0-9]{40})\/proof\.json$/.exec(sourcePath);
    if (!match) throw new TypeError(`invalid factory proof path: ${sourcePath}`);
    const [, missionId, commitOid] = match;
    const tree = await git(repositoryPath, ['ls-tree', receiptRevision, '--', sourcePath]);
    const [metadata, treePath] = tree.split('\t');
    if (treePath !== sourcePath || !/^100644 blob [a-f0-9]{40}$/.test(metadata)) {
      throw new TypeError(`${sourcePath} must be a regular 100644 blob`);
    }
    const size = Number(await git(repositoryPath, ['cat-file', '-s', `${receiptRevision}:${sourcePath}`]));
    if (!Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) {
      throw new TypeError(`${sourcePath} exceeds the proof size limit`);
    }
    const bytes = await git(repositoryPath, ['show', `${receiptRevision}:${sourcePath}`], {buffer: true});
    let proof;
    try {
      proof = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new TypeError(`${sourcePath} is not valid JSON`);
    }
    validateProof(proof, missionId, commitOid);
    const outputName = `${missionId}-${commitOid}-proof.json`;
    await writeFile(path.join(out, outputName), bytes, {flag: 'wx'});
    subjects.push({
      source_path: sourcePath,
      output_name: outputName,
      proof_sha256: digest(bytes),
    });
  }
  return {receipt_revision: receiptRevision, subjects};
}

/** Merge immutable factory proofs into the canonical ledger's normalized receipt index. */
export async function mergeFactoryReceipts({
  receiptsDir,
  receiptRevision,
  indexPath,
  out,
  repositoryUrl = DEFAULT_REPOSITORY_URL,
} = {}) {
  if (![receiptsDir, receiptRevision, indexPath, out].every((value) => typeof value === 'string')) {
    throw new TypeError('receiptsDir, receiptRevision, indexPath, and out are required');
  }
  validOid(receiptRevision, 'receiptRevision');
  const {value: index} = await readJson(indexPath, 'canonical ledger index');
  if (!isObject(index) || index.version !== '0' || !Array.isArray(index.missions)) {
    throw new TypeError('canonical ledger index is invalid');
  }
  const existingIds = new Set(index.missions.map((mission) => mission?.receipt?.mission_id));
  const missionEntries = (await readdir(receiptsDir, {withFileTypes: true}))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const added = [];
  for (const entry of missionEntries) {
    const missionId = validMissionId(entry.name);
    if (existingIds.has(missionId)) throw new TypeError(`${missionId} collides with a canonical mission receipt`);
    const missionDirectory = path.join(receiptsDir, missionId);
    const pointer = await currentPointer(missionDirectory, missionId);
    const commitOid = pointer.contribution_commit_oid;
    const proofFile = path.join(missionDirectory, commitOid, 'proof.json');
    const {bytes, value} = await readJson(proofFile, `${missionId} proof.json`);
    if (digest(bytes) !== pointer.proof_sha256) {
      throw new TypeError(`${missionId} current proof digest does not match proof.json`);
    }
    const proof = validateProof(value, missionId, commitOid);
    const rawProofUrl = `${repositoryUrl}/blob/${receiptRevision}/receipts/${missionId}/${commitOid}/proof.json`;
    const publicationRecord = await publicationFor(missionDirectory, missionId, commitOid);
    const receipt = projectFactoryProof(proof, pointer.proof_sha256, rawProofUrl, publicationRecord);
    index.missions.push({
      mission_id: missionId,
      variant: receipt.variant,
      claims_tier: [],
      grade: null,
      target_repo: receipt.target_repo,
      issue_or_task: receipt.issue_or_task,
      consent_artifact: null,
      maintainer_outcome: receipt.live_outcome,
      run_record_bundle_digest: null,
      attestation_uri: null,
      disclosure_label: receipt.disclosure_label,
      attested: false,
      publication: receipt.publication,
      receipt,
    });
    existingIds.add(missionId);
    added.push({mission_id: missionId, evidence_status: receipt.evidence_status});
  }
  index.missions.sort((left, right) => left.mission_id.localeCompare(right.mission_id));
  await mkdir(path.dirname(out), {recursive: true});
  await writeFile(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  return {added, index};
}
