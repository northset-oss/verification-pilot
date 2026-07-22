import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {existsSync} from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

import {
  buildDockerArgs,
  execute,
  validateExecutorConfig,
} from '../lib/executor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executorSource = path.join(root, 'lib/executor.mjs');
const fixedNow = '2026-07-21T12:00:00Z';
const resolvedImageId = `sha256:${'b'.repeat(64)}`;
const resolvedRepoDigest = `docker.io/library/node@sha256:${'a'.repeat(64)}`;
const dockerTestImage = process.env.EXECUTOR_DOCKER_IMAGE ?? 'node:20-bookworm';
let dockerTestSkip;

function dockerTestSkipReason() {
  if (process.env.EXECUTOR_DOCKER_TEST !== '1') {
    return 'real Docker gate disabled; set EXECUTOR_DOCKER_TEST=1 on the production host';
  }
  if (dockerTestSkip !== undefined) return dockerTestSkip;
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (info.error || info.status !== 0) {
    const detail = info.error?.message ?? info.stderr.trim() ?? `exit ${info.status}`;
    dockerTestSkip = `real Docker gate skipped: Docker daemon unavailable (${detail})`;
  } else {
    dockerTestSkip = false;
  }
  return dockerTestSkip;
}

function dockerPhaseANetworkSkipReason() {
  const dockerSkip = dockerTestSkipReason();
  if (dockerSkip) return dockerSkip;
  if (
    !process.env.EXECUTOR_PHASE_A_ALLOWED_URL
    || !process.env.EXECUTOR_PHASE_A_DENIED_HOST
  ) {
    return 'phase-A network policy gate requires explicit allowed and denied targets';
  }
  return false;
}

function dockerFailure(result) {
  return [
    result.error ? `spawn error: ${result.error.message}` : null,
    `exit: ${result.status}`,
    `signal: ${result.signal}`,
    `stdout:\n${result.stdout ?? ''}`,
    `stderr:\n${result.stderr ?? ''}`,
  ].filter(Boolean).join('\n');
}

async function runRuntimePhase(t, phase, script, {limits = {}, image = dockerTestImage} = {}) {
  const workspace = await temporaryDirectory(t, 'northset-boundary-runtime-');
  await chmod(workspace, 0o755);
  await writeFile(path.join(workspace, 'probe.mjs'), script);
  const containerName = `northset-boundary-gate-${randomUUID()}`;
  t.after(() => {
    spawnSync('docker', ['rm', '-f', containerName], {encoding: 'utf8', timeout: 5_000});
  });
  const command = 'node /workspace/probe.mjs';
  const config = validateExecutorConfig(fixtureConfig({
    image,
    repo_dir: workspace,
    install_commands: phase === 'phaseA' ? [command] : [],
    commands: phase === 'phaseB' ? [command] : ['unused'],
    limits: {...fixtureConfig().limits, wall_clock_seconds_per_command: 10, ...limits},
  }));
  const args = buildDockerArgs(phase, config, {
    workspaceDir: workspace,
    containerName,
    command,
    image,
  });
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 256 * 1024,
  });
  spawnSync('docker', ['rm', '-f', containerName], {encoding: 'utf8', timeout: 5_000});
  return result;
}

function fixtureConfig(overrides = {}) {
  return {
    profile: 'node',
    image: 'node:20-bookworm',
    repo_dir: '/untrusted/source/repository',
    patch_file: null,
    install_commands: [],
    commands: ['check-one', 'check-two'],
    limits: {
      cpus: 1,
      memory_mb: 128,
      pids: 32,
      wall_clock_seconds_per_command: 1,
      output_bytes_per_stream: 64,
    },
    ...overrides,
  };
}

function dockerArgs(phase, overrides = {}, pathOverrides = {}) {
  const config = validateExecutorConfig(fixtureConfig(overrides));
  return buildDockerArgs(phase, config, {
    workspaceDir: '/tmp/northset-executor-fixture/workspace',
    containerName: `boundary-${phase.toLowerCase()}`,
    command: 'true',
    ...pathOverrides,
  });
}

function optionValues(args, option) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) values.push(args[index + 1]);
  }
  return values;
}

function cleanEnvironmentFromArgs(args) {
  const cleanIndex = args.indexOf('-i');
  const shellIndex = args.indexOf('/bin/sh');
  assert.notEqual(cleanIndex, -1, 'env -i missing');
  assert.ok(shellIndex > cleanIndex, 'clean environment is not applied before the shell');
  return args.slice(cleanIndex + 1, shellIndex);
}

