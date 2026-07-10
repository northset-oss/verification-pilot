import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CONFIG_FIELDS = new Set([
  'image',
  'repo_dir',
  'patch_file',
  'install_commands',
  'commands',
  'limits',
]);
const FIXED_ENVIRONMENT = [
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'HOME=/tmp',
  'CI=true',
];
const NETWORK_POLICY = 'phaseA:bridge,phaseB:none';
const TERMINATION_GRACE_MS = 10_000;
const TMPFS_SIZE_MB = 512;
const UTILITY_OUTPUT_LIMIT = 64 * 1024;
const WORKSPACE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const REPO_DIGEST_FORMAT = '{{json .RepoDigests}}';
const IMAGE_ID_FORMAT = '{{.Id}}';
const REPO_DIGEST_PATTERN = /^.+@sha256:[0-9a-f]{64}$/i;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validationError(pathName, message) {
  return { ruleId: 'EXECUTOR_CONFIG', path: pathName, message };
}

function validatePositiveNumber(errors, value, pathName, { integer = false } = {}) {
  const valid = typeof value === 'number' && Number.isFinite(value) && value > 0;
  if (!valid || (integer && !Number.isInteger(value))) {
    errors.push(validationError(pathName, `must be a positive ${integer ? 'integer' : 'number'}`));
  }
}

function validateCommandArray(errors, value, pathName, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)) {
    errors.push(validationError(pathName, 'must be an array'));
    return;
  }
  if (!allowEmpty && value.length === 0) {
    errors.push(validationError(pathName, 'must contain at least one command'));
  }
  value.forEach((command, index) => {
    if (typeof command !== 'string' || command.length === 0) {
      errors.push(validationError(`${pathName}[${index}]`, 'must be a non-empty string'));
    }
  });
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

export class ExecutorError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'ExecutorError';
    this.errors = errors;
  }
}

/**
 * Validate and copy executor configuration.
 *
 * @param {unknown} value
 * @returns {object}
 */
