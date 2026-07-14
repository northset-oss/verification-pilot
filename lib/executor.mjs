import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const CONFIG_FIELDS = new Set([
  'profile',
  'image',
  'repo_dir',
  'patch_file',
  'install_commands',
  'commands',
  'limits',
]);
const BASE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const FIXED_ENVIRONMENT = [
  'HOME=/tmp',
  'CI=true',
  'COREPACK_HOME=/workspace/.northset/corepack',
  'NPM_CONFIG_CACHE=/workspace/.northset/npm-cache',
  'XDG_CACHE_HOME=/workspace/.northset/cache',
  'XDG_DATA_HOME=/workspace/.northset/share',
];
const PROFILES = {
  node: {
    // npm/yarn/pnpm keep project dependencies under the bind-mounted workspace.
    // No synthetic global tool directory is needed for the initial Node lane.
    path: BASE_PATH,
    setup: [],
  },
  python: {
    path: `/workspace/.venv/bin:${BASE_PATH}`,
    setup: ['test -x /workspace/.venv/bin/python || python3 -m venv /workspace/.venv'],
  },
};
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
    if (field === 'profile') continue; // backward-compatible default: node
    if (!Object.hasOwn(value, field)) errors.push(validationError(`$.${field}`, 'is required'));
  }

  if (typeof value.image !== 'string' || value.image.length === 0 || value.image.startsWith('-')) {
    errors.push(validationError('$.image', 'must be a non-empty Docker image string'));
  }
  const profile = value.profile ?? 'node';
  if (typeof profile !== 'string' || !Object.hasOwn(PROFILES, profile)) {
    errors.push(validationError('$.profile', `must be one of ${Object.keys(PROFILES).join(', ')}`));
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

  if (errors.length > 0) throw new ExecutorError(`invalid executor config: ${errors[0].path} ${errors[0].message}`, errors);
  return {
    profile,
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
  lines.push(...PROFILES[config.profile].setup);
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
    '--env', `PATH=${PROFILES[config.profile].path}`,
    ...FIXED_ENVIRONMENT.flatMap((entry) => ['--env', entry]),
  ];
}

/**
 * Build every Docker CLI argv used by the executor without spawning a process.
 *
 * @param {'A'|'B'|'phaseA'|'phaseB'|'inspect'|'pull'|'rm'} phase
 * @param {object} config
 * @param {object} paths
 * @returns {string[]}
 */
export function buildDockerArgs(phase, config, paths) {
  if (phase === 'A' || phase === 'phaseA') {
    return [
      ...commonRunArgs(config, paths),
      paths.image ?? config.image,
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
      paths.image ?? config.image,
      '/bin/sh',
      '-lc',
      paths.command,
    ];
  }
  if (phase === 'inspect') {
    const format = {
      repoDigests: REPO_DIGEST_FORMAT,
      id: IMAGE_ID_FORMAT,
      os: '{{.Os}}',
      architecture: '{{.Architecture}}',
    }[paths.format];
    if (format === undefined) {
      throw new ExecutorError('image inspect paths require format');
    }
    return ['image', 'inspect', config.image, '--format', format];
  }
  if (phase === 'pull') return ['pull', config.image];
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
  await chmod(directory, permissions | (stats.isDirectory() ? 0o707 : 0o606));
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

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

// Global hardening for every git call: never let a copied repo's own config, hooks, or
// fsmonitor run code on the HOST. We inspect untrusted repository metadata, so git must not
// read external/global/system config, must not run hooks, and must not consult a filesystem
// monitor — all of which are repository-controllable code-execution vectors outside the sandbox.
const GIT_HARDENING_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.hooksPath=/dev/null',
  '--no-optional-locks',
];
const GIT_HARDENING_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_NO_REPLACE_OBJECTS: '1',
};
const INHERITED_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
];

