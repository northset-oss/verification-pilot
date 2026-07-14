import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDockerArgs,
  execute,
  ExecutorError,
  validateExecutorConfig,
} from '../lib/executor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'test/fixtures/executor');
const repoFixture = path.join(fixtures, 'repo');
const bundleCli = path.join(root, 'bin/bundle.mjs');
const fixedNow = '2026-07-09T12:00:00Z';
const resolvedRepoDigest = `docker.io/library/node@sha256:${'a'.repeat(64)}`;
const resolvedImageId = `sha256:${'b'.repeat(64)}`;

function config(overrides = {}) {
  return {
    profile: 'node',
    image: 'node:20-bookworm',
    repo_dir: repoFixture,
    patch_file: null,
    install_commands: ['install-fixture'],
    commands: ['first-check', 'second-check'],
    limits: {
      cpus: 2,
      memory_mb: 4096,
      pids: 512,
      wall_clock_seconds_per_command: 1,
      output_bytes_per_stream: 2_000_000,
    },
    ...overrides,
  };
}

test('runtime profiles persist dependencies inside the workspace and unsupported profiles fail closed', () => {
  const node = validateExecutorConfig(config());
  const nodeArgs = buildDockerArgs('phaseA', node, {
    workspaceDir: '/tmp/workspace', containerName: 'node-profile', patchContainerFile: null,
  });
  assert.ok(nodeArgs.includes('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));

  const python = validateExecutorConfig(config({profile: 'python', image: 'python:3.12-bookworm'}));
  const pythonArgs = buildDockerArgs('phaseA', python, {
    workspaceDir: '/tmp/workspace', containerName: 'python-profile', patchContainerFile: null,
  });
  assert.match(pythonArgs.at(-1), /python3 -m venv \/workspace\/\.venv/);
  assert.ok(pythonArgs.includes('PATH=/workspace/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
  assert.throws(() => validateExecutorConfig(config({profile: 'go'})), /profile/i);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killSignals = [];
    this.onKill = null;
  }

  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal);
    this.onKill?.(signal);
    return true;
  }
}

function finishChild(child, response = {}) {
  queueMicrotask(async () => {
    try {
      await response.beforeClose?.();
      if (response.stdout !== undefined) child.stdout.write(response.stdout);
      if (response.stderr !== undefined) child.stderr.write(response.stderr);
      child.stdout.end();
      child.stderr.end();
      const code = Object.hasOwn(response, 'code') ? response.code : 0;
      child.emit('close', code, response.signal ?? null);
    } catch (error) {
      child.emit('error', error);
    }
  });
}

// git derivation runs through its own impl (not the docker fake); this stub stands in for a
// non-git workspace (rev-parse fails), so source_commit resolves to null. It answers every git
// call the same way.
function nullGit() {
  const child = new FakeChild();
  finishChild(child, { code: 128 });
  return child;
}

function assertDerivedProvenance(environment, { patchSha256 = null, installCommands = [] } = {}) {
  assert.equal(environment.source_commit, null);
  assert.match(environment.base_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(environment.pre_check_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(environment.post_check_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof environment.check_tree_changed, 'boolean');
  assert.equal(environment.patch_sha256, patchSha256);
  assert.deepEqual(environment.install_commands, installCommands);
}

function workspaceFromArgs(args) {
  const mountIndex = args.indexOf('--mount');
  if (mountIndex === -1) return null;
  const match = args[mountIndex + 1].match(/^type=bind,source=(.*),target=\/workspace$/);
  return match?.[1] ?? null;
}

function containerNameFromArgs(args) {
  const nameIndex = args.indexOf('--name');
  return nameIndex === -1 ? null : args[nameIndex + 1];
}

function imageFromRunArgs(args) {
  return args[args.indexOf('/bin/sh') - 1];
}

function fakeDocker({
  responses = {},
  phaseA = {},
  hanging = new Set(),
  repoDigests = [resolvedRepoDigest],
  repoDigestsCode = 0,
  repoDigestsCodes = null,
  imageId = resolvedImageId,
  imageIdCode = 0,
  imageOs = 'linux',
  imageArchitecture = 'amd64',
} = {}) {
  const calls = [];
  let repoInspectCount = 0;
  const children = [];
  const workspaceDirs = new Set();
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'docker');
    const child = new FakeChild();
    calls.push([...args]);
    children.push(child);

    if (args[0] === 'kill') {
      assert.equal(options, undefined);
      finishChild(child);
      return child;
    }

    assert.deepEqual(options, { stdio: ['ignore', 'pipe', 'pipe'] });

    if (args[0] === 'run') {
      const workspaceDir = workspaceFromArgs(args);
      assert.ok(workspaceDir, 'workspace mount missing');
      workspaceDirs.add(workspaceDir);
    }

    if (args[0] === 'run' && !args.includes('--network=none')) {
      finishChild(child, phaseA);
      return child;
    }

    if (args[0] === 'run') {
      const commandText = args.at(-1);
      if (hanging.has(commandText)) {
        child.onKill = (signal) => finishChild(child, { code: null, signal });
      } else {
        finishChild(child, responses[commandText]);
      }
      return child;
    }

    if (args[0] === 'image') {
      assert.deepEqual(args.slice(0, 3), ['image', 'inspect', config().image]);
      if (args.at(-1) === '{{json .RepoDigests}}') {
        const code = repoDigestsCodes?.[repoInspectCount] ?? repoDigestsCode;
        repoInspectCount += 1;
        finishChild(child, { stdout: `${JSON.stringify(repoDigests)}\n`, code });
      } else if (args.at(-1) === '{{.Id}}') {
        finishChild(child, { stdout: `${imageId}\n`, code: imageIdCode });
      } else if (args.at(-1) === '{{.Os}}') {
        finishChild(child, { stdout: `${imageOs}\n` });
      } else {
        assert.equal(args.at(-1), '{{.Architecture}}');
        finishChild(child, { stdout: `${imageArchitecture}\n` });
      }
      return child;
    }

    finishChild(child);
    return child;
  };
  return { calls, children, spawnImpl, workspaceDirs };
}

function runCalls(fake, phase) {
  return fake.calls.filter((args) => (
    args[0] === 'run' && args.includes('--network=none') === (phase === 'B')
  ));
}

function inspectCalls(fake) {
  return fake.calls.filter((args) => args[0] === 'image' && args[1] === 'inspect');
}

function assertCleanupCalls(fake, expectedCount) {
  const cleanupCalls = fake.calls.filter((args) => args[0] === 'rm');
  assert.equal(cleanupCalls.length, expectedCount);
  assert.equal(new Set(cleanupCalls.map((args) => args[2])).size, expectedCount);
  for (const args of fake.calls.filter((call) => call[0] === 'run')) {
    assert.ok(cleanupCalls.some((cleanup) => cleanup[2] === containerNameFromArgs(args)));
  }
  assert.equal(fake.calls.some((args) => args[0] === 'commit' || args[0] === 'rmi'), false);
}

async function assertTemporaryRootsGone(fake) {
  for (const workspaceDir of fake.workspaceDirs) {
    await assert.rejects(
      access(path.dirname(workspaceDir)),
      (error) => error.code === 'ENOENT',
    );
  }
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function copyMission(t) {
  const temporaryRoot = await temporaryDirectory(t, 'northset-executor-mission-');
  const missionDirectory = path.join(temporaryRoot, 'mission');
  await cp(path.join(fixtures, 'mission'), missionDirectory, { recursive: true });
  return missionDirectory;
}

function runBundle(missionDirectory, outputDirectory) {
  return spawnSync(process.execPath, [
    bundleCli,
    'create',
    missionDirectory,
    '--stdout',
    path.join(outputDirectory, 'stdout.txt'),
    '--stderr',
    path.join(outputDirectory, 'stderr.txt'),
    '--run-record',
    path.join(outputDirectory, 'run_record.json'),
    '--created-at',
    fixedNow,
  ], { cwd: root, encoding: 'utf8' });
}

function assertSecurityArgs(args) {
  for (const flag of ['--rm', '--cap-drop=ALL', '--read-only']) assert.ok(args.includes(flag), `${flag} missing`);
  for (const [flag, value] of [
    ['--security-opt', 'no-new-privileges'],
    ['--user', '1000:1000'],
    ['--pids-limit', '512'],
    ['--memory', '4096m'],
    ['--cpus', '2'],
    ['--tmpfs', '/tmp:size=512m'],
    ['--workdir', '/workspace'],
  ]) {
    const index = args.indexOf(flag);
    assert.notEqual(index, -1, `${flag} missing`);
    assert.equal(args[index + 1], value);
  }
}

test('buildDockerArgs encodes both-phase isolation without host environment or source paths', () => {
  const previousCanary = process.env.EXECUTOR_ARGV_CANARY;
  process.env.EXECUTOR_ARGV_CANARY = 'executor-host-secret-canary';
  try {
    const sourceConfig = config({
      repo_dir: '/original/private/repository',
      patch_file: '/original/private/change.patch',
    });
    const commonPaths = {
      workspaceDir: '/tmp/executor-copy/workspace',
      containerName: 'executor-container',
    };
    const phaseA = buildDockerArgs('phaseA', sourceConfig, {
      ...commonPaths,
      patchContainerFile: '/workspace/.executor.patch',
    });
    const phaseB = buildDockerArgs('phaseB', sourceConfig, {
      ...commonPaths,
      command: 'pnpm test',
    });

    assertSecurityArgs(phaseA);
    assertSecurityArgs(phaseB);
    assert.equal(phaseA.includes('--network=none'), false);
    assert.ok(phaseB.includes('--network=none'));
    assert.equal(imageFromRunArgs(phaseA), sourceConfig.image);
    assert.equal(imageFromRunArgs(phaseB), sourceConfig.image);
    assert.equal(
      phaseA.at(-1),
      [
        'set -e',
        'install-fixture',
      ].join('\n'),
    );
    assert.throws(
      () => buildDockerArgs('commit', sourceConfig, {}),
      /unknown Docker argv phase commit/,
    );
    assert.throws(
      () => buildDockerArgs('rmi', sourceConfig, {}),
      /unknown Docker argv phase rmi/,
    );
    for (const args of [phaseA, phaseB]) {
      assert.equal(args.some((argument) => argument.includes(process.env.EXECUTOR_ARGV_CANARY)), false);
      assert.equal(args.some((argument) => argument.includes(sourceConfig.repo_dir)), false);
      assert.equal(args.some((argument) => argument.includes(sourceConfig.patch_file)), false);
      assert.ok(args.includes('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));
      assert.ok(args.includes('HOME=/tmp'));
      assert.ok(args.includes('CI=true'));
      assert.ok(args.includes('COREPACK_HOME=/workspace/.northset/corepack'));
      assert.ok(args.includes('NPM_CONFIG_CACHE=/workspace/.northset/npm-cache'));
      assert.ok(args.includes('XDG_CACHE_HOME=/workspace/.northset/cache'));
      assert.ok(args.includes('XDG_DATA_HOME=/workspace/.northset/share'));
    }
  } finally {
    if (previousCanary === undefined) delete process.env.EXECUTOR_ARGV_CANARY;
    else process.env.EXECUTOR_ARGV_CANARY = previousCanary;
  }
});

test('config rejects unknown top-level keys', () => {
  assert.throws(
    () => validateExecutorConfig(config({ unexpected: true })),
    (error) => error instanceof ExecutorError && error.errors.some((item) => item.path === '$.unexpected'),
  );
});

test('happy path writes deterministic bundle-compatible outputs', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-output-');
  const missionDirectory = await copyMission(t);
  const fake = fakeDocker({
    responses: {
      'first-check': { stdout: 'first stdout\n', stderr: 'first stderr\n', code: 0 },
      'second-check': { stdout: 'second stdout\n', code: 0 },
    },
  });
  const result = await execute(config(), {
    outDir: outputDirectory,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  assert.equal(result.runRecord.started_at, fixedNow);
  assert.equal(result.runRecord.finished_at, fixedNow);
  assert.equal(result.runRecord.environment.container_image_ref, 'node:20-bookworm');
  assert.equal(result.runRecord.schema_version, 2);
  assert.equal(result.runRecord.environment.container_image_digest, resolvedRepoDigest);
  assert.equal(result.runRecord.environment.container_image_id, resolvedImageId);
  assert.equal(result.runRecord.environment.container_os, 'linux');
  assert.equal(result.runRecord.environment.container_architecture, 'amd64');
  assert.equal(result.runRecord.environment.network_policy, 'phaseA:bridge,phaseB:none');
  assert.match(result.runRecord.environment.container_image_digest, /sha256:/);
  assertDerivedProvenance(result.runRecord.environment, { installCommands: ['install-fixture'] });
  assert.deepEqual(result.runRecord.commands.map(({ cmd, exit_code }) => ({ cmd, exit_code })), [
    { cmd: 'first-check', exit_code: 0 },
    { cmd: 'second-check', exit_code: 0 },
  ]);
  assert.equal(Number.isInteger(result.runRecord.usage.networked_setup_elapsed_ms), true);
  assert.equal(result.runRecord.usage.dependency_install_ms, null);
  assert.equal(
    result.runRecord.usage.declared_commands_ms,
    result.runRecord.commands.reduce((total, command) => total + command.duration_ms, 0),
  );
  assert.equal(
    await readFile(path.join(outputDirectory, 'stdout.txt'), 'utf8'),
    '=== cmd 1: first-check ===\nfirst stdout\n=== cmd 2: second-check ===\nsecond stdout\n',
  );
  assert.equal(
    await readFile(path.join(outputDirectory, 'stderr.txt'), 'utf8'),
    '=== cmd 1: first-check ===\nfirst stderr\n=== cmd 2: second-check ===\n',
  );

  const bundle = runBundle(missionDirectory, outputDirectory);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.match(bundle.stdout, /^bundle_digest sha256:[0-9a-f]{64}\n$/);
  assert.equal(runCalls(fake, 'A').length, 1);
  assert.equal(runCalls(fake, 'B').length, 2);
  assert.deepEqual(inspectCalls(fake).map((args) => args.at(-1)), [
    '{{json .RepoDigests}}', '{{.Id}}', '{{.Os}}', '{{.Architecture}}',
  ]);
  assert.ok(fake.calls.indexOf(inspectCalls(fake)[0]) < fake.calls.indexOf(runCalls(fake, 'A')[0]));
  for (const args of [...runCalls(fake, 'A'), ...runCalls(fake, 'B')]) {
    assert.equal(imageFromRunArgs(args), resolvedImageId);
  }
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('approved patch refreshes the copied index before hardened application', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-patch-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-patch-repo-');
  const patchFile = path.join(await temporaryDirectory(t, 'northset-executor-patch-file-'), 'change.patch');
  const trackedFile = path.join(repoDirectory, 'tracked.txt');
  await writeFile(trackedFile, 'before\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(trackedFile, 'after\n');
  const diff = spawnSync('git', ['-C', repoDirectory, 'diff', '--binary', '--full-index'], {encoding: 'utf8'});
  assert.equal(diff.status, 0, diff.stderr);
  await writeFile(patchFile, diff.stdout);
  await writeFile(trackedFile, 'before\n');

  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  const result = await execute(config({
    repo_dir: repoDirectory,
    patch_file: patchFile,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl});

  assert.match(result.runRecord.environment.patch_sha256, /^sha256:[0-9a-f]{64}$/);
});

test('approved patch cannot traverse a source symlink outside the disposable workspace', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-patch-symlink-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-patch-symlink-repo-');
  const externalDirectory = await temporaryDirectory(t, 'northset-executor-patch-symlink-target-');
  const patchFile = path.join(await temporaryDirectory(t, 'northset-executor-patch-symlink-file-'), 'change.patch');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await symlink(externalDirectory, path.join(repoDirectory, 'link'), 'dir');
  await writeFile(patchFile, [
    'diff --git a/link/owned.txt b/link/owned.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/link/owned.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    '',
  ].join('\n'));
  let dockerRuns = 0;
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({
      repo_dir: repoDirectory,
      patch_file: patchFile,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl}),
    /symlink/,
  );

  assert.equal(existsSync(path.join(externalDirectory, 'owned.txt')), false);
  assert.equal(dockerRuns, 0);
});

test('approved patch cannot introduce a symlink into the disposable workspace', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-patch-new-symlink-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-patch-new-symlink-repo-');
  const patchFile = path.join(await temporaryDirectory(t, 'northset-executor-patch-new-symlink-file-'), 'change.patch');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(patchFile, [
    'diff --git a/link b/link',
    'new file mode 120000',
    '--- /dev/null',
    '+++ b/link',
    '@@ -0,0 +1 @@',
    '+/tmp/external-target',
    '\\ No newline at end of file',
    '',
  ].join('\n'));
  let dockerRuns = 0;
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({
      repo_dir: repoDirectory,
      patch_file: patchFile,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl}),
    /symlink/,
  );

  assert.equal(dockerRuns, 0);
});

test('approved patch cannot target a case-varied executor cache path', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-patch-cache-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-patch-cache-repo-');
  const patchFile = path.join(await temporaryDirectory(t, 'northset-executor-patch-cache-file-'), 'change.patch');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(patchFile, [
    'diff --git a/.Northset/poison.txt b/.Northset/poison.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/.Northset/poison.txt',
    '@@ -0,0 +1 @@',
    '+poison',
    '',
  ].join('\n'));
  let dockerRuns = 0;
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({
      repo_dir: repoDirectory,
      patch_file: patchFile,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl}),
    /unsafe path/,
  );

  assert.equal(dockerRuns, 0);
});

test('all copied Git metadata is removed before Docker starts', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-git-metadata-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-git-metadata-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
    ['remote', 'add', 'origin', 'https://credential-canary@example.invalid/private.git'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(repoDirectory, '.git', 'hooks', 'credential-canary'), 'host hook\n');
  await mkdir(path.join(repoDirectory, '.git', 'worktrees', 'linked'), {recursive: true});
  await writeFile(path.join(repoDirectory, '.git', 'worktrees', 'linked', 'gitdir'), '/host/path/linked/.git\n');
  await mkdir(path.join(repoDirectory, 'nested', '.git'), {recursive: true});
  await writeFile(path.join(repoDirectory, 'nested', '.git', 'config'), '[remote "origin"]\n\turl = https://nested.example.invalid/private.git\n');
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  const inspected = new Set();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') {
      const workspace = workspaceFromArgs(args);
      assert.equal(existsSync(path.join(workspace, '.git')), false, 'root .git reached Docker');
      assert.equal(existsSync(path.join(workspace, 'nested', '.git')), false, 'nested .git reached Docker');
      inspected.add(args.includes('--network=none') ? 'B' : 'A');
    }
    return fake.spawnImpl(command, args, options);
  };

  await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl});

  assert.deepEqual([...inspected].sort(), ['A', 'B']);
});

