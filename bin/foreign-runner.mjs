#!/usr/bin/env node

import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const IMAGE = 'node@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5';
const REGISTRY = 'registry.npmjs.org';
const DOCKER_PULL_HOSTS = [
  'auth.docker.io',
  'registry-1.docker.io',
  'production.cloudflare.docker.com',
  'production.cloudfront.docker.com',
];
const CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

class RunnerError extends Error {}

function usage() {
  return `usage:
  foreign-runner.mjs gate [--json]
  foreign-runner.mjs run <executor-config.json> --source-commit <40-hex> --out <empty-dir> [--json]

The host must have sbx >= 0.35.0, an initialized deny-all sandbox policy, no sbx secrets,
and the production Node image must remain pinned to ${IMAGE}.`;
}

function fail(message) {
  throw new RunnerError(message);
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
    env: options.env ?? process.env,
  });
  if (result.error) fail(`${binary} failed to start: ${result.error.message}`);
  if (!options.allowFailure && result.status !== 0) {
    fail(`${binary} ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function guest(sandbox, script, options = {}) {
  return command('sbx', [
    'exec',
    ...(options.workdir ? ['-w', options.workdir] : []),
    sandbox,
    'env', '-i', `PATH=${CLEAN_PATH}`, 'HOME=/home/agent',
    ...(options.environment ?? []),
    'sh', '-lc', script,
  ], options);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function parseArguments(argv) {
  const args = [...argv];
  const mode = args.shift();
  if (!['gate', 'run'].includes(mode)) fail(usage());
  const result = {mode, json: false};
  if (mode === 'run') {
    result.configFile = args.shift();
    if (!result.configFile || result.configFile.startsWith('--')) fail(usage());
  }
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--json') {
      result.json = true;
      continue;
    }
    if (!['--source-commit', '--out'].includes(flag) || mode !== 'run') fail(usage());
    const key = flag === '--source-commit' ? 'sourceCommit' : 'outDir';
    if (result[key] !== undefined) fail(`duplicate ${flag}`);
    result[key] = args.shift();
    if (!result[key] || result[key].startsWith('--')) fail(`${flag} requires a value`);
  }
  if (mode === 'run' && (!result.sourceCommit || !result.outDir)) fail(usage());
  return result;
}

function sandboxList() {
  return JSON.parse(command('sbx', ['ls', '--json']).stdout).sandboxes ?? [];
}

function checkDenied(sandbox, target) {
  const result = command('sbx', ['policy', 'check', 'network', '--sandbox', sandbox, target], {
    allowFailure: true,
  });
  if (!/^Denied:/m.test(result.stdout)) fail(`sandbox policy unexpectedly allows ${target}`);
  return result.stdout.trim().split('\n')[0];
}

function checkAllowed(sandbox, target) {
  const result = command('sbx', ['policy', 'check', 'network', '--sandbox', sandbox, target]);
  if (!/^Allowed:/m.test(result.stdout)) fail(`sandbox policy unexpectedly denies ${target}`);
  return result.stdout.trim().split('\n')[0];
}

function assertHostPreconditions() {
  const version = command('sbx', ['version']).stdout.trim();
  const match = /v(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match || Number(match[1]) !== 0 || Number(match[2]) < 35) {
    fail(`sbx >= 0.35.0 is required; found ${version}`);
  }
  const secrets = command('sbx', ['secret', 'ls']).stdout;
  if (!/No secrets found/.test(secrets)) fail('sbx secret store must be empty');
  const globalCheck = command('sbx', ['policy', 'check', 'network', 'example.com'], {
    allowFailure: true,
  });
  if (!/^Denied:/m.test(globalCheck.stdout)) fail('global sbx network policy must be initialized deny-all');
  return {sbx_version: version, secret_inventory: 'empty', global_policy: 'deny-all'};
}

function createSandbox(sandbox, sourceDirectory) {
  const workspaces = sourceDirectory === ROOT ? [] : [`${sourceDirectory}:ro`];
  command('sbx', [
    'create', '--clone', '--cpus', '4', '--memory', '6g', '--name', sandbox,
    'shell', ROOT, ...workspaces,
  ], {
    timeout: 300_000,
    env: {
      ...process.env,
      DOCKER_SANDBOXES_ROOT_SIZE: '6g',
      DOCKER_SANDBOXES_DOCKER_SIZE: '6g',
    },
  });
  const record = sandboxList().find((item) => item.name === sandbox);
  if (!record || record.status !== 'running') fail('sandbox was not created in running state');
  return record;
}

function configureNetwork(sandbox) {
  command('sbx', ['policy', 'deny', 'network', '--sandbox', sandbox, 'openrouter.ai']);
  command('sbx', [
    'policy', 'allow', 'network', '--sandbox', sandbox, DOCKER_PULL_HOSTS.join(','),
  ]);
  guest(sandbox, `docker pull ${shellQuote(IMAGE)}`, {timeout: 300_000});
  for (const host of DOCKER_PULL_HOSTS) {
    command('sbx', ['policy', 'rm', 'network', '--sandbox', sandbox, '--resource', host]);
  }
  command('sbx', ['policy', 'allow', 'network', '--sandbox', sandbox, REGISTRY]);
  const checks = {
    allowed_registry: checkAllowed(sandbox, REGISTRY),
    denied_github: checkDenied(sandbox, 'github.com'),
    denied_openrouter: checkDenied(sandbox, 'openrouter.ai'),
    denied_metadata: checkDenied(sandbox, '169.254.169.254'),
    denied_private: checkDenied(sandbox, '192.168.0.1'),
    denied_docker_pull_cdn: checkDenied(sandbox, 'production.cloudfront.docker.com'),
  };
  return checks;
}

function setupQuota(sandbox, volume, keeper) {
  const mountpoint = `/var/lib/docker/volumes/${volume}/_data`;
  guest(sandbox, [
    `docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1073741824,nr_inodes=32768,mode=1777 ${shellQuote(volume)} >/dev/null`,
    `docker run -d --name ${shellQuote(keeper)} --network=none --read-only --cap-drop=ALL --security-opt no-new-privileges --pids-limit 16 --memory 32m --cpus .25 --mount type=volume,source=${shellQuote(volume)},target=/workspace ${shellQuote(IMAGE)} sleep 86400 >/dev/null`,
    `sudo chmod 0711 /var/lib/docker /var/lib/docker/volumes /var/lib/docker/volumes/${shellQuote(volume)}`,
    `test -w ${shellQuote(mountpoint)}`,
  ].join('\n'));
  const probe = guest(sandbox, String.raw`
set -eu
mountpoint=$MOUNTPOINT
findmnt -no TARGET,SOURCE,FSTYPE,OPTIONS "$mountpoint"
df -B1 "$mountpoint" | tail -1
df -i "$mountpoint" | tail -1
set +e
byte_output=$(fallocate -l 1073741825 "$mountpoint/over-byte" 2>&1)
byte_status=$?
set -e
rm -f "$mountpoint/over-byte"
test "$byte_status" -ne 0
printf 'byte_probe_status=%s byte_probe=%s\n' "$byte_status" "$byte_output"
mkdir "$mountpoint/inode-probe"
MOUNTPOINT="$mountpoint" node --input-type=module -e '
  import {openSync, closeSync} from "node:fs";
  const dir = process.env.MOUNTPOINT + "/inode-probe";
  let count = 0;
  try {
    for (; count < 40000; count += 1) closeSync(openSync(dir + "/" + count, "w"));
    process.exit(42);
  } catch (error) {
    console.log("inode_probe_count=" + count + " inode_probe_code=" + error.code);
    if (error.code !== "ENOSPC") process.exit(43);
  }
'
rm -rf "$mountpoint/inode-probe"
`, {environment: [`MOUNTPOINT=${mountpoint}`]});
  // The script takes the mountpoint from the clean environment rather than positional shell state.
  if (!/No space left on device/.test(probe.stdout) || !/inode_probe_code=ENOSPC/.test(probe.stdout)) {
    fail('kernel byte/inode quota rejection probe did not pass');
  }
  return {mountpoint, evidence: probe.stdout.trim()};
}

function prepareIntake(sandbox, sourceDirectory, sourceCommit) {
  const intake = '/var/lib/northset-intake/repo';
  const result = guest(sandbox, String.raw`
set -eu
source_dir=$SOURCE_DIR
source_commit=$SOURCE_COMMIT
sudo rm -rf /var/lib/northset-intake
sudo mkdir -p /var/lib/northset-intake
sudo env -i PATH="$PATH" HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 git \
  -c core.hooksPath=/dev/null clone --no-local --no-hardlinks --no-checkout \
  "$source_dir" /var/lib/northset-intake/repo >/dev/null
sudo env -i PATH="$PATH" HOME=/var/empty GIT_CONFIG_NOSYSTEM=1 git \
  -C /var/lib/northset-intake/repo -c core.hooksPath=/dev/null checkout --detach "$source_commit" >/dev/null
actual=$(sudo git -C /var/lib/northset-intake/repo rev-parse HEAD)
test "$actual" = "$source_commit"
test -z "$(sudo git -C /var/lib/northset-intake/repo status --porcelain --untracked-files=all)"
tree=$(sudo git -C /var/lib/northset-intake/repo rev-parse HEAD^{tree})
sudo chown -R root:root /var/lib/northset-intake/repo
sudo chmod -R a-w /var/lib/northset-intake/repo
if touch /var/lib/northset-intake/repo/.writer-probe 2>/dev/null; then
  echo 'agent could write immutable intake' >&2
  exit 42
fi
printf 'commit=%s tree=%s agent_write=denied\n' "$actual" "$tree"
`, {environment: [`SOURCE_DIR=${sourceDirectory}`, `SOURCE_COMMIT=${sourceCommit}`]});
  if (!/agent_write=denied/.test(result.stdout)) fail('quiescent intake probe did not pass');
  return {path: intake, evidence: result.stdout.trim()};
}

function runBattery(sandbox, mountpoint) {
  const result = guest(sandbox, [
    'node --test',
    'test/sacrificial-boundary.acceptance.test.mjs',
    'test/executor.test.mjs',
  ].join(' '), {
    workdir: ROOT,
    timeout: 180_000,
    environment: [
      `TMPDIR=${mountpoint}`,
      'EXECUTOR_DOCKER_TEST=1',
      `EXECUTOR_DOCKER_IMAGE=${IMAGE}`,
      'EXECUTOR_DOCKER_DAEMON_PROBE_HOSTS=host.docker.internal,gateway.docker.internal,172.17.0.1',
      'EXECUTOR_PHASE_A_ALLOWED_URL=https://registry.npmjs.org/-/ping',
      'EXECUTOR_PHASE_A_DENIED_HOST=example.com',
    ],
  });
  const summary = result.stdout.split('\n').filter((line) => /^# (tests|pass|fail|skipped) /.test(line));
  if (!summary.includes('# fail 0') || !summary.includes('# skipped 0')) {
    fail('production Docker battery did not finish with zero failures and zero skips');
  }
  return summary;
}

function finalReview(sandbox, mountpoint, sourceCommit) {
  const policy = configureFinalPolicyEvidence(sandbox);
  const runtime = guest(sandbox, [
    `test "$(git -C /var/lib/northset-intake/repo rev-parse HEAD)" = ${shellQuote(sourceCommit)}`,
    `findmnt -no FSTYPE,OPTIONS ${shellQuote(mountpoint)}`,
    `docker image inspect ${shellQuote(IMAGE)} --format 'id={{.Id}} os={{.Os}} arch={{.Architecture}}'`,
    "docker info --format 'server={{.ServerVersion}} cgroup={{.CgroupVersion}} security={{json .SecurityOptions}}'",
  ].join('\n'));
  return {policy, runtime: runtime.stdout.trim()};
}

function configureFinalPolicyEvidence(sandbox) {
  return {
    registry: checkAllowed(sandbox, REGISTRY),
    github: checkDenied(sandbox, 'github.com'),
    openrouter: checkDenied(sandbox, 'openrouter.ai'),
    metadata: checkDenied(sandbox, '169.254.169.254'),
    lan: checkDenied(sandbox, '192.168.5.1'),
  };
}

function runReaperProbe(sandbox, mountpoint) {
  const started = Date.now();
  const killed = guest(sandbox, [
    `mkdir -p ${shellQuote(path.join(mountpoint, 'northset-executor-reaper-probe'))}`,
    `docker run -d --name northset-executor-a-reaper-probe --network=none ${shellQuote(IMAGE)} sleep 86400 >/dev/null`,
    'kill -KILL $$',
  ].join('\n'), {allowFailure: true});
  if (killed.status === 0) fail('reaper probe child was not killed');
  const identified = guest(sandbox, [
    "docker ps --format '{{.Names}}' --filter name=^northset-executor-a-reaper-probe$",
    `find ${shellQuote(mountpoint)} -maxdepth 1 -type d -name northset-executor-reaper-probe -print`,
  ].join('\n')).stdout.trim();
  if (!identified.includes('northset-executor-a-reaper-probe')
      || !identified.includes('northset-executor-reaper-probe')) {
    fail('external reaper could not identify sacrificial leftovers');
  }
  return {identified, started};
}

async function prepareRunInput(sandbox, config, sourceCommit, temporaryDirectory) {
  const adjusted = {
    ...config,
    repo_dir: '/var/lib/northset-intake/repo',
    patch_file: config.patch_file === null ? null : '/var/lib/northset-intake/approved.patch',
  };
  if (config.patch_file !== null) {
    command('sbx', ['cp', config.patch_file, `${sandbox}:/var/lib/northset-intake/approved.patch`]);
    guest(sandbox, 'sudo chown root:root /var/lib/northset-intake/approved.patch && sudo chmod 0444 /var/lib/northset-intake/approved.patch');
  }
  const localConfig = path.join(temporaryDirectory, 'executor-config.json');
  await writeFile(localConfig, `${JSON.stringify(adjusted, null, 2)}\n`, {mode: 0o600});
  command('sbx', ['cp', localConfig, `${sandbox}:/var/lib/northset-intake/executor-config.json`]);
  guest(sandbox, 'sudo chown root:root /var/lib/northset-intake/executor-config.json && sudo chmod 0444 /var/lib/northset-intake/executor-config.json');
  return sourceCommit;
}

async function executeCandidate(sandbox, mountpoint, outputDirectory) {
  const guestOutput = path.join(mountpoint, 'output');
  const result = guest(sandbox, [
    'node bin/execute.mjs run /var/lib/northset-intake/executor-config.json',
    `--out ${shellQuote(guestOutput)} --json`,
  ].join(' '), {
    workdir: ROOT,
    timeout: 3_600_000,
    environment: [`TMPDIR=${mountpoint}`],
  });
  guest(sandbox, [
    `test "$(find ${shellQuote(guestOutput)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\n' | sort | paste -sd, -)" = run_record.json,stderr.txt,stdout.txt`,
    `test -z "$(find -P ${shellQuote(guestOutput)} -mindepth 1 -maxdepth 1 ! -type f -print)"`,
  ].join('\n'));
  await mkdir(outputDirectory, {recursive: true});
  if ((await readdir(outputDirectory)).length !== 0) fail('--out directory must be empty');
  for (const name of ['run_record.json', 'stdout.txt', 'stderr.txt']) {
    command('sbx', ['cp', `${sandbox}:${path.join(guestOutput, name)}`, path.join(outputDirectory, name)]);
  }
  return JSON.parse(result.stdout);
}

async function loadRunConfig(parsed) {
  if (!/^[0-9a-f]{40}$/.test(parsed.sourceCommit)) fail('--source-commit must be 40 lowercase hex characters');
  const configFile = path.resolve(parsed.configFile);
  let config;
  try {
    config = JSON.parse(await readFile(configFile, 'utf8'));
  } catch (error) {
    fail(`cannot read executor config: ${error.message}`);
  }
  if (config.profile !== 'node') fail('foreign production runner currently permits only the node profile');
  if (config.image !== IMAGE) fail(`executor image must be exactly ${IMAGE}`);
  if (config.workspace_mode !== undefined && config.workspace_mode !== 'readonly') {
    fail('foreign production runner requires readonly workspace_mode');
  }
  if (!path.isAbsolute(config.repo_dir)) fail('config repo_dir must be absolute');
  const source = await lstat(config.repo_dir).catch(() => null);
  if (!source?.isDirectory() || source.isSymbolicLink()) fail('config repo_dir must be a real directory');
  if (config.patch_file !== null && !path.isAbsolute(config.patch_file)) fail('config patch_file must be absolute or null');
  return {config, sourceDirectory: config.repo_dir, sourceCommit: parsed.sourceCommit};
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'northset-foreign-runner-'));
  const sandbox = `northset-foreign-${randomUUID().toLowerCase()}`;
  const volume = `${sandbox}-workspace`;
  const keeper = `${sandbox}-quota-keeper`;
  let reaperProbe = null;
  let removedAt = null;
  const evidence = {mode: parsed.mode, decision: 'NO-GO'};
  try {
    evidence.host = assertHostPreconditions();
    const run = parsed.mode === 'run'
      ? await loadRunConfig(parsed)
      : {
        config: null,
        sourceDirectory: ROOT,
        sourceCommit: command('git', ['-C', ROOT, 'rev-parse', 'HEAD']).stdout.trim(),
      };
    const record = createSandbox(sandbox, run.sourceDirectory);
    evidence.runner = {name: sandbox, id: record.id, isolation: 'disposable-microvm'};
    evidence.network = configureNetwork(sandbox);
    const quota = setupQuota(sandbox, volume, keeper);
    evidence.quota = quota.evidence;
    evidence.intake = prepareIntake(sandbox, run.sourceDirectory, run.sourceCommit).evidence;
    evidence.battery = runBattery(sandbox, quota.mountpoint);
    evidence.final_review = finalReview(sandbox, quota.mountpoint, run.sourceCommit);
    if (parsed.mode === 'run') {
      await prepareRunInput(sandbox, run.config, run.sourceCommit, temporaryDirectory);
      evidence.execution = await executeCandidate(sandbox, quota.mountpoint, path.resolve(parsed.outDir));
      evidence.decision = 'GO_AND_EXECUTED';
    } else {
      reaperProbe = runReaperProbe(sandbox, quota.mountpoint);
      evidence.decision = 'INFRASTRUCTURE_GO';
    }
  } finally {
    const removalStart = Date.now();
    command('sbx', ['rm', '--force', sandbox], {allowFailure: true, timeout: 180_000});
    removedAt = Date.now();
    const stillPresent = sandboxList().some((item) => item.name === sandbox);
    if (stillPresent) evidence.decision = 'NO-GO';
    evidence.external_reaper = {
      child_sigkill_probe: reaperProbe?.identified ?? 'not repeated during candidate execution',
      sandbox_removed: !stillPresent,
      cleanup_latency_ms: removedAt - (reaperProbe?.started ?? removalStart),
    };
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
  if (!evidence.external_reaper.sandbox_removed) fail('external reaper failed to remove the microVM');
  process.stdout.write(`${JSON.stringify(evidence, null, parsed.json ? 2 : 2)}\n`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof RunnerError ? error.message : error.stack}\n`);
  process.exitCode = 1;
}