export function validateExecutorConfig(value) {
  const errors = [];
  if (!isObject(value)) {
    throw new ExecutorError('invalid executor config', [validationError('$', 'must be an object')]);
  }

  for (const key of Object.keys(value).sort()) {
    if (!CONFIG_FIELDS.has(key)) errors.push(validationError(`$.${key}`, 'is not an allowed property'));
  }
  for (const field of CONFIG_FIELDS) {
    if (!Object.hasOwn(value, field)) errors.push(validationError(`$.${field}`, 'is required'));
  }

  if (typeof value.image !== 'string' || value.image.length === 0 || value.image.startsWith('-')) {
    errors.push(validationError('$.image', 'must be a non-empty Docker image string'));
  }
  if (typeof value.repo_dir !== 'string' || !path.isAbsolute(value.repo_dir)) {
    errors.push(validationError('$.repo_dir', 'must be an absolute path'));
  }
  if (value.patch_file !== null && (typeof value.patch_file !== 'string' || !path.isAbsolute(value.patch_file))) {
    errors.push(validationError('$.patch_file', 'must be an absolute path or null'));
  }
  validateCommandArray(errors, value.install_commands, '$.install_commands');
  validateCommandArray(errors, value.commands, '$.commands', { allowEmpty: false });

  if (!isObject(value.limits)) {
    errors.push(validationError('$.limits', 'must be an object'));
  } else {
    for (const field of [
      'cpus',
      'memory_mb',
      'pids',
      'wall_clock_seconds_per_command',
      'output_bytes_per_stream',
    ]) {
      if (!Object.hasOwn(value.limits, field)) errors.push(validationError(`$.limits.${field}`, 'is required'));
    }
    validatePositiveNumber(errors, value.limits.cpus, '$.limits.cpus');
    validatePositiveNumber(errors, value.limits.memory_mb, '$.limits.memory_mb', { integer: true });
    validatePositiveNumber(errors, value.limits.pids, '$.limits.pids', { integer: true });
    validatePositiveNumber(
      errors,
      value.limits.wall_clock_seconds_per_command,
      '$.limits.wall_clock_seconds_per_command',
    );
    validatePositiveNumber(
      errors,
      value.limits.output_bytes_per_stream,
      '$.limits.output_bytes_per_stream',
      { integer: true },
    );
  }

  if (errors.length > 0) throw new ExecutorError('invalid executor config', errors);
  return {
    image: value.image,
    repo_dir: value.repo_dir,
    patch_file: value.patch_file,
    install_commands: [...value.install_commands],
    commands: [...value.commands],
    limits: { ...value.limits },
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function phaseAScript(config, paths) {
  const lines = ['set -e'];
  if (paths.patchContainerFile) {
    const patchFile = shellQuote(paths.patchContainerFile);
    lines.push(
      `git apply -- ${patchFile}`,
      `rm -f -- ${patchFile}`,
    );
  }
  lines.push(...config.install_commands);
  return lines.join('\n');
}

function commonRunArgs(config, paths) {
  const workspaceDir = paths.workspaceDir ?? paths.workspace;
  const containerName = paths.containerName ?? paths.container;
  if (!workspaceDir || !containerName) {
    throw new ExecutorError('docker run paths require workspaceDir and containerName');
  }
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--user',
    '1000:1000',
    '--cap-drop=ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(config.limits.pids),
    '--memory',
    `${config.limits.memory_mb}m`,
    '--cpus',
    String(config.limits.cpus),
    '--read-only',
    '--tmpfs',
    `/tmp:size=${TMPFS_SIZE_MB}m`,
    '--mount',
    `type=bind,source=${workspaceDir},target=/workspace`,
    '--workdir',
    '/workspace',
    ...FIXED_ENVIRONMENT.flatMap((entry) => ['--env', entry]),
  ];
}

/**
 * Build every Docker CLI argv used by the executor without spawning a process.
 *
 * @param {'A'|'B'|'phaseA'|'phaseB'|'inspect'|'rm'} phase
 * @param {object} config
 * @param {object} paths
 * @returns {string[]}
 */
export function buildDockerArgs(phase, config, paths) {
  if (phase === 'A' || phase === 'phaseA') {
    return [
      ...commonRunArgs(config, paths),
      config.image,
      '/bin/sh',
      '-lc',
      phaseAScript(config, paths),
    ];
  }
  if (phase === 'B' || phase === 'phaseB') {
    if (typeof paths.command !== 'string') {
      throw new ExecutorError('phase B paths require command');
    }
    return [
      ...commonRunArgs(config, paths),
      '--network=none',
      config.image,
      '/bin/sh',
      '-lc',
      paths.command,
    ];
  }
  if (phase === 'inspect') {
    const format = {
      repoDigests: REPO_DIGEST_FORMAT,
      id: IMAGE_ID_FORMAT,
    }[paths.format];
    if (format === undefined) {
      throw new ExecutorError('image inspect paths require format');
    }
    return ['image', 'inspect', config.image, '--format', format];
  }
  if (phase === 'rm') {
    return ['rm', '-f', paths.containerName];
  }
  throw new ExecutorError(`unknown Docker argv phase ${phase}`);
}

class LimitedCapture {
  constructor(limit) {
    this.limit = limit;
    this.length = 0;
    this.chunks = [];
    this.truncated = false;
  }

  append(chunk) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = this.limit - this.length;
    if (remaining > 0) {
      const kept = value.subarray(0, remaining);
      this.chunks.push(kept);
      this.length += kept.length;
    }
    if (value.length > remaining) this.truncated = true;
  }

  text() {
    const captured = Buffer.concat(this.chunks).toString('utf8');
    if (!this.truncated) return captured;
    return `${captured}${captured.length > 0 && !captured.endsWith('\n') ? '\n' : ''}[TRUNCATED]\n`;
  }
}

function spawnChild(spawnImpl, args) {
  try {
    return spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new ExecutorError(`cannot spawn docker: ${error.message}`);
  }
}

