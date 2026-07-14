import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
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
  const { mission: missionOverrides = {}, ...rest } = overrides;
  return {
    // Illustrative missions declare no commit/patch by default; the code-binding assertion is
    // exercised by dedicated tests that set base_commit + a matching fake source_commit.
    mission: { ...mission, base_commit: null, patch_diff_hash: null, ...missionOverrides },
    repo_dir: root,
    patch_file: null,
    consent_file: null,
    issue_snapshot_file: null,
    ci_links_file: null,
    executor: {
      image: 'node:20-bookworm',
      install_commands: [],
      commands: [...mission.commands_declared],
      limits: {
        cpus: 1,
        memory_mb: 1024,
        pids: 128,
        wall_clock_seconds_per_command: 60,
        output_bytes_per_stream: 1_000_000,
      },
    },
    ...rest,
  };
}

function fakeExecutor(
  counter = { calls: 0 },
  { failure = null, patchFile = null, executedCommands = null, sourceCommit = null, patchSha256 = null } = {},
) {
  return async (config, { outDir, now }) => {
    counter.calls += 1;
    assert.equal(config.repo_dir, root);
    assert.equal(config.patch_file, patchFile);
    assert.equal(now, fixedNow);
    if (failure !== null) throw failure;
    const runRecordFile = path.join(outDir, 'run_record.json');
    const stdoutFile = path.join(outDir, 'stdout.txt');
    const stderrFile = path.join(outDir, 'stderr.txt');
    const runRecord = JSON.parse(await readFile(path.join(fixtures, 'run_record.json'), 'utf8'));
    runRecord.environment = {
      ...runRecord.environment,
      container_image_ref: config.image,
      source_commit: sourceCommit,
      patch_sha256: patchSha256,
    };
    runRecord.commands = (executedCommands ?? config.commands).map((cmd) => ({
      cmd,
      exit_code: 0,
      duration_ms: 25,
    }));
    await Promise.all([
      writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`),
      cp(path.join(fixtures, 'stdout.txt'), stdoutFile),
      cp(path.join(fixtures, 'stderr.txt'), stderrFile),
    ]);
    return { runRecord, runRecordFile, stdoutFile, stderrFile };
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

test('declared command mismatch fails before executor and writes no mission', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(rehearsalExample));
  input.executor = { ...input.executor, commands: ['npm test'] };

  await assert.rejects(
    runPipeline(input, {
      missionsDir,
      now: fixedNow,
      executeImpl: fakeExecutor(counter),
    }),
    (error) => (
      error instanceof PipelineError &&
      error.message === 'mission commands_declared must equal executor.commands' &&
      error.errors.some((item) => item.ruleId === 'COMMANDS_MISMATCH')
    ),
  );
  assert.equal(counter.calls, 0);
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
});

test('a fresh execution rejects a pre-existing attestation before executor', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(rehearsalExample), {
    mission: {
      attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-001/run-record-M-001.tar.gz',
    },
  });

  await assert.rejects(
    runPipeline(input, { missionsDir, now: fixedNow, executeImpl: fakeExecutor(counter) }),
    (error) => error instanceof PipelineError && error.errors.some((item) => item.ruleId === 'STALE_ATTESTATION'),
  );
  assert.equal(counter.calls, 0);
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
});

test('a fresh execution accepts a schema-valid mission with no attestation key', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(rehearsalExample));
  delete input.mission.attestation_uri;

  await runPipeline(input, {
    missionsDir,
    now: fixedNow,
    executeImpl: fakeExecutor(counter),
  });

  assert.equal(counter.calls, 1);
  const writtenMission = JSON.parse(await readFile(
    path.join(missionsDir, input.mission.mission_id, 'mission.json'),
    'utf8',
  ));
  assert.equal(writtenMission.attestation_uri, null);
});

test('a non-object mission fails with a structured pipeline error before executor', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(rehearsalExample));
  input.mission = null;

  await assert.rejects(
    runPipeline(input, { missionsDir, now: fixedNow, executeImpl: fakeExecutor(counter) }),
    (error) => (
      error instanceof PipelineError &&
      error.message === 'mission receipt invalid' &&
      error.errors.some((item) => item.path === '$')
    ),
  );
  assert.equal(counter.calls, 0);
});

test('executed command mismatch fails after executor and publishes no mission', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const counter = { calls: 0 };
  const input = missionInput(await example(rehearsalExample));

  await assert.rejects(
    runPipeline(input, {
      missionsDir,
      now: fixedNow,
      executeImpl: fakeExecutor(counter, { executedCommands: ['npm test'] }),
    }),
    (error) => (
      error instanceof PipelineError &&
      error.errors.some((item) => item.ruleId === 'COMMANDS_EXECUTED_MISMATCH')
    ),
  );
  assert.equal(counter.calls, 1);
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
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
  const writtenMission = JSON.parse(await readFile(path.join(result.missionDir, 'mission.json'), 'utf8'));
  assert.equal(writtenMission.run_record_bundle_digest, null);
  assert.equal(writtenMission.attestation_uri, null);
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

test('siteFile renders the public page atomically with the index refresh', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const siteFile = path.join(temporaryRoot, 'site/index.html');
  await mkdir(path.join(temporaryRoot, 'site', 'assets'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'site', 'receipts', 'legacy'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'site', 'receipts', 'M-999'), { recursive: true });
  await Promise.all([
    writeFile(siteFile, '<p>old generated page</p>\n'),
    writeFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'keep asset\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'keep legacy\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html'), 'remove stale generated receipt\n'),
  ]);
  const result = await runPipeline(missionInput(await example(rehearsalExample)), {
    missionsDir,
    siteFile,
    now: fixedNow,
    executeImpl: fakeExecutor(),
  });

  assert.equal(result.siteFile, siteFile);
  const page = await readFile(siteFile, 'utf8');
  assert.match(page, /M-001/);
  assert.match(await readFile(path.join(temporaryRoot, 'site/receipts/M-001/index.html'), 'utf8'), /NOT INCLUDED/);
  assert.equal(await readFile(path.join(temporaryRoot, 'site/assets/keep.txt'), 'utf8'), 'keep asset\n');
  assert.equal(await readFile(path.join(temporaryRoot, 'site/receipts/legacy/index.html'), 'utf8'), 'keep legacy\n');
  await assertMissing(path.join(temporaryRoot, 'site/receipts/M-999/index.html'));
  const index = JSON.parse(await readFile(path.join(missionsDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.missions.map((mission) => mission.mission_id), ['M-001']);
});

test('site render failure rolls back the mission and leaves index and page untouched', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const siteFile = path.join(temporaryRoot, 'site/index.html');
  const input = missionInput(await example(rehearsalExample));
  const previousIndex = '{"previous":true}\n';
  const previousPage = '<p>previous page</p>\n';
  const previousReceipt = '<p>previous receipt</p>\n';
  await mkdir(path.join(temporaryRoot, 'site/receipts/legacy'), { recursive: true });
  await mkdir(missionsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(missionsDir, 'index.json'), previousIndex),
    writeFile(siteFile, previousPage),
    writeFile(path.join(temporaryRoot, 'site/receipts/legacy/index.html'), previousReceipt),
  ]);

  await assert.rejects(
    runPipeline(input, {
      missionsDir,
      siteFile,
      now: fixedNow,
      executeImpl: fakeExecutor(),
      renderImpl: async ({ out }) => {
        await mkdir(path.join(path.dirname(out), 'receipts/partial'), { recursive: true });
        await writeFile(out, '<p>partial page</p>\n');
        await writeFile(path.join(path.dirname(out), 'receipts/partial/index.html'), '<p>partial receipt</p>\n');
        throw new Error('fake render failed');
      },
    }),
    /fake render failed/,
  );
  await assertMissing(path.join(missionsDir, input.mission.mission_id));
  assert.equal(await readFile(path.join(missionsDir, 'index.json'), 'utf8'), previousIndex);
  assert.equal(await readFile(siteFile, 'utf8'), previousPage);
  assert.equal(await readFile(path.join(temporaryRoot, 'site/receipts/legacy/index.html'), 'utf8'), previousReceipt);
  await assertMissing(path.join(temporaryRoot, 'site/receipts/partial/index.html'));
});

test('proof-of-pass pipeline rejects failed and timed-out commands without an opt-in flag', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const input = missionInput(await example(rehearsalExample));
  const failingExecutor = (record) => async (config, { outDir }) => {
    const runRecord = JSON.parse(await readFile(path.join(fixtures, 'run_record.json'), 'utf8'));
    runRecord.environment.container_image_ref = config.image;
    runRecord.commands = [record(config.commands[0])];
    const runRecordFile = path.join(outDir, 'run_record.json');
    await Promise.all([
      writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`),
      cp(path.join(fixtures, 'stdout.txt'), path.join(outDir, 'stdout.txt')),
      cp(path.join(fixtures, 'stderr.txt'), path.join(outDir, 'stderr.txt')),
    ]);
    return {
      runRecord,
      runRecordFile,
      stdoutFile: path.join(outDir, 'stdout.txt'),
      stderrFile: path.join(outDir, 'stderr.txt'),
    };
  };

  await t.test('nonzero exit', async () => {
    await assert.rejects(
      runPipeline(input, {
        missionsDir,
        now: fixedNow,
        executeImpl: failingExecutor((cmd) => ({ cmd, exit_code: 1, duration_ms: 10 })),
      }),
      (error) => error.errors.some((item) => item.ruleId === 'COMMAND_FAILED'),
    );
    await assertMissing(path.join(missionsDir, input.mission.mission_id));
  });

  await t.test('timeout', async () => {
    await assert.rejects(
      runPipeline(input, {
        missionsDir,
        now: fixedNow,
        executeImpl: failingExecutor((cmd) => ({ cmd, exit_code: null, duration_ms: 10, timed_out: true })),
      }),
      (error) => error.errors.some((item) => item.ruleId === 'COMMAND_FAILED'),
    );
    await assertMissing(path.join(missionsDir, input.mission.mission_id));
  });

  await t.test('the compatibility flag remains accepted', async () => {
    await assert.rejects(
      runPipeline(input, {
        missionsDir,
        now: fixedNow,
        requireSuccess: true,
        executeImpl: failingExecutor((cmd) => ({ cmd, exit_code: 1, duration_ms: 10 })),
      }),
      (error) => error.errors.some((item) => item.ruleId === 'COMMAND_FAILED'),
    );
    await assertMissing(path.join(missionsDir, input.mission.mission_id));
  });
});