function hardenedGitEnvironment() {
  const environment = {...process.env};
  for (const key of Object.keys(environment)) {
    if (INHERITED_GIT_ENV.includes(key) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete environment[key];
  }
  return {...environment, ...GIT_HARDENING_ENV};
}

function runGit(gitImpl, args) {
  let child;
  try {
    child = gitImpl('git', [...GIT_HARDENING_ARGS, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: hardenedGitEnvironment(),
    });
  } catch {
    return Promise.resolve({ code: null, stdout: '', stderr: '' });
  }
  const chunks = [];
  const stderrChunks = [];
  child.stdout?.on('data', (chunk) => chunks.push(chunk));
  child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
  return new Promise((resolve) => {
    child.once('error', () => resolve({ code: null, stdout: '', stderr: '' }));
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(chunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }));
  });
}

function runWorkspaceGit(gitImpl, workspaceDir, args) {
  return runGit(gitImpl, ['-C', workspaceDir, ...args]);
}

// Derive the git commit of the copied checkout ONLY when it honestly describes the bytes:
// a non-git tree, a missing git binary, OR a dirty/untracked tree all yield null. HEAD alone
// is a lie about a dirty worktree, so a receipt that DECLARES a base_commit must present a
// clean checkout of exactly that commit — otherwise the pipeline rejects it as unprovable.
async function deriveSourceCommit(gitImpl, workspaceDir) {
  const topLevel = await runWorkspaceGit(gitImpl, workspaceDir, ['rev-parse', '--show-toplevel']);
  if (topLevel.code !== 0) return null;
  const actualTopLevel = await realpath(topLevel.stdout.trim()).catch(() => null);
  const expectedTopLevel = await realpath(workspaceDir).catch(() => null);
  if (actualTopLevel === null || actualTopLevel !== expectedTopLevel) return null;
  const head = await runWorkspaceGit(gitImpl, workspaceDir, ['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;
  const commit = head.stdout.trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) return null;

  // Sparse/hidden index flags cause ordinary status and diff commands to trust cached stat
  // information instead of the bytes Docker will read. A flagged checkout is still runnable,
  // but it cannot honestly claim that HEAD identifies those bytes.
  const indexed = await runWorkspaceGit(gitImpl, workspaceDir, ['ls-files', '-v', '-z']);
  if (indexed.code !== 0) return null;
  for (const record of indexed.stdout.split('\0').filter(Boolean)) {
    if (record.length < 3 || record[1] !== ' ') return null;
    const tag = record[0];
    if (tag === 'S' || tag !== tag.toUpperCase()) return null;
  }

  // --untracked-files=all so an untracked source file (which tests would see) also disqualifies
  // the clean-commit claim.
  const status = await runWorkspaceGit(gitImpl, workspaceDir, [
    'status', '--porcelain', '--untracked-files=all', '--ignored=matching',
  ]);
  if (status.code !== 0 || status.stdout.trim() !== '') return null;
  return commit;
}

async function trackedIndexEntries(gitImpl, workspaceDir) {
  const listed = await runWorkspaceGit(gitImpl, workspaceDir, ['ls-files', '--stage', '-z']);
  if (listed.code !== 0) return null;
  const entries = [];
  for (const record of listed.stdout.split('\0').filter(Boolean)) {
    const separator = record.indexOf('\t');
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(' ');
    const file = separator === -1 ? '' : record.slice(separator + 1);
    if (metadata.length !== 3 || !/^\d{6}$/.test(metadata[0]) || !/^[0-9a-f]+$/i.test(metadata[1]) || !/^\d+$/.test(metadata[2]) || !file) {
      throw new ExecutorError('Git returned malformed tracked-file metadata');
    }
    if (metadata[0] === '160000') throw new ExecutorError('Git submodules are not supported');
    if (metadata[2] !== '0') throw new ExecutorError('unmerged Git index entries are not supported');
    entries.push({mode: metadata[0], path: file});
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function trackedFileList(gitImpl, workspaceDir) {
  const entries = await trackedIndexEntries(gitImpl, workspaceDir);
  return entries?.map((entry) => entry.path) ?? null;
}

function parsePatchPaths(numstat) {
  const files = [];
  let offset = 0;
  const readNulTerminated = () => {
    const end = numstat.indexOf('\0', offset);
    if (end === -1) throw new ExecutorError('Git returned malformed approved-patch paths');
    const value = numstat.slice(offset, end);
    offset = end + 1;
    return value;
  };

  while (offset < numstat.length) {
    const header = readNulTerminated();
    const match = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(header);
    if (match === null) throw new ExecutorError('Git returned malformed approved-patch paths');
    if (match[1] !== '') files.push(match[1]);
    else files.push(readNulTerminated(), readNulTerminated());
  }
  if (files.length === 0 || files.some((file) => file.length === 0 || file.includes('\uFFFD'))) {
    throw new ExecutorError('Git returned malformed approved-patch paths');
  }
  return [...new Set(files)];
}

async function assertPatchPathIsContained(workspaceDir, file) {
  const normalized = path.posix.normalize(file);
  const components = file.split('/');
  if (
    path.posix.isAbsolute(file) ||
    normalized !== file ||
    components.some((component) => component === '' || component === '.' || component === '..') ||
    components.some((component) => component.toLowerCase() === '.git') ||
    components[0].toLowerCase() === '.northset'
  ) {
    throw new ExecutorError('approved patch contains an unsafe path');
  }

  let current = workspaceDir;
  for (const component of components) {
    current = path.join(current, component);
    const stats = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stats === null) return;
    if (stats.isSymbolicLink()) {
      throw new ExecutorError('approved patch path traverses a symlink');
    }
  }
}

function rejectPatchedSymlinks(entries, patchPaths) {
  if (entries === null) throw new ExecutorError('approved patch index could not be inspected');
  const modes = new Map(entries.map((entry) => [entry.path, entry.mode]));
  if (patchPaths.some((file) => modes.get(file) === '120000')) {
    throw new ExecutorError('approved patch cannot introduce or modify symlinks');
  }
}

async function trackedTreeDigest(workspaceDir, files) {
  if (files === null) return null;
  const entries = [];
  for (const file of files) {
    const absolute = path.join(workspaceDir, file);
    const stats = await lstat(absolute).catch(() => null);
    if (stats === null) entries.push({path: file, kind: 'missing'});
    else if (stats.isSymbolicLink()) {
      entries.push({path: file, kind: 'symlink', mode: (stats.mode & 0o7777).toString(8), hash: sha256Hex(Buffer.from(await readlink(absolute)))});
    } else if (stats.isFile()) {
      entries.push({path: file, kind: 'file', mode: (stats.mode & 0o7777).toString(8), hash: sha256Hex(await readFile(absolute))});
    } else entries.push({path: file, kind: 'other', mode: (stats.mode & 0o7777).toString(8)});
  }
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(entries)))}`;
}

async function assertSelfContainedGitMetadata(workspaceDir) {
  const gitDirectory = path.join(workspaceDir, '.git');
  const stats = await lstat(gitDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats === null) return;
  if (!stats.isDirectory()) {
    throw new ExecutorError('copied Git metadata must be a self-contained directory');
  }
}

async function rejectGitMetadataSymlinks(directory) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new ExecutorError('copied Git metadata must not contain symlinks');
    if (entry.isDirectory()) await rejectGitMetadataSymlinks(absolutePath);
  }
}

async function removeLocalGitControls(workspaceDir) {
  const gitDirectory = path.join(workspaceDir, '.git');
  const stats = await lstat(gitDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats === null) return;
  await rejectGitMetadataSymlinks(gitDirectory);
  for (const relativePath of [
    'config',
    'config.worktree',
    'credentials',
    'FETCH_HEAD',
    'hooks',
    'logs',
    'modules',
    'worktrees',
    'commondir',
    'objects/info/alternates',
    'objects/info/http-alternates',
    'refs/replace',
  ]) {
    await rm(path.join(gitDirectory, relativePath), {recursive: true, force: true});
  }
  await writeFile(path.join(gitDirectory, 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '\tfilemode = true',
    '\tbare = false',
    '\tlogallrefupdates = false',
    '',
  ].join('\n'));
  await rejectGitMetadataSymlinks(gitDirectory);
}

async function makeGitMetadataWritable(workspaceDir) {
  const gitDirectory = path.join(workspaceDir, '.git');
  const stats = await lstat(gitDirectory).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stats !== null) await makeTreeWritable(gitDirectory);
}

const CACHE_DIRECTORIES = ['corepack', 'npm-cache', 'cache', 'share'];

async function prepareWorkspaceCacheRoot(workspaceDir) {
  const cacheRoot = path.join(workspaceDir, '.northset');
  const existing = await lstat(cacheRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) throw new ExecutorError('reserved .northset path already exists in source');
  await mkdir(cacheRoot);
  for (const directory of CACHE_DIRECTORIES) await mkdir(path.join(cacheRoot, directory));
  await makeTreeWritable(cacheRoot);
}

async function assertWorkspaceCacheRoots(workspaceDir) {
  const workspaceRealPath = await realpath(workspaceDir);
  for (const directory of CACHE_DIRECTORIES) {
    const cachePath = path.join(workspaceDir, '.northset', directory);
    const stats = await lstat(cachePath).catch(() => null);
    const resolved = stats?.isDirectory() && !stats.isSymbolicLink()
      ? await realpath(cachePath).catch(() => null)
      : null;
    if (resolved === null || (resolved !== workspaceRealPath && !resolved.startsWith(`${workspaceRealPath}${path.sep}`))) {
      throw new ExecutorError('workspace cache path escaped the disposable workspace');
    }
  }
}

async function removeAllGitMetadata(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.name.toLowerCase() === '.git') {
      await rm(absolutePath, {recursive: true, force: true});
    } else if (entry.isDirectory()) {
      await removeAllGitMetadata(absolutePath);
    }
  }
}

// Deterministic content digest of the PRE-PATCH base tree, excluding the named top-level
// entries (`.git`, later the injected patch) and never following symlinks. It anchors the
// starting source; it is NOT "what ran" (the patch and the networked install step both change
// the tree afterward — those are execution, disclosed via the patch hash, install_commands,
// and network_policy). Symlink targets and mode bits are hashed so two behaviorally-different
// trees do not collide.
async function treeDigest(root, excludeNames) {
  const files = [];
  async function walk(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => !(prefix === '' && excludeNames.has(entry.name)))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      const stats = await lstat(absolutePath);
      const mode = (stats.mode & 0o7777).toString(8);
      if (stats.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        files.push({ kind: 'symlink', path: relativePath, mode, hash: sha256Hex(Buffer.from(target)) });
      } else if (stats.isDirectory()) {
        files.push({ kind: 'dir', path: relativePath, mode, hash: '' });
        await walk(absolutePath, relativePath);
      } else if (stats.isFile()) {
        files.push({ kind: 'file', path: relativePath, mode, hash: sha256Hex(await readFile(absolutePath)) });
      } else {
        files.push({ kind: 'other', path: relativePath, mode, hash: '' });
      }
    }
  }
  await walk(root, '');
  const hash = createHash('sha256');
  // JSON-encode each entry tuple so a filename containing NUL/newline cannot forge an entry
  // boundary and collide two different trees.
  for (const file of files) {
    hash.update(`${JSON.stringify([file.kind, file.mode, file.path, file.hash])}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function inspectImage(spawnImpl, config, format) {
  return runDocker(spawnImpl, buildDockerArgs('inspect', config, { format }));
}

