import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { validateMission } from './mission-validator.mjs';
import { assertProofOfPass } from './proof-of-pass.mjs';
import { assertReceiptParity } from './receipt-parity.mjs';
import { redactJsonStrings, redactText, sortRedactions } from './redact.mjs';

const RUN_RECORD_FIELDS = new Set([
  'schema_version',
  'started_at',
  'finished_at',
  'environment',
  'commands',
  'notes',
  'redactions',
]);
const REQUIRED_RUN_RECORD_FIELDS = ['started_at', 'finished_at', 'environment', 'commands', 'notes'];
const ENVIRONMENT_FIELDS = new Set([
  'executor_profile', 'container_image_ref', 'container_image_digest', 'container_image_id',
  'container_os', 'container_architecture', 'network_policy', 'source_commit',
  'base_tree_digest', 'pre_check_tree_digest', 'approved_tracked_tree_digest',
  'post_check_tree_digest', 'check_tree_changed', 'patch_sha256', 'install_commands',
]);
const OPTIONAL_BUNDLE_FILES = ['issue_snapshot.json', 'patch.diff', 'ci_links.json'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUNDLE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^(?:[^\s@]+@)?sha256:[0-9a-fA-F]{64}$/;
const CONSENT_FIELDS = new Set([
  'schema_version', 'mission_id', 'variant', 'consent_artifact', 'granted_at',
  'granted_by', 'publication_consent', 'scope',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function addError(errors, ruleId, errorPath, message) {
  errors.push({ ruleId, path: errorPath, message });
}

function requireField(errors, value, field, parentPath) {
  if (!Object.hasOwn(value, field)) {
    addError(errors, 'RUN_RECORD_REQUIRED', `${parentPath}.${field}`, 'is required');
    return false;
  }
  return true;
}

function requireType(errors, value, type, errorPath, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  const valid =
    (type === 'object' && isObject(value)) ||
    (type === 'array' && Array.isArray(value)) ||
    (type === 'integer' && Number.isInteger(value)) ||
    (type !== 'object' && type !== 'array' && type !== 'integer' && typeof value === type);
  if (!valid) addError(errors, 'RUN_RECORD_TYPE', errorPath, `must be ${nullable ? `${type} or null` : type}`);
  return valid;
}

/**
 * Validate the caller-supplied run record.
 *
 * @param {unknown} runRecord
 * @returns {{valid: boolean, errors: Array<{ruleId: string, path: string, message: string}>}}
 */
export function validateRunRecord(runRecord) {
  const errors = [];
  if (!isObject(runRecord)) {
    addError(errors, 'RUN_RECORD_TYPE', '$', 'must be object');
    return { valid: false, errors };
  }

  for (const key of Object.keys(runRecord).sort()) {
    if (!RUN_RECORD_FIELDS.has(key)) {
      addError(errors, 'RUN_RECORD_ADDITIONAL_PROPERTY', `$.${key}`, 'is not an allowed property');
    }
  }
  for (const field of REQUIRED_RUN_RECORD_FIELDS) requireField(errors, runRecord, field, '$');
  if (Object.hasOwn(runRecord, 'schema_version') && runRecord.schema_version !== 1) {
    addError(errors, 'RUN_RECORD_VERSION', '$.schema_version', 'must equal 1');
  }

  for (const field of ['started_at', 'finished_at']) {
    if (Object.hasOwn(runRecord, field) && requireType(errors, runRecord[field], 'string', `$.${field}`)) {
      if (!isIsoDateTime(runRecord[field])) {
        addError(errors, 'RUN_RECORD_FORMAT', `$.${field}`, 'must be an ISO-8601 date-time');
      }
    }
  }
  if (isIsoDateTime(runRecord.started_at) && isIsoDateTime(runRecord.finished_at)
    && Date.parse(runRecord.finished_at) < Date.parse(runRecord.started_at)) {
    addError(errors, 'RUN_RECORD_TIME_ORDER', '$.finished_at', 'must not precede started_at');
  }

  if (Object.hasOwn(runRecord, 'environment') && requireType(errors, runRecord.environment, 'object', '$.environment')) {
    for (const key of Object.keys(runRecord.environment).sort()) {
      if (!ENVIRONMENT_FIELDS.has(key)) {
        addError(errors, 'RUN_RECORD_ADDITIONAL_PROPERTY', `$.environment.${key}`, 'is not an allowed property');
      }
    }
    for (const field of ['container_image_digest', 'network_policy']) {
      requireField(errors, runRecord.environment, field, '$.environment');
    }
    if (Object.hasOwn(runRecord.environment, 'container_image_digest')) {
      const digest = runRecord.environment.container_image_digest;
      if (
        requireType(
          errors,
          digest,
          'string',
          '$.environment.container_image_digest',
          { nullable: true },
        ) &&
        digest !== null &&
        !IMAGE_DIGEST_PATTERN.test(digest)
      ) {
        // The digest is a machine identifier, never prose — a free-text digest would dodge
        // the receipt's language rules on a publicly bundled field.
        addError(
          errors,
          'RUN_RECORD_FORMAT',
          '$.environment.container_image_digest',
          'must be an optional image reference followed by sha256: and 64 hexadecimal characters',
        );
      }
    }
    if (Object.hasOwn(runRecord.environment, 'network_policy')) {
      requireType(errors, runRecord.environment.network_policy, 'string', '$.environment.network_policy');
    }
    if (Object.hasOwn(runRecord.environment, 'container_image_id')) {
      const value = runRecord.environment.container_image_id;
      if (requireType(errors, value, 'string', '$.environment.container_image_id')
        && !/^sha256:[0-9a-f]{64}$/.test(value)) {
        addError(errors, 'RUN_RECORD_FORMAT', '$.environment.container_image_id', 'must be an immutable sha256 image id');
      }
    }
    for (const field of ['executor_profile', 'container_image_ref', 'container_os', 'container_architecture']) {
      if (Object.hasOwn(runRecord.environment, field)) {
        const value = runRecord.environment[field];
        if (requireType(errors, value, 'string', `$.environment.${field}`) && value.length === 0) {
          addError(errors, 'RUN_RECORD_FORMAT', `$.environment.${field}`, 'must be non-blank');
        }
      }
    }
    if (runRecord.schema_version === 1) {
      for (const field of ENVIRONMENT_FIELDS) requireField(errors, runRecord.environment, field, '$.environment');
    }
    // Derived code-provenance fields (executor-populated). Machine identifiers only — a forged
    // run record cannot smuggle prose into a bundled, publicly-rendered field.
    if (Object.hasOwn(runRecord.environment, 'source_commit')) {
      const value = runRecord.environment.source_commit;
      if (requireType(errors, value, 'string', '$.environment.source_commit', { nullable: true }) &&
        value !== null && !/^[0-9a-f]{40}$/.test(value)) {
        addError(errors, 'RUN_RECORD_FORMAT', '$.environment.source_commit', 'must be 40 lowercase hex characters or null');
      }
    }
    for (const field of ['base_tree_digest', 'pre_check_tree_digest', 'post_check_tree_digest', 'approved_tracked_tree_digest', 'patch_sha256']) {
      if (Object.hasOwn(runRecord.environment, field)) {
        const value = runRecord.environment[field];
        if (requireType(errors, value, 'string', `$.environment.${field}`, { nullable: true }) &&
          value !== null && !BUNDLE_DIGEST_PATTERN.test(value)) {
          addError(errors, 'RUN_RECORD_FORMAT', `$.environment.${field}`, 'must be sha256: followed by 64 hex characters or null');
        }
      }
    }
    if (Object.hasOwn(runRecord.environment, 'check_tree_changed')) {
      requireType(errors, runRecord.environment.check_tree_changed, 'boolean', '$.environment.check_tree_changed');
    }
    if (Object.hasOwn(runRecord.environment, 'install_commands')) {
      const value = runRecord.environment.install_commands;
      if (requireType(errors, value, 'array', '$.environment.install_commands')) {
        value.forEach((item, index) => requireType(errors, item, 'string', `$.environment.install_commands[${index}]`));
      }
    }
  }

  if (Object.hasOwn(runRecord, 'commands') && requireType(errors, runRecord.commands, 'array', '$.commands')) {
    runRecord.commands.forEach((command, index) => {
      const commandPath = `$.commands[${index}]`;
      if (!requireType(errors, command, 'object', commandPath)) return;
      for (const key of Object.keys(command).sort()) {
        if (!['cmd', 'exit_code', 'duration_ms', 'timed_out'].includes(key)) {
          addError(errors, 'RUN_RECORD_ADDITIONAL_PROPERTY', `${commandPath}.${key}`, 'is not an allowed property');
        }
      }
      for (const field of ['cmd', 'exit_code', 'duration_ms']) requireField(errors, command, field, commandPath);
      if (Object.hasOwn(command, 'cmd')) requireType(errors, command.cmd, 'string', `${commandPath}.cmd`);
      if (Object.hasOwn(command, 'exit_code')) {
        requireType(errors, command.exit_code, 'integer', `${commandPath}.exit_code`, { nullable: true });
      }
      if (Object.hasOwn(command, 'duration_ms') && requireType(errors, command.duration_ms, 'integer', `${commandPath}.duration_ms`)
        && command.duration_ms < 0) {
        addError(errors, 'RUN_RECORD_RANGE', `${commandPath}.duration_ms`, 'must be non-negative');
      }
      if (Object.hasOwn(command, 'timed_out')) {
        requireType(errors, command.timed_out, 'boolean', `${commandPath}.timed_out`);
      }
      if (
        Object.hasOwn(command, 'exit_code') &&
        ((command.exit_code === null) !== (command.timed_out === true))
      ) {
        addError(
          errors,
          'RUN_RECORD_TIMEOUT_INVARIANT',
          commandPath,
          'exit_code must be null if and only if timed_out is true',
        );
      }
    });
  }

  if (Object.hasOwn(runRecord, 'notes')) {
    requireType(errors, runRecord.notes, 'string', '$.notes', { nullable: true });
  }
  if (Object.hasOwn(runRecord, 'redactions') && requireType(errors, runRecord.redactions, 'object', '$.redactions')) {
    for (const [key, value] of Object.entries(runRecord.redactions)) {
      if (!/^[a-z][a-z0-9_]*$/.test(key) || !Number.isInteger(value) || value < 0) {
        addError(errors, 'RUN_RECORD_REDACTIONS', `$.redactions.${key}`, 'must be a non-negative integer under a machine key');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validatePublicConsent(consent, mission) {
  const errors = [];
  if (!isObject(consent)) return { valid: false, errors: [{ ruleId: 'CONSENT_TYPE', path: '$', message: 'must be object' }] };
  for (const field of CONSENT_FIELDS) {
    if (!Object.hasOwn(consent, field)) errors.push({ ruleId: 'CONSENT_REQUIRED', path: `$.${field}`, message: 'is required' });
  }
  for (const field of Object.keys(consent)) {
    if (!CONSENT_FIELDS.has(field)) errors.push({ ruleId: 'CONSENT_ADDITIONAL_PROPERTY', path: `$.${field}`, message: 'is not allowed' });
  }
  if (consent.schema_version !== 1) errors.push({ ruleId: 'CONSENT_VERSION', path: '$.schema_version', message: 'must equal 1' });
  if (consent.mission_id !== mission.mission_id) errors.push({ ruleId: 'CONSENT_BINDING', path: '$.mission_id', message: 'must match mission_id' });
  if (consent.variant !== mission.variant || !['V', 'W', 'F'].includes(consent.variant)) errors.push({ ruleId: 'CONSENT_BINDING', path: '$.variant', message: 'must match a consented mission variant' });
  if (consent.consent_artifact !== mission.consent_artifact) errors.push({ ruleId: 'CONSENT_BINDING', path: '$.consent_artifact', message: 'must match mission consent_artifact' });
  if (!isIsoDateTime(consent.granted_at)) errors.push({ ruleId: 'CONSENT_FORMAT', path: '$.granted_at', message: 'must be ISO-8601 date-time' });
  if (typeof consent.granted_by !== 'string' || consent.granted_by.trim() === '') errors.push({ ruleId: 'CONSENT_TYPE', path: '$.granted_by', message: 'must be non-blank string' });
  if (consent.publication_consent !== true) errors.push({ ruleId: 'CONSENT_PUBLICATION', path: '$.publication_consent', message: 'must equal true' });
  if (!Array.isArray(consent.scope) || consent.scope.length === 0 || consent.scope.some((item) => typeof item !== 'string' || item.trim() === '')) {
    errors.push({ ruleId: 'CONSENT_TYPE', path: '$.scope', message: 'must be a non-empty string array' });
  }
  return { valid: errors.length === 0, errors };
}

export class BundleError extends Error {
  constructor(message, errors) {
    super(message);
    this.name = 'BundleError';
    this.errors = errors;
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function digestEntries(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.path}\0${file.sha256}\n`);
  return `sha256:${hash.digest('hex')}`;
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function listFiles(directory, prefix = '') {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

async function fileEntry(directory, relativePath) {
  const value = await readFile(path.join(directory, ...relativePath.split('/')));
  return { path: relativePath, sha256: sha256(value), bytes: value.byteLength };
}

async function fileExists(file) {
  try {
    return (await lstat(file)).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJsonFile(file, ruleId) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new BundleError(`cannot read ${file}`, [{ ruleId: 'CLI_READ', path: file, message: error.message }]);
  }
  try {
    return { source, value: JSON.parse(source) };
  } catch (error) {
    throw new BundleError(`invalid JSON in ${file}`, [{ ruleId, path: file, message: error.message }]);
  }
}

/**
 * Create or replace <missionDirectory>/bundle and return its deterministic digest.
 *
 * @param {string} missionDirectory
 * @param {{stdoutFile: string, stderrFile: string, runRecordFile: string, createdAt: string}} options
 * @returns {Promise<{bundleDirectory: string, bundleDigest: string, manifest: object}>}
 */
export async function createBundle(missionDirectory, options) {
  if (!isIsoDateTime(options?.createdAt)) {
    throw new BundleError('invalid created_at', [{
      ruleId: 'CREATED_AT_FORMAT',
      path: '--created-at',
      message: 'must be an ISO-8601 date-time',
    }]);
  }

  const missionFile = path.join(missionDirectory, 'mission.json');
  const missionResult = await readJsonFile(missionFile, 'MISSION_JSON_PARSE');
  const validation = validateMission(missionResult.value);
  if (!validation.valid) throw new BundleError('mission validation failed', validation.errors);
  const mission = missionResult.value;

  const consentFile = path.join(missionDirectory, 'consent.json');
  const hasConsent = await fileExists(consentFile);
  if (['V', 'W', 'F'].includes(mission.variant) && !hasConsent) {
    throw new BundleError('consent file is required', [{
      ruleId: 'CONSENT_FILE_REQUIRED',
      path: consentFile,
      message: `variant ${mission.variant} requires consent.json`,
    }]);
  }
  if (hasConsent) {
    const consent = await readJsonFile(consentFile, 'CONSENT_JSON_PARSE');
    const consentValidation = validatePublicConsent(consent.value, mission);
    if (!consentValidation.valid) throw new BundleError('consent validation failed', consentValidation.errors);
  }

  const runRecordResult = await readJsonFile(options.runRecordFile, 'RUN_RECORD_JSON_PARSE');
  const runRecordValidation = validateRunRecord(runRecordResult.value);
  if (!runRecordValidation.valid) {
    throw new BundleError('run record validation failed', runRecordValidation.errors);
  }

  let stdout;
  let stderr;
  try {
    [stdout, stderr] = await Promise.all([
      readFile(options.stdoutFile, 'utf8'),
      readFile(options.stderrFile, 'utf8'),
    ]);
  } catch (error) {
    throw new BundleError('cannot read captured output', [{
      ruleId: 'CLI_READ',
      path: '$',
      message: error.message,
    }]);
  }

  const redactions = {};
  const redactedRunRecord = redactJsonStrings(runRecordResult.value, redactions);
  const redactedStdout = redactText(stdout, redactions);
  const redactedStderr = redactText(stderr, redactions);
  redactedRunRecord.redactions = sortRedactions(redactions);

  const bundleDirectory = path.join(missionDirectory, 'bundle');
  const temporaryDirectory = await mkdtemp(path.join(missionDirectory, '.bundle-tmp-'));
  try {
    await Promise.all([
      writeFile(path.join(temporaryDirectory, 'mission.json'), missionResult.source),
      writeFile(path.join(temporaryDirectory, 'base_commit.txt'), mission.base_commit ?? 'null'),
      writeFile(path.join(temporaryDirectory, 'commands.json'), json({ commands: mission.commands_declared })),
      writeFile(path.join(temporaryDirectory, 'run_record.json'), json(redactedRunRecord)),
      writeFile(path.join(temporaryDirectory, 'stdout_redacted.txt'), redactedStdout),
      writeFile(path.join(temporaryDirectory, 'stderr_redacted.txt'), redactedStderr),
      writeFile(path.join(temporaryDirectory, 'maintainer_outcome.json'), json(mission.maintainer_outcome)),
      writeFile(path.join(temporaryDirectory, 'claims_tier.txt'), mission.claims_tier.join(',')),
    ]);

    if (mission.variant !== 'own_repo_rehearsal' && hasConsent) {
      await copyFile(consentFile, path.join(temporaryDirectory, 'consent.json'));
    }
    for (const name of OPTIONAL_BUNDLE_FILES) {
      const source = path.join(missionDirectory, name);
      if (await fileExists(source)) await copyFile(source, path.join(temporaryDirectory, name));
    }

    const names = (await listFiles(temporaryDirectory)).sort();
    const files = await Promise.all(names.map((name) => fileEntry(temporaryDirectory, name)));
    const manifest = {
      version: '0',
      created_at: options.createdAt,
      files,
      bundle_digest: digestEntries(files),
    };
    await writeFile(path.join(temporaryDirectory, 'bundle.manifest.json'), json(manifest));

    await rm(bundleDirectory, { recursive: true, force: true });
    await rename(temporaryDirectory, bundleDirectory);
    return { bundleDirectory, bundleDigest: manifest.bundle_digest, manifest };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function validManifest(manifest) {
  if (!isObject(manifest) || manifest.version !== '0' || !isIsoDateTime(manifest.created_at)) return false;
  if (!Array.isArray(manifest.files) || !BUNDLE_DIGEST_PATTERN.test(manifest.bundle_digest)) return false;
  const seen = new Set();
  let previous = null;
  for (const file of manifest.files) {
    if (
      !isObject(file) ||
      typeof file.path !== 'string' ||
      file.path.length === 0 ||
      file.path === 'bundle.manifest.json' ||
      file.path.startsWith('/') ||
      file.path.split('/').includes('..') ||
      !SHA256_PATTERN.test(file.sha256) ||
      !Number.isInteger(file.bytes) ||
      file.bytes < 0 ||
      seen.has(file.path) ||
      (previous !== null && comparePaths(previous, file.path) >= 0)
    ) return false;
    seen.add(file.path);
    previous = file.path;
  }
  return true;
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function semanticIssues(missionDirectory, bundleDirectory) {
  const issues = [];
  const issue = (pathName, message) => issues.push({ kind: 'semantic', path: pathName, message });
  let mission;
  let runRecord;
  let commands;
  let outcome;
  try {
    mission = JSON.parse(await readFile(path.join(bundleDirectory, 'mission.json'), 'utf8'));
    const validation = validateMission(mission);
    if (!validation.valid) issue('mission.json', 'bundled mission fails policy validation');
  } catch (error) {
    issue('mission.json', error.message);
    return issues;
  }
  try {
    const outerMission = JSON.parse(await readFile(path.join(missionDirectory, 'mission.json'), 'utf8'));
    try {
      assertReceiptParity(outerMission, mission);
    } catch (error) {
      issue('mission.json', error.message);
    }
  } catch (error) {
    issue('mission.json', `cannot compare mission envelope: ${error.message}`);
  }
  try {
    runRecord = JSON.parse(await readFile(path.join(bundleDirectory, 'run_record.json'), 'utf8'));
    if (!validateRunRecord(runRecord).valid) issue('run_record.json', 'run record fails strict validation');
  } catch (error) {
    issue('run_record.json', error.message);
  }
  try {
    commands = JSON.parse(await readFile(path.join(bundleDirectory, 'commands.json'), 'utf8'));
    if (!isObject(commands) || Object.keys(commands).length !== 1 || !Array.isArray(commands.commands)) {
      issue('commands.json', 'must contain exactly one commands array');
    } else {
      if (!equalJson(commands.commands, mission.commands_declared)) {
        issue('commands.json', 'commands must match mission.commands_declared byte-for-byte');
      }
      if (runRecord && !equalJson(commands.commands, runRecord.commands?.map(({ cmd }) => cmd))) {
        issue('commands.json', 'commands must match run_record commands one-to-one');
      }
    }
  } catch (error) {
    issue('commands.json', error.message);
  }
  try {
    const base = await readFile(path.join(bundleDirectory, 'base_commit.txt'), 'utf8');
    if (base !== (mission.base_commit ?? 'null')) issue('base_commit.txt', 'must match mission.base_commit');
  } catch (error) {
    issue('base_commit.txt', error.message);
  }
  try {
    const claims = await readFile(path.join(bundleDirectory, 'claims_tier.txt'), 'utf8');
    if (claims !== mission.claims_tier.join(',')) issue('claims_tier.txt', 'must match mission.claims_tier');
  } catch (error) {
    issue('claims_tier.txt', error.message);
  }
  try {
    outcome = JSON.parse(await readFile(path.join(bundleDirectory, 'maintainer_outcome.json'), 'utf8'));
    if (!equalJson(outcome, mission.maintainer_outcome)) issue('maintainer_outcome.json', 'must match mission.maintainer_outcome');
  } catch (error) {
    issue('maintainer_outcome.json', error.message);
  }
  try {
    const patchFile = path.join(bundleDirectory, 'patch.diff');
    const patchExists = await fileExists(patchFile);
    if (mission.patch_diff_hash === null && patchExists) issue('patch.diff', 'must be absent when patch_diff_hash is null');
    if (mission.patch_diff_hash !== null && !patchExists) issue('patch.diff', 'is required when patch_diff_hash is recorded');
    if (patchExists) {
      const digest = `sha256:${sha256(await readFile(patchFile))}`;
      if (digest !== mission.patch_diff_hash) issue('patch.diff', 'SHA-256 must match mission.patch_diff_hash');
      if (Object.hasOwn(runRecord?.environment ?? {}, 'patch_sha256')
        && runRecord.environment.patch_sha256 !== digest) {
        issue('patch.diff', 'SHA-256 must match run_record environment.patch_sha256');
      }
    }
  } catch (error) {
    issue('patch.diff', error.message);
  }
  if (runRecord) {
    try {
      assertProofOfPass(mission, runRecord);
    } catch (error) {
      issue('run_record.json', error.message);
    }
    if (Object.hasOwn(runRecord.environment ?? {}, 'source_commit')
      && (mission.base_commit ?? null) !== runRecord.environment.source_commit) {
      issue('run_record.json', 'source_commit must match mission.base_commit');
    }
  }
  if (['V', 'W', 'F'].includes(mission.variant)) {
    try {
      const consent = JSON.parse(await readFile(path.join(bundleDirectory, 'consent.json'), 'utf8'));
      if (!validatePublicConsent(consent, mission).valid) issue('consent.json', 'must be a valid consent receipt bound to the mission');
    } catch (error) {
      issue('consent.json', error.message);
    }
  }
  return issues;
}

/**
 * Verify every file in <missionDirectory>/bundle against its manifest.
 *
 * @param {string} missionDirectory
 * @returns {Promise<{ok: boolean, bundleDigest: string|null, issues: Array<{kind: string, path: string}>}>}
 */
export async function verifyBundle(missionDirectory) {
  const bundleDirectory = path.join(missionDirectory, 'bundle');
  const manifestPath = path.join(bundleDirectory, 'bundle.manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      bundleDigest: null,
      issues: [{ kind: 'manifest', path: 'bundle.manifest.json', message: error.message }],
    };
  }
  if (!validManifest(manifest)) {
    return {
      ok: false,
      bundleDigest: typeof manifest?.bundle_digest === 'string' ? manifest.bundle_digest : null,
      issues: [{ kind: 'manifest', path: 'bundle.manifest.json', message: 'invalid manifest structure' }],
    };
  }

  const allActualNames = await listFiles(bundleDirectory);
  const typeIssues = [];
  for (const name of allActualNames) {
    const stats = await lstat(path.join(bundleDirectory, ...name.split('/')));
    if (!stats.isFile()) typeIssues.push({ kind: 'type', path: name, message: 'bundle members must be regular files' });
  }
  const actualNames = allActualNames
    .filter((name) => name !== 'bundle.manifest.json')
    .sort();
  const regularNames = actualNames.filter((name) => !typeIssues.some((item) => item.path === name));
  const actualFiles = await Promise.all(regularNames.map((name) => fileEntry(bundleDirectory, name)));
  const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  const issues = [...typeIssues];

  for (const expected of manifest.files) {
    const actual = actualByPath.get(expected.path);
    if (!actual) {
      issues.push({ kind: 'missing', path: expected.path });
    } else if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      issues.push({ kind: 'mismatched', path: expected.path });
    }
  }
  for (const actual of actualFiles) {
    if (!expectedByPath.has(actual.path)) issues.push({ kind: 'extra', path: actual.path });
  }

  const actualBundleDigest = digestEntries(actualFiles);
  if (actualBundleDigest !== manifest.bundle_digest) {
    issues.push({ kind: 'bundle_digest', path: 'bundle.manifest.json' });
  }
  if (issues.length === 0) issues.push(...await semanticIssues(missionDirectory, bundleDirectory));

  return {
    ok: issues.length === 0,
    bundleDigest: manifest.bundle_digest,
    issues,
  };
}