test('case-varied nested Git metadata is removed before Docker starts', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-case-git-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-case-git-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  await mkdir(path.join(repoDirectory, 'nested', '.Git'), {recursive: true});
  await writeFile(path.join(repoDirectory, 'nested', '.Git', 'config'), 'credential canary\n');
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') {
      assert.equal(
        existsSync(path.join(workspaceFromArgs(args), 'nested', '.Git')),
        false,
        'case-varied nested Git metadata reached Docker',
      );
    }
    return fake.spawnImpl(command, args, options);
  };

  await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl, gitImpl: nullGit});
});

test('local core.worktree cannot make dirty Docker bytes claim a clean source commit', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-core-worktree-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-core-worktree-repo-');
  const redirectedWorktree = await temporaryDirectory(t, 'northset-executor-core-worktree-clean-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'clean\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(redirectedWorktree, 'tracked.txt'), 'clean\n');
  const redirected = spawnSync('git', ['-C', repoDirectory, 'config', 'core.worktree', redirectedWorktree], {encoding: 'utf8'});
  assert.equal(redirected.status, 0, redirected.stderr);
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'dirty bytes Docker will run\n');

  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  let dockerContent = null;
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run' && !args.includes('--network=none')) {
      dockerContent = readFileSync(path.join(workspaceFromArgs(args), 'tracked.txt'), 'utf8');
    }
    return fake.spawnImpl(command, args, options);
  };
  const result = await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl});

  assert.equal(result.runRecord.environment.source_commit, null);
  assert.equal(dockerContent, 'dirty bytes Docker will run\n');
});