test('code binding: a declared base_commit must equal what the executor actually ran', async (t) => {
  const realCommit = 'a'.repeat(40);

  await t.test('match publishes', async (tt) => {
    const temporaryRoot = await temporaryDirectory(tt);
    const dir = path.join(temporaryRoot, 'missions');
    const result = await runPipeline(
      missionInput(await example(rehearsalExample), { mission: { base_commit: realCommit } }),
      { missionsDir: dir, now: fixedNow, executeImpl: fakeExecutor(undefined, { sourceCommit: realCommit }) },
    );
    assert.equal(result.missionDir, path.join(dir, 'M-001'));
  });

  await t.test('mismatch fails closed and publishes nothing', async (tt) => {
    const temporaryRoot = await temporaryDirectory(tt);
    const dir = path.join(temporaryRoot, 'missions');
    const input = missionInput(await example(rehearsalExample), { mission: { base_commit: realCommit } });
    await assert.rejects(
      runPipeline(input, { missionsDir: dir, now: fixedNow, executeImpl: fakeExecutor(undefined, { sourceCommit: 'b'.repeat(40) }) }),
      (error) => error.errors.some((item) => item.ruleId === 'CODE_BINDING'),
    );
    await assertMissing(path.join(dir, input.mission.mission_id));
  });

  await t.test('declared commit the executor could not derive is unprovable → rejected', async (tt) => {
    const temporaryRoot = await temporaryDirectory(tt);
    const dir = path.join(temporaryRoot, 'missions');
    const input = missionInput(await example(rehearsalExample), { mission: { base_commit: realCommit } });
    await assert.rejects(
      runPipeline(input, { missionsDir: dir, now: fixedNow, executeImpl: fakeExecutor(undefined, { sourceCommit: null }) }),
      (error) => error.errors.some((item) => item.ruleId === 'CODE_BINDING'),
    );
    await assertMissing(path.join(dir, input.mission.mission_id));
  });

  await t.test('declared patch_diff_hash must equal the applied patch hash', async (tt) => {
    const temporaryRoot = await temporaryDirectory(tt);
    const dir = path.join(temporaryRoot, 'missions');
    const input = missionInput(await example(rehearsalExample), {
      mission: { patch_diff_hash: `sha256:${'c'.repeat(64)}` },
    });
    await assert.rejects(
      runPipeline(input, { missionsDir: dir, now: fixedNow, executeImpl: fakeExecutor(undefined, { patchSha256: `sha256:${'d'.repeat(64)}` }) }),
      (error) => error.errors.some((item) => item.ruleId === 'CODE_BINDING'),
    );
    await assertMissing(path.join(dir, input.mission.mission_id));
  });
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
