import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/verify-receipt-parity.mjs');

const executionReceipt = {
  mission_id: 'M-007',
  variant: 'own_repo_rehearsal',
  claims_tier: ['R0'],
  commands_declared: ['node --test'],
  maintainer_outcome: { status: 'pending', link: null, decided_at: null },
};

async function missionDir(t, top, bundled) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'parity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'bundle'), { recursive: true });
  await writeFile(path.join(dir, 'mission.json'), JSON.stringify(top, null, 2));
  await writeFile(path.join(dir, 'bundle', 'mission.json'), JSON.stringify(bundled, null, 2));
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [cli, dir], { encoding: 'utf8' });
}

test('publication-envelope-only differences pass', async (t) => {
  const bundled = { ...executionReceipt, attestation_uri: null, run_record_bundle_digest: null };
  const top = {
    ...executionReceipt,
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/x',
    run_record_bundle_digest: `sha256:${'a'.repeat(64)}`,
  };
  const result = run(await missionDir(t, top, bundled));
  assert.equal(result.status, 0, result.stderr);
});

test('a diverging EXECUTION field fails closed', async (t) => {
  const bundled = { ...executionReceipt, attestation_uri: null, run_record_bundle_digest: null };
  const top = { ...bundled, commands_declared: ['rm -rf /'] };
  const result = run(await missionDir(t, top, bundled));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SPLIT_BRAIN.*commands_declared/);
});

test('an envelope field that is non-null-and-different inside the bundle fails', async (t) => {
  const bundled = { ...executionReceipt, attestation_uri: 'https://evil.example/x', run_record_bundle_digest: null };
  const top = { ...executionReceipt, attestation_uri: 'https://github.com/northset-oss/verification-pilot/x', run_record_bundle_digest: null };
  const result = run(await missionDir(t, top, bundled));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SPLIT_BRAIN/);
});