function workspaceFromArgs(args) {
  const mount = optionValues(args, '--mount').find((value) => value.includes('target=/workspace'));
  return /^type=bind,source=(.*),target=\/workspace(?:,readonly)?$/.exec(mount ?? '')?.[1] ?? null;
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal = 'SIGTERM') {
    queueMicrotask(() => this.emit('close', null, signal));
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
      child.emit('close', Object.hasOwn(response, 'code') ? response.code : 0, response.signal ?? null);
    } catch (error) {
      child.emit('error', error);
    }
  });
}

function nullGit() {
  const child = new FakeChild();
  finishChild(child, {code: 128});
  return child;
}

function fakeDocker({phaseA, phaseB, responses = {}} = {}) {
  const calls = [];
  const workspaceDirs = new Set();
  const spawnImpl = (command, args, options) => {
    assert.equal(command, 'docker');
    const child = new FakeChild();
    calls.push([...args]);

    if (args[0] === 'kill') {
      assert.equal(options, undefined);
      finishChild(child);
      return child;
    }
    assert.deepEqual(options, {stdio: ['ignore', 'pipe', 'pipe']});

    if (args[0] === 'image') {
      const format = args.at(-1);
      const stdout = {
        '{{json .RepoDigests}}': `${JSON.stringify([resolvedRepoDigest])}\n`,
        '{{.Id}}': `${resolvedImageId}\n`,
        '{{.Os}}': 'linux\n',
        '{{.Architecture}}': 'amd64\n',
      }[format];
      assert.notEqual(stdout, undefined, `unexpected image inspect format: ${format}`);
      finishChild(child, {stdout});
      return child;
    }

    if (args[0] === 'run') {
      const workspace = workspaceFromArgs(args);
      assert.ok(workspace, 'workspace bind mount missing');
      workspaceDirs.add(workspace);
      const isPhaseB = args.includes('--network=none');
      const callback = isPhaseB ? phaseB : phaseA;
      const response = isPhaseB ? (responses[args.at(-1)] ?? {}) : {};
      finishChild(child, {
        ...response,
        beforeClose: async () => {
          await callback?.({args, workspace, command: args.at(-1)});
          await response.beforeClose?.();
        },
      });
      return child;
    }

    finishChild(child);
    return child;
  };
  return {calls, spawnImpl, workspaceDirs};
}

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

async function simpleRepo(t, files = {'source.txt': 'fixture\n'}) {
  const repo = await temporaryDirectory(t, 'northset-boundary-repo-');
  for (const [relativePath, bytes] of Object.entries(files)) {
    const file = path.join(repo, relativePath);
    await mkdir(path.dirname(file), {recursive: true});
    await writeFile(file, bytes);
  }
  return repo;
}

function phaseBCalls(fake) {
  return fake.calls.filter((args) => args[0] === 'run' && args.includes('--network=none'));
}

function tarOctal(header, offset, length, value) {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
}

function tarHeader(name, {type = '0', linkname = ''} = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  tarOctal(header, 100, 8, type === '2' ? 0o777 : 0o644);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, 0);
  tarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function hostileTarBytes(externalTarget) {
  return Buffer.concat([
    tarHeader('../outside.txt'),
    tarHeader('/absolute.txt'),
    tarHeader('escape-link', {type: '2', linkname: externalTarget}),
    Buffer.alloc(1024),
  ]);
}

test('1 metadata access: phase B only; phase A metadata reachability is a deployment precondition, not proven here', () => {
  const args = dockerArgs('phaseB');
  assert.ok(args.includes('--network=none'));
  assert.equal(args.some((value) => value.includes('169.254.169.254')), false);
  assert.equal(args.some((value) => value.startsWith('--add-host')), false);
});

