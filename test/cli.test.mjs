import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/validate-mission.mjs');
const validFile = path.join(root, 'examples/M-001_own_repo_rehearsal.json');
const invalidFile = path.join(root, 'test/fixtures/invalid/consent_required.json');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('CLI exits zero and stays quiet for valid receipts', () => {
  const result = run([validFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('CLI exits one with one human-readable line per violation', () => {
  const result = run([invalidFile]);
  const lines = result.stderr.trim().split('\n');

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /consent_required\.json: CONSENT_REQUIRED: /);
});

test('--json emits parseable per-file results', () => {
  const result = run(['--json', validFile, invalidFile]);
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(output.valid, false);
  assert.equal(output.files.length, 2);
  assert.equal(output.files[0].valid, true);
  assert.equal(output.files[1].valid, false);
  assert.equal(output.files[1].errors[0].ruleId, 'CONSENT_REQUIRED');
});
