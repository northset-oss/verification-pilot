import {
  cp,
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

import { createBundle, validatePublicConsent } from './bundle.mjs';
import { finalizeEconomicIdentity, validateEconomicIdentity } from './economic-identity.mjs';
import { execute, validateExecutorConfig } from './executor.mjs';
import { buildLedger, renderLedger } from './ledger.mjs';
import { validateMission } from './mission-validator.mjs';

const INPUT_FIELDS = new Set([
  'mission',
  'repo_dir',
  'patch_file',
  'consent_file',
  'issue_snapshot_file',
  'ci_links_file',
  'executor',
  'economic',
]);
const REQUIRED_INPUT_FIELDS = new Set([...INPUT_FIELDS].filter((field) => field !== 'economic'));
const EXECUTOR_INPUT_FIELDS = new Set([
  'profile',
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
  for (const field of REQUIRED_INPUT_FIELDS) {
    if (!Object.hasOwn(input, field)) throw configError(`$.${field}`, 'is required');
  }
  if (Object.hasOwn(input, 'economic') && !isObject(input.economic)) {
    throw configError('$.economic', 'must be an object when present');
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
      const source = await readFile(input.consent_file, 'utf8');
      let receipt;
      try {
        receipt = JSON.parse(source);
      } catch (error) {
        throw new Error(`invalid JSON: ${error.message}`);
      }
      const validation = validatePublicConsent(receipt, mission);
      if (!validation.valid) throw new Error(validation.errors.map(({ path: itemPath, message }) => `${itemPath} ${message}`).join('; '));
      return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
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

  // The per-variant disclosure label (rehearsal / contributor) is already enforced by
  // validateMission above; the consent gate's remaining job is the consent FILE for
  // consented variants. own_repo_rehearsal and author_contribution carry no maintainer
  // consent by design.
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

function commandsEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((command, index) => command === right[index])
  );
}

function assertDeclaredCommandsMatch(executorConfig, mission) {
  if (commandsEqual(mission.commands_declared, executorConfig.commands)) return;
  throw new PipelineError('mission commands_declared must equal executor.commands', [
    pipelineIssue(
      'COMMANDS_MISMATCH',
      '$.mission.commands_declared',
      'mission commands_declared must equal executor.commands',
    ),
  ]);
}

function assertExecutedCommandsMatch(execution, mission) {
  const commandRecords = execution?.runRecord?.commands;
  const executedCommands = Array.isArray(commandRecords)
    ? commandRecords.map((command) => command.cmd)
    : null;
  if (commandsEqual(mission.commands_declared, executedCommands)) return;
  throw new PipelineError('executor run record commands must equal mission commands_declared', [
    pipelineIssue(
      'COMMANDS_EXECUTED_MISMATCH',
      '$.mission.commands_declared',
      'executor run record commands must equal mission commands_declared',
    ),
  ]);
}

// Bind the receipt to the code that ACTUALLY ran. The executor derives the base commit and the
// patch digest from the real workspace; if the receipt declares either, it must match, and a
// declared base_commit that the executor could not derive (e.g. a non-git tree) is unprovable
// and therefore rejected. This is what stops a receipt from naming code it did not execute — the
// difference between evidence and a self-consistent story.
function assertCodeBinding(execution, mission) {
  const environment = execution?.runRecord?.environment ?? {};

  if (mission.base_commit !== null && mission.base_commit !== undefined) {
    const declared = mission.base_commit.toLowerCase();
    const derived = typeof environment.source_commit === 'string'
      ? environment.source_commit.toLowerCase()
      : null;
    if (derived === null) {
      throw new PipelineError('declared base_commit is unprovable', [
        pipelineIssue(
          'CODE_BINDING',
          '$.mission.base_commit',
          'receipt declares a base_commit but the executor could not derive a commit from the workspace',
        ),
      ]);
    }
    if (declared !== derived) {
      throw new PipelineError('declared base_commit does not match executed code', [
        pipelineIssue(
          'CODE_BINDING',
          '$.mission.base_commit',
          `declared ${declared} but the executed checkout was ${derived}`,
        ),
      ]);
    }
  }

  // Patch binding is BIDIRECTIONAL: a declared hash must match the applied patch, AND an applied
  // patch must be declared. Either gap lets the receipt name code it did not run (a hidden
  // patch, or a claimed patch that never ran).
  const declaredPatch = typeof mission.patch_diff_hash === 'string'
    ? mission.patch_diff_hash.toLowerCase()
    : null;
  const appliedPatch = typeof environment.patch_sha256 === 'string'
    ? environment.patch_sha256.toLowerCase()
    : null;
  if (declaredPatch !== appliedPatch) {
    throw new PipelineError('declared patch does not match the applied patch', [
      pipelineIssue(
        'CODE_BINDING',
        '$.mission.patch_diff_hash',
        `receipt declares ${declaredPatch ?? 'no patch'} but the executor applied ${appliedPatch ?? 'no patch'}`,
      ),
    ]);
  }
}

// The executor deliberately records failures and continues for diagnostic purposes, but this
// pipeline publishes public proof-of-pass receipts. A failed or timed-out command must never
// reach its bundle, ledger, or attestation path. --require-success remains a compatibility flag.
function assertCommandsSucceeded(execution) {
  const failed = (execution?.runRecord?.commands ?? []).filter(
    (command) => command.exit_code !== 0 || command.timed_out === true,
  );
  if (failed.length === 0) return;
  throw new PipelineError('declared commands must all succeed for a proof-of-pass receipt', [
    pipelineIssue(
      'COMMAND_FAILED',
      '$.mission.commands_declared',
      failed
        .map((command) => `"${command.cmd}" ${command.timed_out ? 'timed out' : `exited ${command.exit_code}`}`)
        .join('; '),
    ),
  ]);
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
 * @param {{missionsDir: string, siteFile?: string, now?: string, force?: boolean, requireSuccess?: boolean, executeImpl?: typeof execute, ledgerImpl?: typeof buildLedger, renderImpl?: typeof renderLedger, afterIndexPublish?: () => Promise<void>|void, onWarning?: (message: string) => void}} options
 * @returns {Promise<{missionDir: string, bundleDigest: string, ledgerIncluded: number, attestationPending: true, siteFile?: string}>}
 */
export async function runPipeline(input, options) {
  validateTopLevelInput(input);

  // Policy guard: this validation and consent-file read must complete before executeImpl.
  const consent = await enforceConsentGate(input);

  if (input.mission.attestation_uri != null) {
    throw new PipelineError('a fresh execution cannot inherit an attestation', [
      pipelineIssue(
        'STALE_ATTESTATION',
        '$.mission.attestation_uri',
        'must be null until the new bundle is signed and publication metadata is recorded',
      ),
    ]);
  }

  if (!options || typeof options.missionsDir !== 'string' || options.missionsDir.length === 0) {
    throw configError('$.missionsDir', 'is required');
  }
  if (options.now !== undefined && !isIsoDateTime(options.now)) {
    throw configError('$.now', 'must be an ISO-8601 date-time');
  }
  if (
    options.siteFile !== undefined &&
    (typeof options.siteFile !== 'string' || options.siteFile.length === 0)
  ) {
    throw configError('$.siteFile', 'must be a non-empty path');
  }
  const siteFile = options.siteFile === undefined ? null : path.resolve(options.siteFile);
  const timestamp = options.now ?? new Date().toISOString();
  // A fresh execution cannot inherit an earlier bundle digest or attestation. Keep the immutable
  // in-bundle mission envelope pending; publication metadata is added only after signing.
  const missionRecord = {
    ...input.mission,
    run_record_bundle_digest: null,
    attestation_uri: null,
  };
  // Economic input is untrusted public evidence. Validate its static facts before starting the
  // networked executor; the run-derived verification fields are finalized and checked again after
  // execution. This prevents malformed economic metadata from consuming an authoring run.
  if (input.economic !== undefined) validateEconomicIdentity(input.economic, {mission: missionRecord});
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
  const renderImpl = options.renderImpl ?? renderLedger;
  const onWarning = options.onWarning ?? (() => {});
  let stagingDir = null;
  let executionDir = null;
  let ledgerTemp = null;
  let siteStaging = null;
  let siteStagingRoot = null;
  let siteRoot = null;
  let siteBackupRoot = null;
  let siteBackupPath = null;
  let indexBackupRoot = null;
  let indexBackupPath = null;
  let indexPublished = false;
  let sitePublished = false;
  let backupRoot = null;
  let backupPath = null;
  let published = false;
  let restored = false;
  let succeeded = false;

  try {
    assertDeclaredCommandsMatch(executorConfig, input.mission);
    await mkdir(missionsDir, { recursive: true });
    stagingDir = await mkdtemp(path.join(missionsDir, `.pipeline-${input.mission.mission_id}-`));
    executionDir = await mkdtemp(path.join(os.tmpdir(), 'northset-pipeline-executor-'));

    const writes = [
      writeFile(path.join(stagingDir, 'mission.json'), `${JSON.stringify(missionRecord, null, 2)}\n`),
    ];
    if (consent !== null) writes.push(writeFile(path.join(stagingDir, 'consent.json'), consent));
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

    // Forward `now` only when the caller pinned it: a real run's started_at/finished_at must
    // be the executor's actual wall-clock times, not one pipeline-wide timestamp.
    const execution = await executeImpl(executorConfig, {
      outDir: executionDir,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    assertExecutedCommandsMatch(execution, input.mission);
    assertCodeBinding(execution, input.mission);
    assertCommandsSucceeded(execution);
    if (input.economic !== undefined) {
      const economic = finalizeEconomicIdentity(input.economic, execution.runRecord);
      validateEconomicIdentity(economic, { mission: missionRecord, runRecord: execution.runRecord });
      await writeFile(path.join(stagingDir, 'economic.json'), `${JSON.stringify(economic, null, 2)}\n`);
    }
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
      // A fresh run is intentionally excluded until its exact release asset has been signed and
      // a complete publication envelope has been recorded. Every other source remains strict;
      // the pipeline cannot hide an unrelated invalid receipt behind diagnostic skip mode.
      excludeMissionIds: [input.mission.mission_id],
    });
    // Stage the whole generated site tree before publishing either index.json or site/. Receipt
    // pages are sibling output, so staging only index.html would leave a failed render capable of
    // mutating the live receipts directory.
    if (siteFile !== null) {
      siteRoot = path.dirname(siteFile);
      await mkdir(path.dirname(siteRoot), { recursive: true });
      siteStagingRoot = await mkdtemp(path.join(
        path.dirname(siteRoot),
        `.pipeline-site-${input.mission.mission_id}-`,
      ));
      if (await pathExists(siteRoot)) {
        await cp(siteRoot, siteStagingRoot, { recursive: true, force: true });
      }
      siteStaging = path.join(siteStagingRoot, path.basename(siteFile));
      await renderImpl({ indexPath: ledgerTemp, out: siteStaging, now: timestamp });
    }

    const indexTarget = path.join(missionsDir, 'index.json');
    if (siteFile === null) {
      await rename(ledgerTemp, indexTarget);
      ledgerTemp = null;
    } else {
      // Swap both generated roots with recoverable backups. A rename is atomic for each tree;
      // the rollback below restores the previous pair should the second publish fail.
      if (await pathExists(indexTarget)) {
        indexBackupRoot = await mkdtemp(path.join(missionsDir, '.pipeline-index-backup-'));
        indexBackupPath = path.join(indexBackupRoot, 'index.json');
        await rename(indexTarget, indexBackupPath);
      }
      if (await pathExists(siteRoot)) {
        siteBackupRoot = await mkdtemp(path.join(path.dirname(siteRoot), '.pipeline-site-backup-'));
        siteBackupPath = path.join(siteBackupRoot, path.basename(siteRoot));
        await rename(siteRoot, siteBackupPath);
      }
      await rename(ledgerTemp, indexTarget);
      ledgerTemp = null;
      indexPublished = true;
      if (options.afterIndexPublish !== undefined) await options.afterIndexPublish();
      await rename(siteStagingRoot, siteRoot);
      siteStagingRoot = null;
      siteStaging = null;
      sitePublished = true;
    }
    await rm(ledgerOutputRoot, { recursive: true, force: true });

    succeeded = true;
    const result = {
      missionDir,
      bundleDigest: bundle.bundleDigest,
      ledgerIncluded: ledger.included,
      attestationPending: true,
    };
    if (siteFile !== null) result.siteFile = siteFile;
    return result;
  } catch (error) {
    const rollbackErrors = [];
    const attemptRollback = async (label, action) => {
      try {
        await action();
      } catch (rollbackError) {
        rollbackErrors.push(`${label}: ${rollbackError.message}`);
      }
    };
    await attemptRollback('mission', () => restorePreviousMission({ missionDir, published, backupPath }));
    await attemptRollback('site', async () => {
      if (sitePublished && siteRoot !== null) await rm(siteRoot, { recursive: true, force: true });
      if (siteBackupPath !== null && siteRoot !== null) await rename(siteBackupPath, siteRoot);
    });
    await attemptRollback('index', async () => {
      if (indexPublished) await rm(path.join(missionsDir, 'index.json'), { force: true });
      if (indexBackupPath !== null) await rename(indexBackupPath, path.join(missionsDir, 'index.json'));
    });
    if (rollbackErrors.length > 0) {
      throw new PipelineError(`pipeline failed and rollback failed: ${rollbackErrors.join('; ')}`, [
        pipelineIssue('PIPELINE_ROLLBACK', missionDir, error.message),
      ]);
    }
    restored = true;
    throw error;
  } finally {
    if (stagingDir !== null) await rm(stagingDir, { recursive: true, force: true });
    if (executionDir !== null) await rm(executionDir, { recursive: true, force: true });
    if (ledgerTemp !== null) await rm(path.dirname(ledgerTemp), { recursive: true, force: true });
    if (siteStaging !== null) await rm(siteStaging, { force: true });
    if (siteStagingRoot !== null) await rm(siteStagingRoot, { recursive: true, force: true });
    if (siteBackupRoot !== null && (succeeded || restored)) await rm(siteBackupRoot, { recursive: true, force: true });
    if (indexBackupRoot !== null && (succeeded || restored)) await rm(indexBackupRoot, { recursive: true, force: true });
    if (backupRoot !== null && (succeeded || restored)) {
      await rm(backupRoot, { recursive: true, force: true });
    }
  }
}