async function resolveImageIdentity(spawnImpl, config) {
  let repoDigestsResult = await inspectImage(spawnImpl, config, 'repoDigests');
  if (repoDigestsResult.code !== 0) {
    const pull = await runDocker(spawnImpl, buildDockerArgs('pull', config, {}));
    if (pull.code !== 0) throw new ExecutorError('cannot resolve immutable image identity');
    repoDigestsResult = await inspectImage(spawnImpl, config, 'repoDigests');
    if (repoDigestsResult.code !== 0) throw new ExecutorError('cannot resolve immutable image identity');
  }

  let repoDigests;
  try {
    repoDigests = JSON.parse(repoDigestsResult.stdout.trim());
  } catch {
    throw new ExecutorError('cannot resolve immutable image identity');
  }
  if (repoDigests !== null && !Array.isArray(repoDigests)) {
    throw new ExecutorError('cannot resolve image digest');
  }

  const resolvedRepoDigest = repoDigests?.find((value) => (
    typeof value === 'string' && REPO_DIGEST_PATTERN.test(value)
  ));
  if (resolvedRepoDigest === undefined && repoDigests !== null && repoDigests.length > 0) {
    throw new ExecutorError('cannot resolve immutable image identity');
  }

  const [imageIdResult, osResult, architectureResult] = await Promise.all([
    inspectImage(spawnImpl, config, 'id'),
    inspectImage(spawnImpl, config, 'os'),
    inspectImage(spawnImpl, config, 'architecture'),
  ]);
  const imageId = imageIdResult.stdout.trim();
  if (imageIdResult.code !== 0 || !IMAGE_ID_PATTERN.test(imageId)) {
    throw new ExecutorError('cannot resolve immutable image identity');
  }
  const osName = osResult.stdout.trim();
  const architecture = architectureResult.stdout.trim();
  if (osResult.code !== 0 || architectureResult.code !== 0 || !osName || !architecture) {
    throw new ExecutorError('cannot resolve immutable image identity');
  }
  return {
    reference: config.image,
    repositoryDigest: resolvedRepoDigest ?? null,
    id: imageId.toLowerCase(),
    os: osName,
    architecture,
  };
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
  const gitImpl = options.gitImpl ?? spawn;
  const startedAt = options.now ?? new Date().toISOString();
  const id = randomUUID().toLowerCase();
  const phaseAContainer = `northset-executor-a-${id}`;
  const phaseBContainers = config.commands.map((_, index) => `northset-executor-b-${index}-${id}`);
  const containerNames = [phaseAContainer, ...phaseBContainers];
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-executor-'));
  const workspaceDir = path.join(temporaryRoot, 'workspace');
  let primaryError = null;

  try {
    // Resolve and, if necessary, pull the image before any command can run. Every phase uses
    // the immutable image ID; the human-friendly tag is retained only as declared metadata.
    const imageIdentity = await resolveImageIdentity(spawnImpl, config);
    await cp(config.repo_dir, workspaceDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await assertSelfContainedGitMetadata(workspaceDir);
    await makeGitMetadataWritable(workspaceDir);
    await removeLocalGitControls(workspaceDir);

    // Derive what actually ran BEFORE the patch touches the tree: the base commit (if this is a
    // git checkout) and a content digest of the base source (excluding .git and the injected
    // patch). The pipeline binds these against the receipt's declared base_commit/patch hash, so
    // a receipt cannot name code it did not execute.
    const sourceCommit = await deriveSourceCommit(gitImpl, workspaceDir);
    const baseTreeDigest = await treeDigest(workspaceDir, new Set(['.git']));

    let patchSha256 = null;
    await makeTreeWritable(workspaceDir);
    await prepareWorkspaceCacheRoot(workspaceDir);
    let trackedFiles = null;
    if (config.patch_file !== null) {
      // Read the patch ONCE; the bytes we hash are the exact bytes we stage and apply — no
      // second read that a concurrent writer could race between hashing and application.
      const patchBytes = await readFile(config.patch_file);
      patchSha256 = `sha256:${sha256Hex(patchBytes)}`;
      const patchFile = path.join(temporaryRoot, 'approved.patch');
      await writeFile(patchFile, patchBytes);
      // fs.cp preserves the source index, including cached stat data for the source worktree.
      // Refresh it explicitly after copying because optional Git locks are disabled below; without
      // this, the index-only validation can reject byte-identical files as not matching the stale index.
      const refreshed = await runWorkspaceGit(gitImpl, workspaceDir, ['update-index', '--really-refresh']);
      if (refreshed.code !== 0) throw new ExecutorError('approved patch index could not be refreshed');
      const inspected = await runWorkspaceGit(gitImpl, workspaceDir, ['apply', '--numstat', '-z', '--binary', '--', patchFile]);
      if (inspected.code !== 0) throw new ExecutorError('approved patch paths could not be inspected');
      const patchPaths = parsePatchPaths(inspected.stdout);
      for (const file of patchPaths) await assertPatchPathIsContained(workspaceDir, file);

      // Apply to the copied index first. This validates the patch and exposes its final modes
      // without touching the worktree, so a patch-created symlink is rejected before host writes.
      const indexed = await runWorkspaceGit(gitImpl, workspaceDir, ['apply', '--cached', '--binary', '--', patchFile]);
      if (indexed.code !== 0) {
        throw new ExecutorError(`approved patch could not be applied: ${(indexed.stderr || indexed.stdout || '').trim()}`);
      }
      const trackedEntries = await trackedIndexEntries(gitImpl, workspaceDir);
      rejectPatchedSymlinks(trackedEntries, patchPaths);
      trackedFiles = trackedEntries.map((entry) => entry.path);

      // The copied index now holds the approved result. Apply the same immutable bytes only to
      // the disposable worktree; all touched paths and final modes were checked above.
      const applied = await runWorkspaceGit(gitImpl, workspaceDir, ['apply', '--binary', '--', patchFile]);
      if (applied.code !== 0) {
        throw new ExecutorError(`approved patch could not be applied: ${(applied.stderr || applied.stdout || '').trim()}`);
      }
    }
    trackedFiles ??= await trackedFileList(gitImpl, workspaceDir);
    const approvedTrackedTreeDigest = await trackedTreeDigest(workspaceDir, trackedFiles);
    await removeAllGitMetadata(workspaceDir);

    const phaseAPaths = {
      workspaceDir,
      containerName: phaseAContainer,
      patchContainerFile: null,
      image: imageIdentity.id,
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
    await assertWorkspaceCacheRoots(workspaceDir);
    await removeAllGitMetadata(workspaceDir);
    const installedTrackedTreeDigest = await trackedTreeDigest(workspaceDir, trackedFiles);
    if (approvedTrackedTreeDigest !== null && installedTrackedTreeDigest !== approvedTrackedTreeDigest) {
      throw new ExecutorError('phase A modified tracked source after the approved patch');
    }
    // The exact tree the declared checks run against — AFTER the patch and the networked install
    // step. Disclosed so a receipt reveals what was actually tested, not only the base+patch
    // inputs (an install command can overwrite tracked source; this makes that visible).
    const preCheckTreeDigest = await treeDigest(workspaceDir, new Set(['.git']));
    const commandRecords = [];
    const stdoutSections = [];
    const stderrSections = [];
    for (let index = 0; index < config.commands.length; index += 1) {
      await assertWorkspaceCacheRoots(workspaceDir);
      await removeAllGitMetadata(workspaceDir);
      const command = config.commands[index];
      const result = await runDocker(
        spawnImpl,
        buildDockerArgs('phaseB', config, {
          workspaceDir,
          containerName: phaseBContainers[index],
          command,
          image: imageIdentity.id,
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
      await removeAllGitMetadata(workspaceDir);
      await assertWorkspaceCacheRoots(workspaceDir);
      await enforceWorkspaceSize(workspaceDir);
    }
    const postCheckTreeDigest = await treeDigest(workspaceDir, new Set(['.git']));

    const runRecord = {
      schema_version: 1,
      started_at: startedAt,
      finished_at: options.now ?? new Date().toISOString(),
      environment: {
        executor_profile: config.profile,
        container_image_ref: imageIdentity.reference,
        container_image_digest: imageIdentity.repositoryDigest,
        container_image_id: imageIdentity.id,
        container_os: imageIdentity.os,
        container_architecture: imageIdentity.architecture,
        network_policy: NETWORK_POLICY,
        source_commit: sourceCommit,
        base_tree_digest: baseTreeDigest,
        pre_check_tree_digest: preCheckTreeDigest,
        approved_tracked_tree_digest: approvedTrackedTreeDigest,
        post_check_tree_digest: postCheckTreeDigest,
        check_tree_changed: postCheckTreeDigest !== preCheckTreeDigest,
        patch_sha256: patchSha256,
        // Disclosed in the signed record: the networked phase-A step that can change the tree
        // before the declared checks run. Not "hidden setup".
        install_commands: [...config.install_commands],
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
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await cleanupDocker(spawnImpl, config, containerNames);
    try {
      await makeTreeWritable(temporaryRoot);
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (cleanupError) {
      if (primaryError === null) throw cleanupError;
    }
  }
}
