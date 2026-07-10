import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PipelineError, runPipeline } from '../lib/pipeline.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'test/fixtures/pipeline');
const rehearsalExample = path.join(root, 'examples/M-001_own_repo_rehearsal.json');
const verificationExample = path.join(root, 'examples/M-004_verification_give.json');
const bundleCli = path.join(root, 'bin/bundle.mjs');
const pipelineCli = path.join(root, 'bin/run-mission.mjs');
const fixedNow = '2026-07-09T12:00:00Z';

async function temporaryDirectory(t, prefix = 'northset-pipeline-test-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function example(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

function missionInput(mission, overrides = {}) {
  return {
    mission,
    repo_dir: root,
    patch_file: null,
    consent_file: null,
    issue_snapshot_file: null,
    ci_links_file: null,
    executor: {
      image: 'node:20-bookworm',
      install_commands: [],
      commands: ['node --test'],
      limits: {
        cpus: 1,
        memory_mb: 1024,
        pids: 128,
        wall_clock_seconds_per_command: 60,
        output_bytes_per_stream: 1_000_000,
      },
    },
    ...overrides,
  };
}

function fakeExecutor(counter = { calls: 0 }, { failure = null, patchFile = null } = {}) {
  return async (config, { outDir, now }) => {
    counter.calls += 1;
    assert.equal(config.repo_dir, root);
    assert.equal(config.patch_file, patchFile);
    assert.equal(now, fixedNow);
    if (failure !== null) throw failure;
    await Promise.all([
      cp(path.join(fixtures, 'run_record.json'), path.join(outDir, 'run_record.json')),
      cp(path.join(fixtures, 'stdout.txt'), path.join(outDir, 'stdout.txt')),
      cp(path.join(fixtures, 'stderr.txt'), path.join(outDir, 'stderr.txt')),
    ]);
  };
}

async function assertMissing(file) {
  await assert.rejects(access(file), (error) => error.code === 'ENOENT');
}

// Consent-gate tests intentionally come first: they prove hostile work cannot reach executeImpl.
test('V mission without consent_file fails closed before executor and writes no mission', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(verificationExample));

  await assert.rejects(
    runPipeline(input, { missionsDir, now: fixedNow, executeImpl: fakeExecutor(counter) }),
    (error) => (
      error instanceof PipelineError &&
      error.errors.some((item) => item.ruleId === 'CONSENT_FILE_REQUIRED')
    ),
  );
  assert.equal(counter.calls, 0);
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
});

test('invalid mission fails validation before executor', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const invalidMission = { ...(await example(rehearsalExample)), unexpected: true };

  await assert.rejects(
    runPipeline(missionInput(invalidMission), {
      missionsDir,
      now: fixedNow,
      executeImpl: fakeExecutor(counter),
    }),
    (error) => (
      error instanceof PipelineError &&
      error.message === 'mission receipt invalid' &&
      error.errors.some((item) => item.ruleId === 'STRUCTURE_ADDITIONAL_PROPERTY')
    ),
  );
  assert.equal(counter.calls, 0);
  await assertMissing(path.join(missionsDir, invalidMission.mission_id));
});

test('own_repo_rehearsal with the required label proceeds without consent', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const result = await runPipeline(missionInput(await example(rehearsalExample)), {
    missionsDir,
    now: fixedNow,
    executeImpl: fakeExecutor(counter),
  });

  assert.equal(counter.calls, 1);
  assert.equal(result.missionDir, path.join(missionsDir, 'M-001'));
});