test('2 env-var reading: both phases clear image/client env before the fixed allowlist', async (t) => {
  const expectedEnvironment = [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    'HOME=/tmp',
    'CI=true',
    'COREPACK_HOME=/workspace/.northset/corepack',
    'NPM_CONFIG_CACHE=/workspace/.northset/npm-cache',
    'XDG_CACHE_HOME=/workspace/.northset/cache',
    'XDG_DATA_HOME=/workspace/.northset/share',
  ];
  const canaries = {
    GITHUB_TOKEN: 'github-secret-canary',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-canary',
    NORTHSET_SIGNING_KEY: 'signing-secret-canary',
    OPENAI_API_KEY: 'model-secret-canary',
  };
  const previous = Object.fromEntries(Object.keys(canaries).map((key) => [key, process.env[key]]));
  Object.assign(process.env, canaries);
  try {
    for (const phase of ['phaseA', 'phaseB']) {
      const args = dockerArgs(phase);
      assert.deepEqual(optionValues(args, '--entrypoint'), ['/usr/bin/env']);
      assert.deepEqual(cleanEnvironmentFromArgs(args), expectedEnvironment);
      assert.deepEqual(optionValues(args, '--env'), []);
      assert.equal(args.includes('--env-file'), false);
      for (const [name, value] of Object.entries(canaries)) {
        assert.equal(cleanEnvironmentFromArgs(args).some((entry) => entry.startsWith(`${name}=`)), false);
        assert.equal(args.some((entry) => entry.includes(value)), false);
      }
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  await t.test('real Docker environment is sanitized before the foreign shell', {
    skip: dockerTestSkipReason(),
  }, async (st) => {
    const repo = await simpleRepo(st);
    const outDir = await temporaryDirectory(st, 'northset-boundary-env-docker-');
    const runtimeCanaries = {
      GITHUB_TOKEN: 'runtime-github-secret-canary',
      OPENAI_API_KEY: 'runtime-model-secret-canary',
    };
    const runtimePrevious = Object.fromEntries(
      Object.keys(runtimeCanaries).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, runtimeCanaries);
    try {
      const result = await execute(fixtureConfig({
        image: process.env.EXECUTOR_DOCKER_IMAGE ?? 'alpine:3.20',
        repo_dir: repo,
        commands: ['env | sort'],
        limits: {...fixtureConfig().limits, wall_clock_seconds_per_command: 60, output_bytes_per_stream: 10_000},
      }), {outDir, now: fixedNow, gitImpl: nullGit});
      const output = await readFile(result.stdoutFile, 'utf8');
      for (const entry of expectedEnvironment) assert.match(output, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
      for (const forbidden of [
        'GITHUB_TOKEN=', 'OPENAI_API_KEY=', 'HTTP_PROXY=', 'HTTPS_PROXY=', 'NO_PROXY=',
        'NODE_VERSION=', 'YARN_VERSION=',
      ]) {
        assert.equal(output.includes(forbidden), false, `${forbidden} reached the foreign shell`);
      }
    } finally {
      for (const [key, value] of Object.entries(runtimePrevious)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test('3 credential discovery: no credential path is mounted into either phase', () => {
  for (const phase of ['phaseA', 'phaseB']) {
    const args = dockerArgs(phase);
    assert.deepEqual(optionValues(args, '--mount'), [
      `type=bind,source=/tmp/northset-executor-fixture/workspace,target=/workspace${phase === 'phaseB' ? ',readonly' : ''}`,
    ]);
    assert.equal(args.includes('--volume'), false);
    assert.equal(args.includes('-v'), false);
    for (const forbidden of ['/.ssh', '/.aws', '/.config', '/credentials', '/secrets']) {
      assert.equal(args.some((value) => value.includes(forbidden)), false);
    }
  }
});

test('4 docker socket: /var/run/docker.sock is never in the mount or argument set', () => {
  for (const phase of ['phaseA', 'phaseB']) {
    const args = dockerArgs(phase);
    assert.equal(args.some((value) => value.includes('/var/run/docker.sock')), false);
  }
});

test('5 host mounts: execution exposes only its disposable workspace and capped tmpfs', async (t) => {
  const repo = await simpleRepo(t);
  const outDir = await temporaryDirectory(t, 'northset-boundary-output-');
  const fake = fakeDocker();
  await execute(fixtureConfig({repo_dir: repo, commands: ['check-one']}), {
    outDir,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  const runs = fake.calls.filter((args) => args[0] === 'run');
  assert.equal(runs.length, 2);
  assert.equal(fake.workspaceDirs.size, 1);
  const [workspace] = fake.workspaceDirs;
  assert.notEqual(workspace, repo);
  assert.equal(workspace.startsWith(`${os.tmpdir()}${path.sep}northset-executor-`), true);
  for (const args of runs) {
    assert.deepEqual(optionValues(args, '--mount').map((mount) => mount.replace(',readonly', '')), [
      `type=bind,source=${workspace},target=/workspace`,
    ]);
    assert.deepEqual(optionValues(args, '--tmpfs'), [
      '/tmp:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=1777',
    ]);
    assert.equal(args.some((value) => value.includes(repo)), false);
  }
  await assert.rejects(access(path.dirname(workspace)), (error) => error.code === 'ENOENT');
});

test('6 outbound HTTP: phase B only; phase A egress isolation is a deployment precondition', () => {
  assert.ok(dockerArgs('phaseB').includes('--network=none'));
  assert.equal(dockerArgs('phaseA').includes('--network=none'), false);
});

test('7 DNS exfiltration: phase B only; phase A DNS isolation is a deployment precondition', () => {
  const args = dockerArgs('phaseB');
  assert.ok(args.includes('--network=none'));
  for (const option of ['--dns', '--dns-search', '--dns-option']) assert.equal(args.includes(option), false);
});

test('8 process explosion: both phases carry the configured bounded PID limit', () => {
  for (const phase of ['phaseA', 'phaseB']) {
    assert.deepEqual(optionValues(dockerArgs(phase), '--pids-limit'), ['32']);
  }
});

test('9 disk exhaustion: tmpfs and workspace caps are configured and a byte breach aborts', async (t) => {
  for (const phase of ['phaseA', 'phaseB']) {
    assert.match(optionValues(dockerArgs(phase), '--tmpfs').at(0), /size=512m/);
  }
  const repo = await simpleRepo(t, {'source.txt': 'x'});
  const outDir = await temporaryDirectory(t, 'northset-boundary-byte-output-');
  const fake = fakeDocker({
    phaseB: async ({workspace}) => {
      await writeFile(path.join(workspace, 'large.bin'), Buffer.alloc(2048));
      await new Promise(() => {});
    },
  });
  await assert.rejects(
    execute(fixtureConfig({
      repo_dir: repo,
      commands: ['write-bytes'],
      workspace_mode: 'writable_copy',
      workspace_write_allowlist: ['large.bin'],
      limits: {...fixtureConfig().limits, workspace_bytes: 1024},
    }), {outDir, now: fixedNow, spawnImpl: fake.spawnImpl, gitImpl: nullGit}),
    /workspace exceeded size cap/,
  );
  assert.equal(phaseBCalls(fake).length, 1);
  assert.ok(fake.calls.some((args) => args[0] === 'kill' && args[1].startsWith('northset-executor-b-')));

  const oversizedRepo = await simpleRepo(t, {'already-large.bin': Buffer.alloc(2048)});
  const preflightOut = await temporaryDirectory(t, 'northset-boundary-byte-preflight-');
  const preflightFake = fakeDocker();
  await assert.rejects(
    execute(fixtureConfig({
      repo_dir: oversizedRepo,
      commands: ['must-not-run'],
      limits: {...fixtureConfig().limits, workspace_bytes: 1024},
    }), {outDir: preflightOut, now: fixedNow, spawnImpl: preflightFake.spawnImpl, gitImpl: nullGit}),
    /workspace exceeded size cap/,
  );
  assert.equal(preflightFake.calls.every((args) => args[0] === 'rm'), true);
});

test('10 file-count exhaustion: writable workspace inode guard aborts a count breach', async (t) => {
  const repo = await simpleRepo(t, {'source.txt': 'x'});
  const outDir = await temporaryDirectory(t, 'northset-boundary-count-output-');
  const fake = fakeDocker({
    phaseB: async ({workspace}) => {
      await mkdir(path.join(workspace, 'coverage'));
      await Promise.all(Array.from({length: 12}, (_, index) => (
        writeFile(path.join(workspace, 'coverage', `${index}.txt`), 'x')
      )));
    },
  });
  await assert.rejects(
    execute(fixtureConfig({
      repo_dir: repo,
      commands: ['write-files'],
      workspace_mode: 'writable_copy',
      workspace_write_allowlist: ['coverage'],
      limits: {...fixtureConfig().limits, workspace_file_count: 10},
    }), {outDir, now: fixedNow, spawnImpl: fake.spawnImpl, gitImpl: nullGit}),
    /workspace exceeded file-count cap/,
  );
  assert.equal(phaseBCalls(fake).length, 1);

  const manyFiles = Object.fromEntries(Array.from({length: 12}, (_, index) => [`file-${index}.txt`, 'x']));
  const crowdedRepo = await simpleRepo(t, manyFiles);
  const preflightOut = await temporaryDirectory(t, 'northset-boundary-count-preflight-');
  const preflightFake = fakeDocker();
  await assert.rejects(
    execute(fixtureConfig({
      repo_dir: crowdedRepo,
      commands: ['must-not-run'],
      limits: {...fixtureConfig().limits, workspace_file_count: 10},
    }), {outDir: preflightOut, now: fixedNow, spawnImpl: preflightFake.spawnImpl, gitImpl: nullGit}),
    /workspace exceeded file-count cap/,
  );
  assert.equal(preflightFake.calls.every((args) => args[0] === 'rm'), true);
});

test('11 output flooding: stdout and stderr are independently byte-bounded with a marker', async (t) => {
  const repo = await simpleRepo(t);
  const outDir = await temporaryDirectory(t, 'northset-boundary-output-cap-');
  const fake = fakeDocker({responses: {
    flood: {stdout: 'abcdefgh', stderr: '12345678'},
  }});
  const result = await execute(fixtureConfig({
    repo_dir: repo,
    commands: ['flood'],
    limits: {...fixtureConfig().limits, output_bytes_per_stream: 5},
  }), {outDir, now: fixedNow, spawnImpl: fake.spawnImpl, gitImpl: nullGit});

  assert.equal(await readFile(result.stdoutFile, 'utf8'), '=== cmd 1: flood ===\nabcde\n[TRUNCATED]\n');
  assert.equal(await readFile(result.stderrFile, 'utf8'), '=== cmd 1: flood ===\n12345\n[TRUNCATED]\n');
});

test('12 symlink escape: an approved patch cannot traverse a source symlink', async (t) => {
  const repo = await temporaryDirectory(t, 'northset-boundary-symlink-repo-');
  const external = await temporaryDirectory(t, 'northset-boundary-symlink-target-');
  const patchDir = await temporaryDirectory(t, 'northset-boundary-symlink-patch-');
  const outDir = await temporaryDirectory(t, 'northset-boundary-symlink-output-');
  const patchFile = path.join(patchDir, 'change.patch');
  await writeFile(path.join(repo, 'tracked.txt'), 'fixture\n');
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Northset Boundary Test'],
    ['config', 'user.email', 'boundary@northset.ai'],
    ['add', 'tracked.txt'],
    ['commit', '-m', 'fixture'],
  ]) {
    const result = spawnSync('git', ['-C', repo, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
  }
  await symlink(external, path.join(repo, 'link'), 'dir');
  await writeFile(patchFile, [
    'diff --git a/link/owned.txt b/link/owned.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/link/owned.txt',
    '@@ -0,0 +1 @@',
    '+host escape',
    '',
  ].join('\n'));
  const fake = fakeDocker();

  await assert.rejects(
    execute(fixtureConfig({repo_dir: repo, patch_file: patchFile, commands: ['check']}), {
      outDir,
      now: fixedNow,
      spawnImpl: fake.spawnImpl,
    }),
    /symlink/,
  );
  assert.equal(existsSync(path.join(external, 'owned.txt')), false);
  assert.equal(fake.calls.some((args) => args[0] === 'run'), false);
});

test('13 cross-job persistence: every declared command gets a fresh named --rm container', async (t) => {
  const repo = await simpleRepo(t);
  const outDir = await temporaryDirectory(t, 'northset-boundary-container-output-');
  const fake = fakeDocker();
  await execute(fixtureConfig({repo_dir: repo}), {
    outDir,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  const checks = phaseBCalls(fake);
  assert.equal(checks.length, 2);
  assert.equal(new Set(checks.map((args) => optionValues(args, '--name').at(0))).size, 2);
  for (const args of checks) {
    assert.ok(args.includes('--rm'));
    assert.deepEqual(optionValues(args, '--tmpfs'), [
      '/tmp:rw,exec,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=1777',
    ]);
  }
});

test('14 cross-job artifact access: only approved artifacts cross commands or execution jobs', async (t) => {
  const repo = await simpleRepo(t);
  const rejectedOut = await temporaryDirectory(t, 'northset-boundary-rejected-output-');
  let laterCommandReadUnapproved = false;
  const rejected = fakeDocker({
    phaseB: async ({workspace, command}) => {
      if (command === 'produce-unapproved-artifact') {
        await writeFile(path.join(workspace, 'unapproved-artifact.txt'), 'must not cross\n');
      } else {
        laterCommandReadUnapproved = existsSync(path.join(workspace, 'unapproved-artifact.txt'));
      }
    },
  });
  await assert.rejects(
    execute(fixtureConfig({
      repo_dir: repo,
      commands: ['produce-unapproved-artifact', 'consume-and-delete-unapproved-artifact'],
      workspace_mode: 'writable_copy',
      workspace_write_allowlist: [],
    }), {outDir: rejectedOut, now: fixedNow, spawnImpl: rejected.spawnImpl, gitImpl: nullGit}),
    /declared checks created unapproved paths/,
  );
  assert.equal(laterCommandReadUnapproved, false);
  assert.deepEqual(phaseBCalls(rejected).map((args) => args.at(-1)), ['produce-unapproved-artifact']);

  const approvedOut = await temporaryDirectory(t, 'northset-boundary-approved-output-');
  let laterCommandReadApproved = false;
  const approved = fakeDocker({
    phaseB: async ({workspace, command}) => {
      if (command === 'produce-approved-artifact') {
        await writeFile(path.join(workspace, 'approved-artifact.txt'), 'approved to cross\n');
      } else {
        laterCommandReadApproved = existsSync(path.join(workspace, 'approved-artifact.txt'));
      }
    },
  });
  await execute(fixtureConfig({
    repo_dir: repo,
    commands: ['produce-approved-artifact', 'consume-approved-artifact'],
    workspace_mode: 'writable_copy',
    workspace_write_allowlist: ['approved-artifact.txt'],
  }), {
    outDir: approvedOut,
    now: fixedNow,
    spawnImpl: approved.spawnImpl,
    gitImpl: nullGit,
  });
  assert.equal(laterCommandReadApproved, true);

  const freshOut = await temporaryDirectory(t, 'northset-boundary-fresh-output-');
  let artifactReachedFreshJob = null;
  const fresh = fakeDocker({
    phaseB: async ({workspace}) => {
      artifactReachedFreshJob = existsSync(path.join(workspace, 'approved-artifact.txt'));
    },
  });
  await execute(fixtureConfig({repo_dir: repo, commands: ['look-for-prior-artifact']}), {
    outDir: freshOut,
    now: fixedNow,
    spawnImpl: fresh.spawnImpl,
    gitImpl: nullGit,
  });
  const [approvedWorkspace] = approved.workspaceDirs;
  const [freshWorkspace] = fresh.workspaceDirs;
  assert.notEqual(freshWorkspace, approvedWorkspace);
  assert.equal(artifactReachedFreshJob, false);
  assert.match(optionValues(phaseBCalls(fresh).at(0), '--mount').at(0), /,readonly$/);
});

test('archive parsing bypass: executor treats hostile archives as opaque bytes (N/A to host extraction)', async (t) => {
  const source = await readFile(executorSource, 'utf8');
  assert.doesNotMatch(source, /\b(?:tar|tarball|zip|unzip|bsdtar|7z|extract|decompress|gunzip)\b/i);

  const external = await temporaryDirectory(t, 'northset-boundary-archive-target-');
  const sentinel = path.join(external, 'sentinel.txt');
  await writeFile(sentinel, 'untouched\n');
  const archiveBytes = hostileTarBytes(sentinel);
  const repo = await simpleRepo(t, {
    'payload.tar': archiveBytes,
  });
  const outDir = await temporaryDirectory(t, 'northset-boundary-archive-output-');
  let copiedArchive = null;
  const fake = fakeDocker({
    phaseA: async ({workspace}) => {
      copiedArchive = await readFile(path.join(workspace, 'payload.tar'));
    },
  });
  await execute(fixtureConfig({repo_dir: repo, commands: ['inspect-opaque-files']}), {
    outDir,
    now: fixedNow,
    spawnImpl: fake.spawnImpl,
    gitImpl: nullGit,
  });

  assert.equal(await readFile(sentinel, 'utf8'), 'untouched\n');
  assert.deepEqual(copiedArchive, archiveBytes);
  assert.equal(fake.calls.some((args) => ['tar', 'unzip', 'bsdtar'].includes(args[0])), false);
});

test('real Docker gate: phase A cannot connect to 169.254.169.254 metadata', {
  skip: dockerPhaseANetworkSkipReason(),
}, async (t) => {
  const result = await runRuntimePhase(t, 'phaseA', String.raw`
import net from 'node:net';

const socket = net.connect({host: '169.254.169.254', port: 80});
socket.once('connect', () => {
  console.error('metadata endpoint was reachable on 169.254.169.254:80');
  socket.destroy();
  process.exit(42);
});
socket.once('error', () => process.exit(0));
socket.setTimeout(1_500, () => {
  socket.destroy();
  process.exit(0);
});
`);
  assert.equal(result.status, 0, `phase A reached IMDS or the probe failed:\n${dockerFailure(result)}`);
});

test('real Docker gate: phase A reaches only the declared package registry', {
  skip: dockerPhaseANetworkSkipReason(),
}, async (t) => {
  const allowedUrl = process.env.EXECUTOR_PHASE_A_ALLOWED_URL;
  const deniedHost = process.env.EXECUTOR_PHASE_A_DENIED_HOST;
  const result = await runRuntimePhase(t, 'phaseA', String.raw`
import dns from 'node:dns/promises';

const allowedUrl = ${JSON.stringify(allowedUrl)};
const deniedHost = ${JSON.stringify(deniedHost)};
const allowed = await fetch(allowedUrl, {signal: AbortSignal.timeout(5_000)});
if (allowed.status < 200 || allowed.status >= 400) {
  console.error('declared package registry returned', allowed.status);
  process.exit(42);
}

try {
  await dns.lookup(deniedHost);
  console.error('denied phase-A hostname resolved:', deniedHost);
  process.exit(43);
} catch (error) {
  if (!['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) {
    console.error('denied hostname failed for an unexpected reason:', error);
    process.exit(44);
  }
}

try {
  const response = await fetch('https://' + deniedHost + '/', {
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status < 400) {
    console.error('denied phase-A HTTP target returned', response.status);
    process.exit(45);
  }
} catch {
  // A DNS refusal, connection refusal, or policy reset is the expected deployment behavior.
}
`);
  assert.equal(
    result.status,
    0,
    `phase A was not limited to the declared package registry:\n${dockerFailure(result)}`,
  );
});

test('real Docker gate: phase A cannot use the host Docker daemon socket or TCP API', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const configuredHosts = (process.env.EXECUTOR_DOCKER_DAEMON_PROBE_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  const configuredTargets = [
    process.env.DOCKER_HOST?.startsWith('tcp://') ? process.env.DOCKER_HOST : null,
    ...(process.env.EXECUTOR_DOCKER_DAEMON_PROBE_TARGETS ?? '').split(','),
  ].filter(Boolean).map((target) => {
    const url = new URL(target.includes('://') ? target : `tcp://${target}`);
    if (url.protocol !== 'tcp:' || !url.hostname || !url.port) {
      throw new Error(`invalid Docker daemon probe target: ${target}`);
    }
    return {host: url.hostname, port: Number(url.port)};
  });
  const result = await runRuntimePhase(t, 'phaseA', String.raw`
import {existsSync, readFileSync} from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

for (const socketPath of ['/var/run/docker.sock', '/run/docker.sock']) {
  if (existsSync(socketPath)) {
    console.error(socketPath, 'exists inside the phase-A container');
    process.exit(42);
  }
}

function defaultGateway() {
  try {
    const row = readFileSync('/proc/net/route', 'utf8').split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find((fields) => fields[1] === '00000000' && (Number.parseInt(fields[3], 16) & 2) !== 0);
    if (!row || !/^[0-9A-Fa-f]{8}$/.test(row[2])) return null;
    return row[2].match(/../g).reverse().map((byte) => Number.parseInt(byte, 16)).join('.');
  } catch {
    return null;
  }
}

const configuredHosts = ${JSON.stringify(configuredHosts)};
const configuredTargets = ${JSON.stringify(configuredTargets)};
const hosts = [...new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  defaultGateway(),
  ...configuredHosts,
].filter(Boolean))];

function canUseDockerApi(host, port) {
  return new Promise((resolve) => {
    const socket = port === 2376
      ? tls.connect({host, port, rejectUnauthorized: false})
      : net.connect({host, port});
    let response = '';
    const finish = () => {
      socket.destroy();
      resolve(
        /^HTTP\/1\.[01] 200\b/m.test(response)
        && (/\r?\n\r?\nOK\s*$/m.test(response) || /\bApi-Version:/i.test(response)),
      );
    };
    socket.once(port === 2376 ? 'secureConnect' : 'connect', () => {
      socket.write('GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.length > 8_192) finish();
    });
    socket.once('end', finish);
    socket.once('error', () => finish());
    socket.setTimeout(1_500, finish);
  });
}

const probes = [
  ...hosts.flatMap((host) => [2375, 2376].map((port) => ({host, port}))),
  ...configuredTargets,
];
const results = await Promise.all(probes.map(async (probe) => ({
  ...probe,
  dockerApiReachable: await canUseDockerApi(probe.host, probe.port),
})));
const reachable = results.filter((probe) => probe.dockerApiReachable);
if (reachable.length > 0) {
  console.error('Docker TCP API usable:', reachable);
  process.exit(42);
}
`);
  assert.equal(
    result.status,
    0,
    `phase A could use a Docker daemon endpoint or the probe failed:\n${dockerFailure(result)}`,
  );
});

test('real Docker gate: phase B --network=none prevents egress', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const result = await runRuntimePhase(t, 'phaseB', String.raw`
import net from 'node:net';
import os from 'node:os';

const externalInterfaces = Object.values(os.networkInterfaces()).flat()
  .filter((address) => address && !address.internal);
if (externalInterfaces.length > 0) {
  console.error('phase B has a non-loopback network interface:', externalInterfaces);
  process.exit(42);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({host, port});
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

if (await canConnect('1.1.1.1', 443) || await canConnect('169.254.169.254', 80)) {
  console.error('phase B established an outbound connection despite --network=none');
  process.exit(42);
}
`);
  assert.equal(result.status, 0, `phase B egress was available or the probe failed:\n${dockerFailure(result)}`);
});

test('real Docker gate: read-only root filesystem rejects writes at runtime', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const result = await runRuntimePhase(t, 'phaseB', String.raw`
import {writeFileSync} from 'node:fs';

try {
  writeFileSync('/var/tmp/northset-boundary-rootfs-probe', 'must fail');
  console.error('write to the root filesystem unexpectedly succeeded');
  process.exit(42);
} catch (error) {
  if (error.code !== 'EROFS') {
    console.error('root filesystem write failed for the wrong reason:', error.code);
    process.exit(43);
  }
}

try {
  writeFileSync('/northset-boundary-root-probe', 'must fail');
  console.error('write directly under / unexpectedly succeeded');
  process.exit(44);
} catch {
  // Expected: / is not writable to the executor user on a read-only root filesystem.
}
`);
  assert.equal(result.status, 0, `rootfs write protection was not enforced:\n${dockerFailure(result)}`);
});

test('real Docker gate: container runs as uid 1000 gid 1000', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const result = await runRuntimePhase(t, 'phaseB', String.raw`
const identity = [process.getuid(), process.getgid()].join(':');
console.log(identity);
if (identity !== '1000:1000') process.exit(42);
`);
  assert.equal(result.status, 0, `runtime identity was not 1000:1000:\n${dockerFailure(result)}`);
  assert.equal(result.stdout.trim(), '1000:1000');
});

test('real Docker gate: no-new-privileges blocks a working setuid escalation fixture', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const suffix = randomUUID();
  const prepContainer = `northset-boundary-suid-prep-${suffix}`;
  const controlContainer = `northset-boundary-suid-control-${suffix}`;
  const gatedContainer = `northset-boundary-suid-gated-${suffix}`;
  const derivedImage = `northset-boundary-suid:${suffix}`;
  t.after(() => {
    for (const name of [prepContainer, controlContainer, gatedContainer]) {
      spawnSync('docker', ['rm', '-f', name], {encoding: 'utf8', timeout: 5_000});
    }
    spawnSync('docker', ['image', 'rm', '-f', derivedImage], {encoding: 'utf8', timeout: 10_000});
  });

  const prepared = spawnSync('docker', [
    'run', '--name', prepContainer, '--network=none', '--memory', '64m', '--cpus', '1',
    '--pids-limit', '32', dockerTestImage, '/bin/sh', '-c',
    'cp /usr/bin/id /suid-id && chown 0:0 /suid-id && chmod 4755 /suid-id',
  ], {encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024});
  assert.equal(prepared.status, 0, `could not prepare setuid fixture:\n${dockerFailure(prepared)}`);
  const committed = spawnSync('docker', ['commit', prepContainer, derivedImage], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });
  assert.equal(committed.status, 0, `could not commit setuid fixture image:\n${dockerFailure(committed)}`);

  const workspace = await temporaryDirectory(t, 'northset-boundary-suid-runtime-');
  await chmod(workspace, 0o755);
  const config = validateExecutorConfig(fixtureConfig({image: derivedImage, repo_dir: workspace}));
  const argsFor = (containerName) => buildDockerArgs('phaseB', config, {
    workspaceDir: workspace,
    containerName,
    command: '/suid-id -u',
    image: derivedImage,
  });

  // The control proves the fixture really elevates. Only this local control argv removes NNP;
  // the executor-generated gated argv remains unchanged and is the assertion target.
  const controlArgs = argsFor(controlContainer);
  const securityIndex = controlArgs.indexOf('--security-opt');
  assert.notEqual(securityIndex, -1);
  controlArgs.splice(securityIndex, 2);
  const control = spawnSync('docker', controlArgs, {encoding: 'utf8', timeout: 15_000});
  assert.equal(control.status, 0, `setuid control failed:\n${dockerFailure(control)}`);
  assert.equal(control.stdout.trim(), '0', 'setuid fixture did not elevate without NNP');

  const gated = spawnSync('docker', argsFor(gatedContainer), {encoding: 'utf8', timeout: 15_000});
  assert.equal(gated.status, 0, `NNP setuid probe failed:\n${dockerFailure(gated)}`);
  assert.equal(gated.stdout.trim(), '1000', 'setuid changed effective uid despite no-new-privileges');
});

test('real Docker gate: --pids-limit caps a bounded process burst', {
  skip: dockerTestSkipReason(),
}, async (t) => {
  const result = await runRuntimePhase(t, 'phaseB', String.raw`
import {spawn} from 'node:child_process';

const children = [];
function startChild() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('/bin/sleep', ['10'], {stdio: 'ignore'});
    } catch (error) {
      resolve({error});
      return;
    }
    child.once('spawn', () => resolve({child}));
    child.once('error', (error) => resolve({error}));
  });
}

for (let index = 0; index < 48; index += 1) {
  const attempt = await startChild();
  if (attempt.error) {
    for (const child of children) child.kill('SIGKILL');
    if (attempt.error.code !== 'EAGAIN') {
      console.error('child spawn failed for a reason other than the PID cgroup:', attempt.error);
      process.exit(43);
    }
    console.log('pids capped after', children.length, 'children:', attempt.error.code);
    process.exit(0);
  }
  children.push(attempt.child);
}

for (const child of children) child.kill('SIGKILL');
console.error('all 48 children started; --pids-limit was not enforced');
process.exit(42);
`, {limits: {pids: 32}});
  assert.equal(result.status, 0, `PID cgroup limit was not enforced:\n${dockerFailure(result)}`);
  assert.match(result.stdout, /pids capped after \d+ children:/);
});