function runDocker(
  spawnImpl,
  args,
  { outputLimit = UTILITY_OUTPUT_LIMIT, timeoutMs = null, containerName = null } = {},
) {
  const child = spawnChild(spawnImpl, args);
  const stdout = new LimitedCapture(outputLimit);
  const stderr = new LimitedCapture(outputLimit);
  const started = performance.now();
  let timedOut = false;
  let timeout;
  let forceKill;

  child.stdout?.on('data', (chunk) => stdout.append(chunk));
  child.stderr?.on('data', (chunk) => stderr.append(chunk));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      callback();
    };

    child.once('error', (error) => {
      finish(() => reject(new ExecutorError(`docker failed to start: ${error.message}`)));
    });
    child.once('close', (code, signal) => {
      finish(() => resolve({
        code,
        signal,
        timedOut,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout: stdout.text(),
        stderr: stderr.text(),
      }));
    });

    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (containerName !== null) {
          try {
            const killChild = spawnImpl('docker', ['kill', containerName]);
            killChild?.once?.('error', () => {});
          } catch {
            // Container timeout cleanup is best-effort; client signals remain the fallback.
          }
        }
        child.kill('SIGTERM');
        forceKill = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
        forceKill.unref?.();
      }, timeoutMs);
    }
  });
}

async function makeTreeWritable(directory) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink()) return;
  const permissions = stats.mode & 0o777;
  await chmod(directory, permissions | (stats.isDirectory() ? 0o007 : 0o006));
  if (!stats.isDirectory()) return;
  const entries = await readdir(directory);
  await Promise.all(entries.map((entry) => makeTreeWritable(path.join(directory, entry))));
}

async function treeFileSize(directory, stopAfter = Number.POSITIVE_INFINITY) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.isFile() ? stats.size : 0;
  const entries = await readdir(directory);
  let total = 0;
  for (const entry of entries) {
    total += await treeFileSize(path.join(directory, entry), stopAfter - total);
    if (total > stopAfter) break;
  }
  return total;
}

async function enforceWorkspaceSize(workspaceDir) {
  if (await treeFileSize(workspaceDir, WORKSPACE_MAX_BYTES) > WORKSPACE_MAX_BYTES) {
    throw new ExecutorError('workspace exceeded size cap');
  }
}

async function inspectImage(spawnImpl, config, format) {
  try {
    return await runDocker(
      spawnImpl,
      buildDockerArgs('inspect', config, { format }),
    );
  } catch {
    throw new ExecutorError('cannot resolve image digest');
  }
}

async function resolveImageDigest(spawnImpl, config) {
  const repoDigestsResult = await inspectImage(spawnImpl, config, 'repoDigests');
  if (repoDigestsResult.code !== 0) {
    throw new ExecutorError('cannot resolve image digest');
  }

  let repoDigests;
  try {
    repoDigests = JSON.parse(repoDigestsResult.stdout.trim());
  } catch {
    throw new ExecutorError('cannot resolve image digest');
  }
  if (repoDigests !== null && !Array.isArray(repoDigests)) {
    throw new ExecutorError('cannot resolve image digest');
  }

  const resolvedRepoDigest = repoDigests?.find((value) => (
    typeof value === 'string' && REPO_DIGEST_PATTERN.test(value)
  ));
  if (resolvedRepoDigest !== undefined) return resolvedRepoDigest;
  if (repoDigests !== null && repoDigests.length > 0) {
    throw new ExecutorError('cannot resolve image digest');
  }

  const imageIdResult = await inspectImage(spawnImpl, config, 'id');
  const imageId = imageIdResult.stdout.trim();
  if (imageIdResult.code !== 0 || !IMAGE_ID_PATTERN.test(imageId)) {
    throw new ExecutorError('cannot resolve image digest');
  }
  return imageId;
}

function outputSection(index, command, output) {
  const suffix = output.length > 0 && !output.endsWith('\n') ? '\n' : '';
  return `=== cmd ${index + 1}: ${command} ===\n${output}${suffix}`;
}

async function cleanupDocker(spawnImpl, config, containerNames) {
  for (const containerName of containerNames) {
    try {
      await runDocker(spawnImpl, buildDockerArgs('rm', config, { containerName }));
    } catch {
      // Cleanup is best-effort so all remaining cleanup operations still run.
    }
  }
}