test('happy path creates a real verifiable bundle and refreshes the ledger', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const input = missionInput(await example(rehearsalExample), {
    patch_file: path.join(fixtures, 'change.patch'),
    issue_snapshot_file: path.join(fixtures, 'issue_snapshot.json'),
    ci_links_file: path.join(fixtures, 'ci_links.json'),
  });
  const result = await runPipeline(input, {
    missionsDir,
    now: fixedNow,
    executeImpl: fakeExecutor(undefined, { patchFile: input.patch_file }),
  });

  assert.equal(result.attestationPending, true);
  const manifest = JSON.parse(await readFile(
    path.join(result.missionDir, 'bundle/bundle.manifest.json'),
    'utf8',
  ));
  assert.equal(result.bundleDigest, manifest.bundle_digest);
  const index = JSON.parse(await readFile(path.join(missionsDir, 'index.json'), 'utf8'));
  assert.equal(result.ledgerIncluded, 1);
  assert.deepEqual(index.missions.map((mission) => mission.mission_id), ['M-001']);
  assert.deepEqual(
    await readFile(path.join(result.missionDir, 'patch.diff')),
    await readFile(input.patch_file),
  );

  const verification = spawnSync(process.execPath, [bundleCli, 'verify', result.missionDir], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(verification.stdout, `OK ${result.bundleDigest}\n`);
});

test('W mission with consent proceeds and copies consent verbatim', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const mission = { ...(await example(verificationExample)), mission_id: 'M-005', variant: 'W' };
  const consentFile = path.join(fixtures, 'consent.md');
  const input = missionInput(mission, { consent_file: consentFile });
  const result = await runPipeline(input, {
    missionsDir,
    now: fixedNow,
    executeImpl: fakeExecutor(),
  });

  assert.deepEqual(
    await readFile(path.join(result.missionDir, 'consent.md')),
    await readFile(consentFile),
  );
});

test('executor failure removes the partial mission directory', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const input = missionInput(await example(rehearsalExample));

  await assert.rejects(
    runPipeline(input, {
      missionsDir,
      now: fixedNow,
      executeImpl: fakeExecutor({ calls: 0 }, { failure: new Error('fake executor failed') }),
    }),
    /fake executor failed/,
  );
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
});

test('ledger failure restores a mission replaced with --force', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const missionDir = path.join(missionsDir, 'M-001');
  await cp(path.join(root, 'test/fixtures/executor/mission'), missionDir, { recursive: true });
  await writeFile(path.join(missionDir, 'original-marker.txt'), 'original mission\n');

  await assert.rejects(
    runPipeline(missionInput(await example(rehearsalExample)), {
      missionsDir,
      now: fixedNow,
      force: true,
      executeImpl: fakeExecutor(),
      ledgerImpl: async () => {
        throw new Error('fake ledger failed');
      },
    }),
    /fake ledger failed/,
  );

  assert.equal(await readFile(path.join(missionDir, 'original-marker.txt'), 'utf8'), 'original mission\n');
  await assertMissing(path.join(missionDir, 'bundle'));
});

test('same input and --now write identical mission.json bytes', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const firstMissions = path.join(temporaryRoot, 'first');
  const secondMissions = path.join(temporaryRoot, 'second');
  const input = missionInput(await example(rehearsalExample));
  const first = await runPipeline(input, {
    missionsDir: firstMissions,
    now: fixedNow,
    executeImpl: fakeExecutor(),
  });
  const second = await runPipeline(input, {
    missionsDir: secondMissions,
    now: fixedNow,
    executeImpl: fakeExecutor(),
  });

  assert.deepEqual(
    await readFile(path.join(first.missionDir, 'mission.json')),
    await readFile(path.join(second.missionDir, 'mission.json')),
  );
});

test('CLI gate failure exits one with the rule and leaves no mission directory', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const inputFile = path.join(temporaryRoot, 'mission-input.json');
  const input = missionInput(await example(verificationExample));
  await writeFile(inputFile, `${JSON.stringify(input, null, 2)}\n`);

  const result = spawnSync(process.execPath, [
    pipelineCli,
    inputFile,
    '--missions-dir',
    missionsDir,
    '--now',
    fixedNow,
  ], { cwd: root, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /CONSENT_FILE_REQUIRED/);
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
});

test('mission input rejects unknown top-level keys before execution', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const counter = { calls: 0 };
  const input = { ...missionInput(await example(rehearsalExample)), unexpected: true };
  await assert.rejects(
    runPipeline(input, {
      missionsDir: path.join(temporaryRoot, 'missions'),
      now: fixedNow,
      executeImpl: fakeExecutor(counter),
    }),
    (error) => error.errors.some((item) => item.path === '$.unexpected'),
  );
  assert.equal(counter.calls, 0);
});