test('hidden index flags cannot make dirty Docker bytes claim a clean source commit', async (t) => {
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    const outputDirectory = await temporaryDirectory(t, `northset-executor-hidden-index-output-${flag.slice(2)}-`);
    const repoDirectory = await temporaryDirectory(t, `northset-executor-hidden-index-repo-${flag.slice(2)}-`);
    await writeFile(path.join(repoDirectory, 'tracked.txt'), 'clean\n');
    for (const args of [
      ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
      ['add', 'tracked.txt'], ['commit', '-m', 'fixture'], ['update-index', flag, 'tracked.txt'],
    ]) {
      const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
    }
    await writeFile(path.join(repoDirectory, 'tracked.txt'), `dirty bytes hidden by ${flag}\n`);

    const fake = fakeDocker({responses: {'first-check': {code: 0}}});
    let dockerContent = null;
    const spawnImpl = (command, args, options) => {
      if (args[0] === 'run' && !args.includes('--network=none')) {
        dockerContent = readFileSync(path.join(workspaceFromArgs(args), 'tracked.txt'), 'utf8');
      }
      return fake.spawnImpl(command, args, options);
    };
    const result = await execute(config({
      repo_dir: repoDirectory,
      patch_file: null,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl});

    assert.equal(result.runRecord.environment.source_commit, null, flag);
    assert.equal(dockerContent, `dirty bytes hidden by ${flag}\n`);
  }
});