/**
 * Execute a validated mission command config in two Docker phases.
 *
 * @param {unknown} configValue
 * @param {{outDir: string, now?: string, spawnImpl?: typeof spawn}} options
 */
export async function execute(configValue, options) {
  const config = validateExecutorConfig(configValue);
  if (!options || typeof options.outDir !== 'string' || options.outDir.length === 0) {
    throw new ExecutorError('outDir is required');
  }
  if (options.now !== undefined && !isIsoDateTime(options.now)) {
    throw new ExecutorError('invalid --now', [validationError('--now', 'must be an ISO-8601 date-time')]);
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const startedAt = options.now ?? new Date().toISOString();
  const id = randomUUID().toLowerCase();
  const phaseAContainer = `northset-executor-a-${id}`;
  const phaseBContainers = config.commands.map((_, index) => `northset-executor-b-${index}-${id}`);
  const containerNames = [phaseAContainer, ...phaseBContainers];
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-executor-'));
  const workspaceDir = path.join(temporaryRoot, 'workspace');

  try {
    await cp(config.repo_dir, workspaceDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });

    let patchContainerFile = null;
    if (config.patch_file !== null) {
      const patchName = `.northset-executor-${id}.patch`;
      await copyFile(config.patch_file, path.join(workspaceDir, patchName));
      patchContainerFile = `/workspace/${patchName}`;
    }
    await makeTreeWritable(workspaceDir);

    const phaseAPaths = {
      workspaceDir,
      containerName: phaseAContainer,
      patchContainerFile,
    };
    const phaseAResult = await runDocker(
      spawnImpl,
      buildDockerArgs('phaseA', config, phaseAPaths),
      {
        timeoutMs: config.limits.wall_clock_seconds_per_command * 1000,
        containerName: phaseAContainer,
      },
    );
    if (phaseAResult.code !== 0) {
      throw new ExecutorError(`phase A failed with exit code ${phaseAResult.code}`);
    }
    await enforceWorkspaceSize(workspaceDir);
    const containerImageDigest = await resolveImageDigest(spawnImpl, config);

    const commandRecords = [];
    const stdoutSections = [];
    const stderrSections = [];
    for (let index = 0; index < config.commands.length; index += 1) {
      const command = config.commands[index];
      const result = await runDocker(
        spawnImpl,
        buildDockerArgs('phaseB', config, {
          workspaceDir,
          containerName: phaseBContainers[index],
          command,
        }),
        {
          outputLimit: config.limits.output_bytes_per_stream,
          timeoutMs: config.limits.wall_clock_seconds_per_command * 1000,
          containerName: phaseBContainers[index],
        },
      );
      if (!result.timedOut && !Number.isInteger(result.code)) {
        throw new ExecutorError(`command exited without an exit code (signal ${result.signal ?? 'unknown'})`);
      }

      const record = {
        cmd: command,
        exit_code: result.timedOut ? null : result.code,
        duration_ms: result.durationMs,
      };
      if (result.timedOut) record.timed_out = true;
      commandRecords.push(record);
      stdoutSections.push(outputSection(index, command, result.stdout));
      stderrSections.push(outputSection(index, command, result.stderr));
      await enforceWorkspaceSize(workspaceDir);
    }

    const runRecord = {
      started_at: startedAt,
      finished_at: options.now ?? new Date().toISOString(),
      environment: {
        container_image_ref: config.image,
        container_image_digest: containerImageDigest,
        network_policy: NETWORK_POLICY,
      },
      commands: commandRecords,
      notes: null,
    };
    const outDir = path.resolve(options.outDir);
    await mkdir(outDir, { recursive: true });
    const runRecordFile = path.join(outDir, 'run_record.json');
    const stdoutFile = path.join(outDir, 'stdout.txt');
    const stderrFile = path.join(outDir, 'stderr.txt');
    await Promise.all([
      writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`),
      writeFile(stdoutFile, stdoutSections.join('')),
      writeFile(stderrFile, stderrSections.join('')),
    ]);
    return { runRecord, runRecordFile, stdoutFile, stderrFile };
  } finally {
    await cleanupDocker(spawnImpl, config, containerNames);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
