import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/verify-proof-of-pass.mjs');

function run(missionDirectory) {
  return spawnSync(process.execPath, [cli, missionDirectory], { cwd: root, encoding: 'utf8' });
}

async function copiedMission(t) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'proof-of-pass-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const missionDirectory = path.join(temporaryRoot, 'M-008');
  await cp(path.join(root, 'missions', 'M-008'), missionDirectory, { recursive: true });
  return missionDirectory;
}

test('proof-of-pass verifier accepts a committed successful receipt', () => {
  const result = run(path.join(root, 'missions', 'M-008'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /OK M-008: PASS — 1\/1 declared command/);
});

test('proof-of-pass verifier rejects nonzero and timed-out commands', async (t) => {
  const missionDirectory = await copiedMission(t);
  const runRecordFile = path.join(missionDirectory, 'bundle', 'run_record.json');
  const runRecord = JSON.parse(await readFile(runRecordFile, 'utf8'));

  runRecord.commands[0].exit_code = 7;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  let result = run(missionDirectory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOT_PROOF_OF_PASS.*exited 7/);

  runRecord.commands[0].exit_code = null;
  runRecord.commands[0].timed_out = true;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  result = run(missionDirectory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOT_PROOF_OF_PASS.*timed out/);
});

test('proof-of-pass verifier rejects malformed command evidence instead of coercing it', async (t) => {
  const missionDirectory = await copiedMission(t);
  const runRecordFile = path.join(missionDirectory, 'bundle', 'run_record.json');
  const runRecord = JSON.parse(await readFile(runRecordFile, 'utf8'));
  runRecord.commands[0].timed_out = 'false';
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  const result = run(missionDirectory);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RUN_RECORD_TYPE.*timed_out/);
});