test('Git replace refs cannot make alternate bytes claim the replaced source commit', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-replace-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-replace-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'clean\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'clean'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  const cleanCommit = spawnSync('git', ['-C', repoDirectory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'replacement bytes\n');
  for (const args of [['add', 'tracked.txt'], ['commit', '-m', 'replacement']]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  const replacementCommit = spawnSync('git', ['-C', repoDirectory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
  for (const args of [
    ['reset', '--hard', cleanCommit],
    ['replace', cleanCommit, replacementCommit],
    ['reset', '--hard', 'HEAD'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  let dockerContent = null;
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run' && !args.includes('--network=none')) {
      dockerContent = readFileSync(path.join(workspaceFromArgs(args), 'tracked.txt'), 'utf8');
    }
    return fake.spawnImpl(command, args, options);
  };
  const result = await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl});

  assert.equal(result.runRecord.environment.source_commit, null);
  assert.equal(dockerContent, 'replacement bytes\n');
});

test('ignored untracked bytes disqualify the clean source commit claim', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-ignored-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-ignored-repo-');
  await writeFile(path.join(repoDirectory, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'tracked\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', '.gitignore', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await writeFile(path.join(repoDirectory, 'ignored.txt'), 'hidden bytes\n');
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  let ignoredVisible = false;
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run' && !args.includes('--network=none')) {
      ignoredVisible = existsSync(path.join(workspaceFromArgs(args), 'ignored.txt'));
    }
    return fake.spawnImpl(command, args, options);
  };
  const result = await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl});

  assert.equal(result.runRecord.environment.source_commit, null);
  assert.equal(ignoredVisible, true);
});

