import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateRunRecord } from '../lib/bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/bundle.mjs');
const fixtures = path.join(root, 'test/fixtures/bundle');
const createdAt = '2026-07-08T12:34:56Z';

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function copyFixture(t, name = 'sample') {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-bundle-test-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const missionDirectory = path.join(temporaryRoot, name);
  await cp(path.join(fixtures, name), missionDirectory, { recursive: true });
  return missionDirectory;
}

function createArgs(missionDirectory, extra = []) {
  return [
    'create',
    missionDirectory,
    '--stdout',
    path.join(missionDirectory, 'stdout.txt'),
    '--stderr',
    path.join(missionDirectory, 'stderr.txt'),
    '--run-record',
    path.join(missionDirectory, 'run_record.json'),
    '--created-at',
    createdAt,
    ...extra,
  ];
}

async function prepareVariantInputs(missionDirectory) {
  for (const name of ['stdout.txt', 'stderr.txt', 'run_record.json']) {
    await cp(path.join(fixtures, 'sample', name), path.join(missionDirectory, name));
  }
}

test('create produces the frozen layout, redactions, and a verifiable manifest', async (t) => {
  const missionDirectory = await copyFixture(t);
  const creation = run(createArgs(missionDirectory));
  assert.equal(creation.status, 0, creation.stderr);
  assert.match(creation.stdout, /^bundle_digest sha256:[0-9a-f]{64}\n$/);
  assert.equal(creation.stderr, '');

  const bundleDirectory = path.join(missionDirectory, 'bundle');
  assert.deepEqual((await readdir(bundleDirectory)).sort(), [
    'base_commit.txt',
    'bundle.manifest.json',
    'ci_links.json',
    'claims_tier.txt',
    'commands.json',
    'issue_snapshot.json',
    'maintainer_outcome.json',
    'mission.json',
    'patch.diff',
    'run_record.json',
    'stderr_redacted.txt',
    'stdout_redacted.txt',
  ]);
  assert.equal(await readFile(path.join(bundleDirectory, 'mission.json'), 'utf8'), await readFile(path.join(missionDirectory, 'mission.json'), 'utf8'));
  assert.equal(await readFile(path.join(bundleDirectory, 'issue_snapshot.json'), 'utf8'), await readFile(path.join(missionDirectory, 'issue_snapshot.json'), 'utf8'));

  const runRecord = JSON.parse(await readFile(path.join(bundleDirectory, 'run_record.json'), 'utf8'));
  assert.deepEqual(runRecord.redactions, {
    email: 1,
    github_token: 1,
    path: 2,
    url_query: 1,
  });
  assert.match(runRecord.notes, /\[REDACTED:github_token\]/);
  assert.match(runRecord.environment.network_policy, /\/Users\/\[user\]\//);
  assert.doesNotMatch(await readFile(path.join(bundleDirectory, 'stdout_redacted.txt'), 'utf8'), /stdout-token-value/);

  const manifest = JSON.parse(await readFile(path.join(bundleDirectory, 'bundle.manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0');
  assert.equal(manifest.created_at, createdAt);
  assert.deepEqual(manifest.files.map((file) => file.path), [...manifest.files.map((file) => file.path)].sort());
  assert.equal(manifest.files.some((file) => file.path === 'bundle.manifest.json'), false);
  const digestInput = manifest.files.map((file) => `${file.path}\0${file.sha256}\n`).join('');
  assert.equal(manifest.bundle_digest, `sha256:${createHash('sha256').update(digestInput).digest('hex')}`);

  const verification = run(['verify', missionDirectory]);
  assert.equal(verification.status, 0, verification.stderr);
  assert.equal(verification.stdout, `OK ${manifest.bundle_digest}\n`);
  assert.equal(verification.stderr, '');
});

test('verify reports tampered, missing, and extra files', async (t) => {
  const missionDirectory = await copyFixture(t);
  const bundleDirectory = path.join(missionDirectory, 'bundle');

  await t.test('tampered', async () => {
    assert.equal(run(createArgs(missionDirectory)).status, 0);
    await writeFile(path.join(bundleDirectory, 'stdout_redacted.txt'), 'tampered\n', { flag: 'a' });
    const result = run(['verify', missionDirectory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISMATCHED stdout_redacted\.txt/);
  });

  await t.test('missing', async () => {
    assert.equal(run(createArgs(missionDirectory)).status, 0);
    await unlink(path.join(bundleDirectory, 'commands.json'));
    const result = run(['verify', missionDirectory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /MISSING commands\.json/);
  });

  await t.test('extra', async () => {
    assert.equal(run(createArgs(missionDirectory)).status, 0);
    await writeFile(path.join(bundleDirectory, 'unexpected.txt'), 'extra\n');
    const result = run(['verify', missionDirectory]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EXTRA unexpected\.txt/);
  });
});

test('same inputs and created_at produce a byte-identical manifest', async (t) => {
  const missionDirectory = await copyFixture(t);
  assert.equal(run(createArgs(missionDirectory)).status, 0);
  const first = await readFile(path.join(missionDirectory, 'bundle/bundle.manifest.json'));
  assert.equal(run(createArgs(missionDirectory)).status, 0);
  const second = await readFile(path.join(missionDirectory, 'bundle/bundle.manifest.json'));
  assert.deepEqual(second, first);
});

test('CONSENT_FILE_REQUIRED applies to V but not own_repo_rehearsal', async (t) => {
  const variantDirectory = await copyFixture(t, 'variant_v');
  await prepareVariantInputs(variantDirectory);
  const rejected = run(createArgs(variantDirectory));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /CONSENT_FILE_REQUIRED/);
  assert.equal(rejected.stdout, '');

  const consent = {
    schema_version: 1,
    mission_id: 'M-102',
    variant: 'V',
    consent_artifact: 'https://example.com/maintainer/bundle-fixture/consent/1',
    granted_at: '2026-07-08T12:00:00Z',
    granted_by: 'fixture maintainer',
    publication_consent: true,
    scope: ['run the declared verification commands', 'publish the scoped receipt'],
  };
  await writeFile(path.join(variantDirectory, 'consent.json'), `${JSON.stringify(consent, null, 2)}\n`);
  const consented = run(createArgs(variantDirectory));
  assert.equal(consented.status, 0, consented.stderr);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(variantDirectory, 'bundle/consent.json'), 'utf8')),
    consent,
  );

  const rehearsalDirectory = await copyFixture(t);
  const accepted = run(createArgs(rehearsalDirectory));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal((await readdir(path.join(rehearsalDirectory, 'bundle'))).includes('consent.json'), false);
});

test('--json returns machine-readable create and verify results', async (t) => {
  const missionDirectory = await copyFixture(t);
  const creation = run(createArgs(missionDirectory, ['--json']));
  assert.equal(creation.status, 0, creation.stderr);
  assert.equal(creation.stderr, '');
  const created = JSON.parse(creation.stdout);
  assert.equal(created.ok, true);
  assert.match(created.bundle_digest, /^sha256:[0-9a-f]{64}$/);

  const verification = run(['verify', missionDirectory, '--json']);
  assert.equal(verification.status, 0, verification.stderr);
  assert.deepEqual(JSON.parse(verification.stdout), created);
});

test('run record validation rejects unknown top-level keys and malformed members', () => {
  const record = {
    started_at: '2026-02-30T10:00:00Z',
    finished_at: '2026-07-08T10:00:01Z',
    environment: { container_image_digest: null, network_policy: 'none' },
    commands: [{ cmd: 'node --test', exit_code: 0.5, duration_ms: 1 }],
    notes: null,
    redactions: {},
  };
  const result = validateRunRecord(record);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((error) => error.ruleId), [
    'RUN_RECORD_FORMAT',
    'RUN_RECORD_TYPE',
  ]);
});

