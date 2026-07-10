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
import { redactJsonStrings, redactText, sortRedactions } from './redact.mjs';

const RUN_RECORD_FIELDS = new Set([
  'started_at',
  'finished_at',
  'environment',
  'commands',
  'notes',
]);
const REQUIRED_RUN_RECORD_FIELDS = [...RUN_RECORD_FIELDS];
const OPTIONAL_BUNDLE_FILES = ['issue_snapshot.json', 'patch.diff', 'ci_links.json'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUNDLE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

  for (const field of ['started_at', 'finished_at']) {
    if (Object.hasOwn(runRecord, field) && requireType(errors, runRecord[field], 'string', `$.${field}`)) {
      if (!isIsoDateTime(runRecord[field])) {
        addError(errors, 'RUN_RECORD_FORMAT', `$.${field}`, 'must be an ISO-8601 date-time');
      }
    }
  }

  if (Object.hasOwn(runRecord, 'environment') && requireType(errors, runRecord.environment, 'object', '$.environment')) {
    for (const field of ['container_image_digest', 'network_policy']) {
      requireField(errors, runRecord.environment, field, '$.environment');
    }
    if (Object.hasOwn(runRecord.environment, 'container_image_digest')) {
      requireType(
        errors,
        runRecord.environment.container_image_digest,
        'string',
        '$.environment.container_image_digest',
        { nullable: true },
      );
    }
    if (Object.hasOwn(runRecord.environment, 'network_policy')) {
      requireType(errors, runRecord.environment.network_policy, 'string', '$.environment.network_policy');
    }
  }

  if (Object.hasOwn(runRecord, 'commands') && requireType(errors, runRecord.commands, 'array', '$.commands')) {
    runRecord.commands.forEach((command, index) => {
      const commandPath = `$.commands[${index}]`;
      if (!requireType(errors, command, 'object', commandPath)) return;
      for (const field of ['cmd', 'exit_code', 'duration_ms']) requireField(errors, command, field, commandPath);
      if (Object.hasOwn(command, 'cmd')) requireType(errors, command.cmd, 'string', `${commandPath}.cmd`);
      if (Object.hasOwn(command, 'exit_code')) requireType(errors, command.exit_code, 'integer', `${commandPath}.exit_code`);
      if (Object.hasOwn(command, 'duration_ms')) requireType(errors, command.duration_ms, 'integer', `${commandPath}.duration_ms`);
    });
  }

  if (Object.hasOwn(runRecord, 'notes')) {
    requireType(errors, runRecord.notes, 'string', '$.notes', { nullable: true });
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

  const consentFile = path.join(missionDirectory, 'consent.md');
  const hasConsent = await fileExists(consentFile);
  if (['V', 'W', 'F'].includes(mission.variant) && !hasConsent) {
    throw new BundleError('consent file is required', [{
      ruleId: 'CONSENT_FILE_REQUIRED',
      path: consentFile,
      message: `variant ${mission.variant} requires consent.md`,
    }]);
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
      await copyFile(consentFile, path.join(temporaryDirectory, 'consent.md'));
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

  const actualNames = (await listFiles(bundleDirectory))
    .filter((name) => name !== 'bundle.manifest.json')
    .sort();
  const actualFiles = await Promise.all(actualNames.map((name) => fileEntry(bundleDirectory, name)));
  const expectedByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  const issues = [];

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

  return {
    ok: issues.length === 0,
    bundleDigest: manifest.bundle_digest,
    issues,
  };
}