test('Git metadata recreated during phase A is removed before phase B', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-phase-a-git-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-phase-a-git-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});
  let phaseBInspected = false;
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') {
      const gitDirectory = path.join(workspaceFromArgs(args), '.git');
      if (args.includes('--network=none')) {
        assert.equal(existsSync(gitDirectory), false, 'phase-A-created .git reached phase B');
        phaseBInspected = true;
      } else {
        mkdirSync(gitDirectory, {recursive: true});
        writeFileSync(path.join(gitDirectory, 'config'), '[core]\n\tbare = false\n');
      }
    }
    return fake.spawnImpl(command, args, options);
  };

  await execute(config({
    repo_dir: repoDirectory,
    patch_file: null,
    install_commands: [],
    commands: ['first-check'],
  }), {outDir: outputDirectory, now: fixedNow, spawnImpl, gitImpl: nullGit});

  assert.equal(phaseBInspected, true);
});

test('a copied linked-worktree pointer is rejected before host Git or Docker runs', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-linked-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-linked-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  await writeFile(path.join(repoDirectory, '.git'), 'gitdir: /host/private/worktrees/source\n');
  let gitCalls = 0;
  let dockerRuns = 0;
  const gitImpl = () => {
    gitCalls += 1;
    const child = new FakeChild();
    finishChild(child, {code: 128});
    return child;
  };
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({
      repo_dir: repoDirectory,
      patch_file: null,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl, gitImpl}),
    /self-contained directory/,
  );

  assert.equal(gitCalls, 0);
  assert.equal(dockerRuns, 0);
});

