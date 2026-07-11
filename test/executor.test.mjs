import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
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
  imageId = resolvedImageId,
  imageIdCode = 0,
} = {}) {
  const calls = [];
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
        finishChild(child, { stdout: `${JSON.stringify(repoDigests)}\n`, code: repoDigestsCode });
      } else {
        assert.equal(args.at(-1), '{{.Id}}');
        finishChild(child, { stdout: `${imageId}\n`, code: imageIdCode });
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
        "git apply -- '/workspace/.executor.patch'",
        "rm -f -- '/workspace/.executor.patch'",
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
  assert.equal(result.runRecord.environment.container_image_digest, resolvedRepoDigest);
  assert.equal(result.runRecord.environment.network_policy, 'phaseA:bridge,phaseB:none');
  assert.match(result.runRecord.environment.container_image_digest, /sha256:/);
  assertDerivedProvenance(result.runRecord.environment, { installCommands: ['install-fixture'] });
  assert.deepEqual(result.runRecord.commands.map(({ cmd, exit_code }) => ({ cmd, exit_code })), [
    { cmd: 'first-check', exit_code: 0 },
    { cmd: 'second-check', exit_code: 0 },
  ]);
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
  assert.deepEqual(inspectCalls(fake), [[
    'image',
    'inspect',
    config().image,
    '--format',
    '{{json .RepoDigests}}',
  ]]);
  for (const args of [...runCalls(fake, 'A'), ...runCalls(fake, 'B')]) {
    assert.equal(imageFromRunArgs(args), config().image);
  }
  assertCleanupCalls(fake, 3);
  await assertTemporaryRootsGone(fake);
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
  assert.equal(result.runRecord.environment.container_image_digest, resolvedImageId);
  assert.equal(result.runRecord.environment.network_policy, 'phaseA:bridge,phaseB:none');
  assert.match(result.runRecord.environment.container_image_digest, /^sha256:/);
  assertDerivedProvenance(result.runRecord.environment, { installCommands: ['install-fixture'] });
  assert.deepEqual(inspectCalls(fake).map((args) => args.at(-1)), [
    '{{json .RepoDigests}}',
    '{{.Id}}',
  ]);
});

test('missing RepoDigests and image Id fails closed before phase B', async (t) => {
  const outputDirectory = await temporaryDirectory(t, 'northset-executor-image-missing-');
  const fake = fakeDocker({ repoDigests: [], imageId: '' });

  await assert.rejects(
    execute(config(), { outDir: outputDirectory, now: fixedNow, spawnImpl: fake.spawnImpl }),
    (error) => error instanceof ExecutorError && error.message === 'cannot resolve image digest',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assert.equal(inspectCalls(fake).length, 2);
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
    (error) => error instanceof ExecutorError && error.message === 'cannot resolve image digest',
  );

  assert.equal(runCalls(fake, 'B').length, 0);
  assert.equal(inspectCalls(fake).length, 1);
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