test('run record validation binds complete normalized workspace authority evidence', () => {
  const base = {
    started_at: '2026-07-08T10:00:00Z',
    finished_at: '2026-07-08T10:00:01Z',
    environment: {
      container_image_digest: null,
      network_policy: 'phaseA:bridge,phaseB:none',
      workspace_mode: 'writable_copy',
      workspace_write_allowlist: ['coverage'],
      workspace_file_count_limit: 200_000,
      workspace_bytes_limit: 2 * 1024 * 1024 * 1024,
      initial_workspace_manifest_digest: `sha256:${'a'.repeat(64)}`,
      post_run_changed_tracked_paths: [],
      post_run_untracked_paths: ['coverage', 'coverage/result.json'],
      post_run_mode_changes: [],
    },
    commands: [],
    notes: null,
  };
  assert.deepEqual(validateRunRecord(base), {valid: true, errors: []});

  const missingCap = structuredClone(base);
  delete missingCap.environment.workspace_bytes_limit;
  assert.ok(validateRunRecord(missingCap).errors.some((error) => (
    error.ruleId === 'RUN_RECORD_REQUIRED' && error.path === '$.environment.workspace_bytes_limit'
  )));

  const orphanedEvidence = structuredClone(base);
  delete orphanedEvidence.environment.workspace_mode;
  assert.ok(validateRunRecord(orphanedEvidence).errors.some((error) => (
    error.ruleId === 'RUN_RECORD_REQUIRED' && error.path === '$.environment.workspace_mode'
  )));

  for (const allowlist of [['../escape'], Array.from({length: 33}, (_, index) => `out-${index}`)]) {
    const invalid = structuredClone(base);
    invalid.environment.workspace_write_allowlist = allowlist;
    assert.ok(validateRunRecord(invalid).errors.some((error) => (
      error.path.startsWith('$.environment.workspace_write_allowlist')
    )));
  }

  const readonly = structuredClone(base);
  readonly.environment.workspace_mode = 'readonly';
  assert.ok(validateRunRecord(readonly).errors.some((error) => (
    error.path === '$.environment.workspace_write_allowlist'
  )));
});

test('run record validation enforces the timeout exit-code invariant', () => {
  const base = {
    started_at: '2026-07-08T10:00:00Z',
    finished_at: '2026-07-08T10:00:01Z',
    environment: { container_image_digest: `node@sha256:${'e'.repeat(64)}`, network_policy: 'phaseA:bridge,phaseB:none' },
    commands: [],
    notes: null,
  };

  const timeout = {
    cmd: 'node --test',
    exit_code: null,
    duration_ms: 1000,
    timed_out: true,
  };
  assert.deepEqual(validateRunRecord({ ...base, commands: [timeout] }), { valid: true, errors: [] });

  const missingTimedOut = validateRunRecord({
    ...base,
    commands: [{ cmd: timeout.cmd, exit_code: null, duration_ms: timeout.duration_ms }],
  });
  assert.deepEqual(missingTimedOut.errors.map((error) => error.ruleId), [
    'RUN_RECORD_TIMEOUT_INVARIANT',
  ]);

  const integerTimedOut = validateRunRecord({
    ...base,
    commands: [{ ...timeout, exit_code: 124 }],
  });
  assert.deepEqual(integerTimedOut.errors.map((error) => error.ruleId), [
    'RUN_RECORD_TIMEOUT_INVARIANT',
  ]);
});