test('Git metadata symlinks are rejected before cleanup can touch their targets', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-git-symlink-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-git-symlink-repo-');
  const externalObjects = await temporaryDirectory(t, 'northset-executor-git-symlink-target-');
  await mkdir(path.join(repoDirectory, '.git'), {recursive: true});
  await mkdir(path.join(externalObjects, 'info'), {recursive: true});
  const externalAlternates = path.join(externalObjects, 'info', 'alternates');
  await writeFile(externalAlternates, '/host/private/objects\n');
  await symlink(externalObjects, path.join(repoDirectory, '.git', 'objects'), 'dir');
  let gitCalls = 0;
  let dockerRuns = 0;
  const gitImpl = () => {
    gitCalls += 1;
    const child = new FakeChild();
    finishChild(child, {code: 128});
    return child;
  };
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({repo_dir: repoDirectory, patch_file: null}), {
      outDir: outputDirectory, now: fixedNow, spawnImpl, gitImpl,
    }),
    /must not contain symlinks/,
  );

  await access(externalAlternates);
  assert.equal(gitCalls, 0);
  assert.equal(dockerRuns, 0);
});

test('a source-supplied .northset path is rejected before Docker starts', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-cache-root-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-cache-root-repo-');
  const externalCache = await temporaryDirectory(t, 'northset-executor-cache-root-target-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  await symlink(externalCache, path.join(repoDirectory, '.northset'), 'dir');
  let dockerRuns = 0;
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({repo_dir: repoDirectory, patch_file: null}), {
      outDir: outputDirectory, now: fixedNow, spawnImpl, gitImpl: nullGit,
    }),
    /reserved \.northset/,
  );

  assert.equal(dockerRuns, 0);
});

test('a read-only source is normalized and its disposable copy is always removed', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-readonly-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-readonly-repo-');
  const trackedFile = path.join(repoDirectory, 'tracked.txt');
  await writeFile(trackedFile, 'fixture\n');
  await chmod(trackedFile, 0o444);
  await chmod(repoDirectory, 0o555);
  const fake = fakeDocker({responses: {'first-check': {code: 0}}});

  try {
    await execute(config({
      repo_dir: repoDirectory,
      patch_file: null,
      install_commands: [],
      commands: ['first-check'],
    }), {outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl, gitImpl: nullGit});
  } finally {
    await chmod(repoDirectory, 0o755).catch(() => {});
    await chmod(trackedFile, 0o644).catch(() => {});
  }

  await assertTemporaryRootsGone(fake);
});

