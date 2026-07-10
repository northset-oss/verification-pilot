import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createBundle } from './bundle.mjs';
import { execute, validateExecutorConfig } from './executor.mjs';
import { buildLedger } from './ledger.mjs';
import { validateMission } from './mission-validator.mjs';

const INPUT_FIELDS = new Set([
  'mission',
  'repo_dir',
  'patch_file',
  'consent_file',
  'issue_snapshot_file',
  'ci_links_file',
  'executor',
]);
const EXECUTOR_INPUT_FIELDS = new Set([
  'image',
  'install_commands',
  'commands',
  'limits',
]);
const CONSENT_VARIANTS = new Set(['V', 'W', 'F']);
const REHEARSAL_DISCLOSURE = 'Self-funded rehearsal. Not external validation.';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pipelineIssue(ruleId, pathName, message) {
  return { ruleId, path: pathName, message };
}

export class PipelineError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'PipelineError';
    this.errors = errors;
  }
}

function configError(pathName, message) {
  return new PipelineError('mission input invalid', [
    pipelineIssue('PIPELINE_CONFIG', pathName, message),
  ]);
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
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

async function pathExists(file) {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateTopLevelInput(input) {
  if (!isObject(input)) throw configError('$', 'must be an object');

  for (const key of Object.keys(input).sort()) {
    if (!INPUT_FIELDS.has(key)) throw configError(`$.${key}`, 'is not an allowed property');
  }
  for (const field of INPUT_FIELDS) {
    if (!Object.hasOwn(input, field)) throw configError(`$.${field}`, 'is required');
  }
}

async function enforceConsentGate(input) {
  const validation = validateMission(input.mission);
  if (!validation.valid) {
    throw new PipelineError('mission receipt invalid', validation.errors);
  }

  const { mission } = input;
  if (CONSENT_VARIANTS.has(mission.variant)) {
    if (mission.consent_artifact === null || !isHttpUrl(mission.consent_artifact)) {
      throw new PipelineError('consent artifact is required', [
        pipelineIssue(
          'CONSENT_REQUIRED',
          '$.mission.consent_artifact',
          `variant ${mission.variant} requires a non-null consent artifact URL`,
        ),
      ]);
    }
    if (typeof input.consent_file !== 'string' || !path.isAbsolute(input.consent_file)) {
      throw new PipelineError('consent file is required', [
        pipelineIssue(
          'CONSENT_FILE_REQUIRED',
          '$.consent_file',
          `variant ${mission.variant} requires an absolute path to a readable consent file`,
        ),
      ]);
    }
    try {
      return await readFile(input.consent_file);
    } catch (error) {
      throw new PipelineError('consent file is required', [
        pipelineIssue(
          'CONSENT_FILE_REQUIRED',
          '$.consent_file',
          `cannot read consent file: ${error.message}`,
        ),
      ]);
    }
  }

  if (!mission.disclosure_label.includes(REHEARSAL_DISCLOSURE)) {
    throw new PipelineError('rehearsal disclosure is required', [
      pipelineIssue(
        'REHEARSAL_LABEL',
        '$.mission.disclosure_label',
        `must contain the exact substring "${REHEARSAL_DISCLOSURE}"`,
      ),
    ]);
  }

  if (input.consent_file === null) return null;
  if (typeof input.consent_file !== 'string' || !path.isAbsolute(input.consent_file)) {
    throw configError('$.consent_file', 'must be an absolute path or null');
  }
  try {
    return await readFile(input.consent_file);
  } catch (error) {
    throw configError('$.consent_file', `cannot read file: ${error.message}`);
  }
}

function validateFilePath(value, pathName, { nullable = true } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw configError(pathName, `must be an absolute path${nullable ? ' or null' : ''}`);
  }
}

function prepareExecutorConfig(input) {
  validateFilePath(input.repo_dir, '$.repo_dir', { nullable: false });
  validateFilePath(input.patch_file, '$.patch_file');
  validateFilePath(input.issue_snapshot_file, '$.issue_snapshot_file');
  validateFilePath(input.ci_links_file, '$.ci_links_file');

  if (!isObject(input.executor)) throw configError('$.executor', 'must be an object');
  for (const key of Object.keys(input.executor).sort()) {
    if (!EXECUTOR_INPUT_FIELDS.has(key)) {
      throw configError(`$.executor.${key}`, 'is not an allowed property');
    }
  }

  try {
    return validateExecutorConfig({
      ...input.executor,
      repo_dir: input.repo_dir,
      patch_file: input.patch_file,
    });
  } catch (error) {
    throw new PipelineError('executor config invalid', error.errors ?? [
      pipelineIssue('PIPELINE_CONFIG', '$.executor', error.message),
    ]);
  }
}

async function readOptionalArtifact(file, pathName) {
  if (file === null) return null;
  try {
    return await readFile(file);
  } catch (error) {
    throw configError(pathName, `cannot read file: ${error.message}`);
  }
}

async function restorePreviousMission({ missionDir, published, backupPath }) {
  if (published) await rm(missionDir, { recursive: true, force: true });
  if (backupPath !== null) await rename(backupPath, missionDir);
}

/**
 * Enforce mission consent policy, execute the mission, create its bundle, and refresh the ledger.
 *
 * @param {unknown} input
 * @param {{missionsDir: string, now?: string, force?: boolean, executeImpl?: typeof execute, ledgerImpl?: typeof buildLedger, onWarning?: (message: string) => void}} options
 * @returns {Promise<{missionDir: string, bundleDigest: string, ledgerIncluded: number, attestationPending: true}>}
 */
export async function runPipeline(input, options) {
  validateTopLevelInput(input);

  // Policy guard: this validation and consent-file read must complete before executeImpl.
  const consent = await enforceConsentGate(input);

  if (!options || typeof options.missionsDir !== 'string' || options.missionsDir.length === 0) {
    throw configError('$.missionsDir', 'is required');
  }
  if (options.now !== undefined && !isIsoDateTime(options.now)) {
    throw configError('$.now', 'must be an ISO-8601 date-time');
  }
  const timestamp = options.now ?? new Date().toISOString();
  const executorConfig = prepareExecutorConfig(input);
  const artifacts = {
    issue_snapshot: await readOptionalArtifact(input.issue_snapshot_file, '$.issue_snapshot_file'),
    patch: await readOptionalArtifact(input.patch_file, '$.patch_file'),
    ci_links: await readOptionalArtifact(input.ci_links_file, '$.ci_links_file'),
  };

  const missionsDir = path.resolve(options.missionsDir);
  const missionDir = path.join(missionsDir, input.mission.mission_id);
  const force = options.force === true;
  const missionExisted = await pathExists(missionDir);
  if (missionExisted && !force) {
    throw new PipelineError('mission directory already exists', [
      pipelineIssue('MISSION_EXISTS', missionDir, 'use --force to replace it'),
    ]);
  }

  const executeImpl = options.executeImpl ?? execute;
  const ledgerImpl = options.ledgerImpl ?? buildLedger;
  const onWarning = options.onWarning ?? (() => {});
  let stagingDir = null;
  let executionDir = null;
  let ledgerTemp = null;
  let backupRoot = null;
  let backupPath = null;
  let published = false;
  let restored = false;
  let succeeded = false;

  try {
    await mkdir(missionsDir, { recursive: true });
    stagingDir = await mkdtemp(path.join(missionsDir, `.pipeline-${input.mission.mission_id}-`));
    executionDir = await mkdtemp(path.join(os.tmpdir(), 'northset-pipeline-executor-'));

    const writes = [
      writeFile(path.join(stagingDir, 'mission.json'), `${JSON.stringify(input.mission, null, 2)}\n`),
    ];
    if (consent !== null) writes.push(writeFile(path.join(stagingDir, 'consent.md'), consent));
    if (artifacts.issue_snapshot !== null) {
      writes.push(writeFile(path.join(stagingDir, 'issue_snapshot.json'), artifacts.issue_snapshot));
    }
    if (artifacts.patch !== null) {
      writes.push(writeFile(path.join(stagingDir, 'patch.diff'), artifacts.patch));
    }
    if (artifacts.ci_links !== null) {
      writes.push(writeFile(path.join(stagingDir, 'ci_links.json'), artifacts.ci_links));
    }
    await Promise.all(writes);

    await executeImpl(executorConfig, { outDir: executionDir, now: timestamp });
    const bundle = await createBundle(stagingDir, {
      createdAt: timestamp,
      stdoutFile: path.join(executionDir, 'stdout.txt'),
      stderrFile: path.join(executionDir, 'stderr.txt'),
      runRecordFile: path.join(executionDir, 'run_record.json'),
    });

    if (missionExisted) {
      backupRoot = await mkdtemp(path.join(missionsDir, '.pipeline-backup-'));
      const pendingBackupPath = path.join(backupRoot, input.mission.mission_id);
      await rename(missionDir, pendingBackupPath);
      backupPath = pendingBackupPath;
    }
    await rename(stagingDir, missionDir);
    stagingDir = null;
    published = true;

    const ledgerOutputRoot = await mkdtemp(path.join(missionsDir, '.pipeline-ledger-'));
    ledgerTemp = path.join(ledgerOutputRoot, 'index.json');
    const ledger = await ledgerImpl({
      missionsDir,
      out: ledgerTemp,
      now: timestamp,
      onWarning,
    });
    await rename(ledgerTemp, path.join(missionsDir, 'index.json'));
    ledgerTemp = null;
    await rm(ledgerOutputRoot, { recursive: true, force: true });

    succeeded = true;
    return {
      missionDir,
      bundleDigest: bundle.bundleDigest,
      ledgerIncluded: ledger.included,
      attestationPending: true,
    };
  } catch (error) {
    try {
      await restorePreviousMission({ missionDir, published, backupPath });
      restored = true;
    } catch (rollbackError) {
      throw new PipelineError(`pipeline failed and rollback failed: ${rollbackError.message}`, [
        pipelineIssue('PIPELINE_ROLLBACK', missionDir, error.message),
      ]);
    }
    throw error;
  } finally {
    if (stagingDir !== null) await rm(stagingDir, { recursive: true, force: true });
    if (executionDir !== null) await rm(executionDir, { recursive: true, force: true });
    if (ledgerTemp !== null) await rm(path.dirname(ledgerTemp), { recursive: true, force: true });
    if (backupRoot !== null && (succeeded || restored)) {
      await rm(backupRoot, { recursive: true, force: true });
    }
  }
}