test('Git submodules are rejected before Docker because their interiors are outside the tracked manifest', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-submodule-output-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-submodule-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = spawnSync('git', ['-C', repoDirectory, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).stdout.trim();
  for (const args of [
    ['update-index', '--add', '--cacheinfo', `160000,${commit},sub`],
    ['commit', '-m', 'add submodule gitlink'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await mkdir(path.join(repoDirectory, 'sub'));
  await writeFile(path.join(repoDirectory, 'sub', 'tracked.txt'), 'submodule bytes\n');
  let dockerRuns = 0;
  const fake = fakeDocker();
  const spawnImpl = (command, args, options) => {
    if (args[0] === 'run') dockerRuns += 1;
    return fake.spawnImpl(command, args, options);
  };

  await assert.rejects(
    execute(config({repo_dir: repoDirectory, patch_file: null}), {
      outDir: outputDirectory, now: fixedNow, spawnImpl,
    }),
    /submodules are not supported/,
  );

  assert.equal(dockerRuns, 0);
});

test('empty RepoDigests falls back to the resolved image Id', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-image-id-');
  const fake = fakeDocker({ repoDigests: [], imageId: resolvedImageId });
  const result = await execute(config(), {
    outDir: outputDirectory,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  assert.equal(result.runRecord.environment.container_image_ref, 'node:20-bookworm');
  assert.equal(result.runRecord.environment.container_image_digest, null);
  assert.equal(result.runRecord.environment.container_image_id, resolvedImageId);
  assert.equal(result.runRecord.environment.network_policy, 'phaseA:bridge,phaseB:none');
  assertDerivedProvenance(result.runRecord.environment, { installCommands: ['install-fixture'] });
  assert.deepEqual(inspectCalls(fake).map((args) => args.at(-1)), [
    '{{json .RepoDigests}}',
    '{{.Id}}',
    '{{.Os}}',
    '{{.Architecture}}',
  ]);
});

test('an absent local image is pulled once, resolved before phase A, and every phase uses its immutable ID', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-image-pull-');
  const fake = fakeDocker({ repoDigestsCodes: [1, 0] });
  await execute(config(), {
    outDir: outputDirectory,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  assert.equal(fake.calls.filter((args) => args[0] === 'pull').length, 1);
  const firstRun = fake.calls.findIndex((args) => args[0] === 'run');
  const finalInspect = fake.calls.findLastIndex((args) => args[0] === 'image');
  assert.ok(finalInspect < firstRun);
  for (const args of fake.calls.filter((entry) => entry[0] === 'run')) {
    assert.equal(imageFromRunArgs(args), resolvedImageId);
  }
});

test('missing RepoDigests and image Id fails closed before phase B', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-image-missing-');
  const fake = fakeDocker({ repoDigests: [], imageId: '' });

  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'cannot resolve immutable image identity',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assert.equal(inspectCalls(fake).length, 4);
  await assert.rejects(
    access(path.join(outputDirectory, 'run_record.json')),
    (error) => error.code === 'ENOENT',
  );
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('failed image inspection fails closed before phase B', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-image-inspect-failure-');
  const fake = fakeDocker({ repoDigestsCode: 1 });

  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'cannot resolve immutable image identity',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assert.equal(inspectCalls(fake).length, 2);
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('stream output is truncated at the byte cap with a marker', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-truncate-');
  const fake = fakeDocker({ responses: { 'large-output': { stdout: 'abcdefgh', stderr: '1234567', code: 0 } } });
  await execute(config({
    commands: ['large-output'],
    limits: { ...config().limits, output_bytes_per_stream: 5 },
  }), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl });

  assert.equal(
    await readFile(path.join(outputDirectory, 'stdout.txt'), 'utf8'),
    '=== cmd 1: large-output ===\nabcde\n[TRUNCATED]\n',
  );
  assert.equal(
    await readFile(path.join(outputDirectory, 'stderr.txt'), 'utf8'),
    '=== cmd 1: large-output ===\n12345\n[TRUNCATED]\n',
  );
});

test('a nonzero exit is recorded and later commands still run', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-nonzero-');
  const fake = fakeDocker({
    responses: {
      'first-check': { code: 7 },
      'second-check': { code: 0 },
    },
  });
  const result = await execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl });

  assert.deepEqual(result.runRecord.commands.map((command) => command.exit_code), [7, 0]);
  assert.deepEqual(
    runCalls(fake, 'B').map((args) => args.at(-1)),
    ['first-check', 'second-check'],
  );
});

test('timeout records null exit and timed_out, continues, and is accepted by bundle create', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-timeout-');
  const missionDirectory = await copyMission(t);
  const fake = fakeDocker({
    hanging: new Set(['first-check']),
    responses: { 'second-check': { code: 0 } },
  });
  const result = await execute(config({
    limits: { ...config().limits, wall_clock_seconds_per_command: 0.005 },
  }), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl });

  assert.equal(result.runRecord.commands[0].exit_code, null);
  assert.equal(result.runRecord.commands[0].timed_out, true);
  assert.equal(result.runRecord.commands[1].exit_code, 0);
  const timedOutChild = fake.children[
    fake.calls.findIndex((args) => args[0] === 'run' && args.at(-1) === 'first-check')
  ];
  assert.ok(timedOutChild.killSignals.includes('SIGTERM'));
  const timedOutRun = runCalls(fake, 'B').find((args) => args.at(-1) === 'first-check');
  assert.ok(fake.calls.some((args) => (
    args[0] === 'kill' && args[1] === containerNameFromArgs(timedOutRun)
  )));

  const bundle = runBundle(missionDirectory, outputDirectory);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.match(bundle.stdout, /^bundle_digest sha256:[0-9a-f]{64}\n$/);
});

test('phase A nonzero exit aborts phase B and cleanup removes every container and workspace', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-cleanup-');
  const fake = fakeDocker({ phaseA: { code: 17 } });
  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'phase A failed with exit code 17',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('phase A cannot mutate tracked source after the approved patch', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-tracked-source-');
  const repoDirectory = await temporaryDirectory(t, 'northset-executor-git-repo-');
  await writeFile(path.join(repoDirectory, 'tracked.txt'), 'approved\n');
  for (const args of [
    ['init'], ['config', 'user.name', 'Northset Test'], ['config', 'user.email', 'test@northset.ai'],
    ['add', 'tracked.txt'], ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repoDirectory, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  let fake;
  fake = fakeDocker({phaseA: {
    code: 0,
    beforeClose: async () => {
      const [workspaceDir] = fake.workspaceDirs;
      await writeFile(path.join(workspaceDir, 'tracked.txt'), 'mutated by install\n');
    },
  }});

  await assert.rejects(
    execute(config({repo_dir: repoDirectory}), {
      outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl,
    }),
    (error) => error instanceof ExecutorError && /phase A modified tracked source/.test(error.message),
  );
  assert.equal(runCalls(fake, 'B').length, 0);
  assertCleanupCalls(fake, 3);
});

test('workspace cap breach after a phase-B command stops later commands and cleans up', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-workspace-cap-');
  let fake;
  fake = fakeDocker({
    responses: {
      'first-check': {
        code: 0,
        beforeClose: async () => {
          const [workspaceDir] = fake.workspaceDirs;
          const oversizedFile = path.join(workspaceDir, 'oversized.bin');
          await writeFile(oversizedFile, '');
          await truncate(oversizedFile, (2 * 1024 * 1024 * 1024) + 1);
        },
      },
    },
  });

  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'workspace exceeded size cap',
  );

  assert.deepEqual(runCalls(fake, 'B').map((args) => args.at(-1)), ['first-check']);
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('phase A workspace cap breach aborts before phase B', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-phase-a-cap-');
  let fake;
  fake = fakeDocker({
    phaseA: {
      code: 0,
      beforeClose: async () => {
        const [workspaceDir] = fake.workspaceDirs;
        const oversizedFile = path.join(workspaceDir, 'oversized-install.bin');
        await writeFile(oversizedFile, '');
        await truncate(oversizedFile, (2 * 1024 * 1024 * 1024) + 1);
      },
    },
  });

  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'workspace exceeded size cap',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
});

test('optional Docker integration', {
  skip: process.env.EXECUTOR_DOCKER_TEST !== '1',
}, async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-docker-');
  const result = await execute(config({
    image: process.env.EXECUTOR_DOCKER_IMAGE ?? 'alpine:3.20',
    install_commands: [],
    commands: ["printf 'docker integration ok\\n'"],
    limits: {
      cpus: 1,
      memory_mb: 256,
      pids: 64,
      wall_clock_seconds_per_command: 60,
      output_bytes_per_stream: 10_000,
    },
  }), { outDir: outputDirectory, now: fixedNow });

  assert.equal(result.runRecord.commands[0].exit_code, 0);
  assert.match(await readFile(result.stdoutFile, 'utf8'), /docker integration ok/);
});
