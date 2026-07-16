import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';

import {
  createSigningHandoff,
  verifySigningHandoff,
} from '../lib/signing-handoff.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/signing-handoff.mjs');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: {...process.env, LC_ALL: 'C'},
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function temporaryRepo(t, prefix = 'northset-signing-handoff-') {
  const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(temporary, {recursive: true, force: true}));
  const repo = path.join(temporary, 'repo');
  await mkdir(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Signing Handoff Test');
  git(repo, 'config', 'user.email', 'signing-handoff@example.invalid');
  git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  return {temporary, repo, base: git(repo, 'rev-parse', 'HEAD')};
}

function commit(repo, message) {
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

async function writeBundle(repo, missionId, payload = missionId) {
  const missionDirectory = path.join(repo, 'missions', missionId);
  const bundleDirectory = path.join(missionDirectory, 'bundle');
  await mkdir(bundleDirectory, {recursive: true});
  const mission = json({mission_id: missionId});
  const payloadText = `${payload}\n`;
  await Promise.all([
    writeFile(path.join(missionDirectory, 'mission.json'), mission),
    writeFile(path.join(bundleDirectory, 'mission.json'), mission),
    writeFile(path.join(bundleDirectory, 'payload.txt'), payloadText),
  ]);
  const files = [
    {path: 'mission.json', sha256: sha256(mission), bytes: Buffer.byteLength(mission)},
    {path: 'payload.txt', sha256: sha256(payloadText), bytes: Buffer.byteLength(payloadText)},
  ];
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
  await writeFile(path.join(bundleDirectory, 'bundle.manifest.json'), json({
    version: '0',
    created_at: '2026-07-16T12:00:00Z',
    files,
    bundle_digest: `sha256:${digest.digest('hex')}`,
  }));
}

async function makeBatch(t, missionIds) {
  const fixture = await temporaryRepo(t);
  for (const missionId of missionIds) await writeBundle(fixture.repo, missionId);
  return {...fixture, head: commit(fixture.repo, 'add bundles')};
}

test('packages a sorted multi-mission handoff deterministically and verifies every exact byte', async (t) => {
  const fixture = await makeBatch(t, ['M-010', 'M-002']);
  const first = path.join(fixture.temporary, 'handoff-first');
  const second = path.join(fixture.temporary, 'handoff-second');

  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: first,
  });
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: second,
  });

  const metadata = JSON.parse(await readFile(path.join(first, 'metadata.json'), 'utf8'));
  assert.equal(metadata.schema_version, 3);
  assert.equal(metadata.no_op, false);
  assert.equal(metadata.before_sha, fixture.base);
  assert.equal(metadata.head_sha, fixture.head);
  assert.deepEqual(metadata.missions.map(({mission_id}) => mission_id), ['M-002', 'M-010']);
  assert.equal(metadata.missions.length, 2);

  for (const mission of metadata.missions) {
    const prefix = mission.bundle_digest.slice('sha256:'.length, 'sha256:'.length + 12);
    assert.equal(mission.asset_name, `run-record-${mission.mission_id}-${prefix}.tar.gz`);
    assert.equal(mission.release_tag, `run-record-${mission.mission_id}-${prefix}`);
    const firstBytes = await readFile(path.join(first, mission.asset_name));
    const secondBytes = await readFile(path.join(second, mission.asset_name));
    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(mission.tarball_sha256, `sha256:${sha256(firstBytes)}`);

    const listing = spawnSync('tar', ['-tzf', path.join(first, mission.asset_name)], {encoding: 'utf8'});
    assert.equal(listing.status, 0, listing.stderr);
    assert.deepEqual(listing.stdout.trim().split('\n'), [
      'bundle/',
      'bundle/bundle.manifest.json',
      'bundle/mission.json',
      'bundle/payload.txt',
    ]);
  }

  const verified = await verifySigningHandoff({
    handoffDir: first,
    repoDir: fixture.repo,
    expectedBeforeSha: fixture.base,
    expectedHeadSha: fixture.head,
  });
  assert.deepEqual(verified, metadata);
  assert.deepEqual(await readFile(path.join(first, 'metadata.json')), await readFile(path.join(second, 'metadata.json')));
});

test('CLI emits and verifies an explicit no-op handoff', async (t) => {
  const fixture = await temporaryRepo(t);
  await writeFile(path.join(fixture.repo, 'README.md'), 'unrelated change\n');
  const head = commit(fixture.repo, 'unrelated change');
  const handoff = path.join(fixture.temporary, 'handoff');
  const output = path.join(fixture.temporary, 'github-output');

  let result = spawnSync(process.execPath, [
    cli,
    'create',
    '--repo', fixture.repo,
    '--before', fixture.base,
    '--head', head,
    '--out', handoff,
  ], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);

  const metadata = JSON.parse(await readFile(path.join(handoff, 'metadata.json'), 'utf8'));
  assert.equal(metadata.no_op, true);
  assert.deepEqual(metadata.missions, []);
  assert.deepEqual((await readdir(handoff)).sort(), ['metadata.json', 'verifier']);

  result = spawnSync(process.execPath, [
    path.join(handoff, 'verifier/bin/signing-handoff.mjs'),
    'verify',
    '--handoff', handoff,
    '--repo', fixture.repo,
    '--expected-before', fixture.base,
    '--expected-head', head,
    '--github-output', output,
  ], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(output, 'utf8'), 'no_op=true\nmission_count=0\n');
});

test('accepts 50 changed missions and rejects a 51-item range before packaging', async (t) => {
  const missionIds = Array.from({length: 50}, (_, index) => `M-${String(index).padStart(3, '0')}`);
  const fixture = await makeBatch(t, missionIds);
  const handoff = path.join(fixture.temporary, 'handoff-50');
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: handoff,
  });
  const verified = await verifySigningHandoff({
    handoffDir: handoff,
    repoDir: fixture.repo,
    expectedBeforeSha: fixture.base,
    expectedHeadSha: fixture.head,
  });
  assert.equal(verified.missions.length, 50);

  await writeBundle(fixture.repo, 'M-050');
  const tooManyHead = commit(fixture.repo, 'add fifty-first bundle');
  await assert.rejects(
    createSigningHandoff({
      repoDir: fixture.repo,
      beforeSha: fixture.base,
      headSha: tooManyHead,
      outDir: path.join(fixture.temporary, 'handoff-51'),
    }),
    /at most 50 changed missions/,
  );
});

test('fails closed on byte tampering, duplicate metadata identity, and a mismatched head', async (t) => {
  const fixture = await makeBatch(t, ['M-001']);
  const tampered = path.join(fixture.temporary, 'handoff-tampered');
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: tampered,
  });
  const metadata = JSON.parse(await readFile(path.join(tampered, 'metadata.json'), 'utf8'));
  await appendFile(path.join(tampered, metadata.missions[0].asset_name), 'tampered');
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: tampered,
      repoDir: fixture.repo,
      expectedBeforeSha: fixture.base,
      expectedHeadSha: fixture.head,
    }),
    /tarball SHA-256 mismatch/,
  );

  const duplicate = path.join(fixture.temporary, 'handoff-duplicate');
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: duplicate,
  });
  const duplicateMetadata = JSON.parse(await readFile(path.join(duplicate, 'metadata.json'), 'utf8'));
  duplicateMetadata.missions.push({...duplicateMetadata.missions[0]});
  await writeFile(path.join(duplicate, 'metadata.json'), json(duplicateMetadata));
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: duplicate,
      repoDir: fixture.repo,
      expectedBeforeSha: fixture.base,
      expectedHeadSha: fixture.head,
    }),
    /duplicate mission identity/,
  );
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: duplicate,
      repoDir: fixture.repo,
      expectedBeforeSha: fixture.head,
      expectedHeadSha: fixture.head,
    }),
    /before SHA does not match/,
  );
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: duplicate,
      repoDir: fixture.repo,
      expectedBeforeSha: fixture.base,
      expectedHeadSha: fixture.base,
    }),
    /head SHA does not match/,
  );
});

test('rejects coordinated omission from the independently derived changed mission set', async (t) => {
  const omittedFixture = await makeBatch(t, ['M-001', 'M-002']);
  const omitted = path.join(omittedFixture.temporary, 'handoff-omitted');
  await createSigningHandoff({
    repoDir: omittedFixture.repo,
    beforeSha: omittedFixture.base,
    headSha: omittedFixture.head,
    outDir: omitted,
  });
  const omittedMetadata = JSON.parse(await readFile(path.join(omitted, 'metadata.json'), 'utf8'));
  const [removedMission] = omittedMetadata.missions.splice(1, 1);
  await rm(path.join(omitted, removedMission.asset_name));
  await writeFile(path.join(omitted, 'metadata.json'), json(omittedMetadata));
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: omitted,
      repoDir: omittedFixture.repo,
      expectedBeforeSha: omittedFixture.base,
      expectedHeadSha: omittedFixture.head,
    }),
    /changed mission set/,
  );
});

test('rejects coordinated injection into the independently derived changed mission set', async (t) => {
  const injectedFixture = await makeBatch(t, ['M-001']);
  const injected = path.join(injectedFixture.temporary, 'handoff-injected');
  await createSigningHandoff({
    repoDir: injectedFixture.repo,
    beforeSha: injectedFixture.base,
    headSha: injectedFixture.head,
    outDir: injected,
  });
  const injectedMetadata = JSON.parse(await readFile(path.join(injected, 'metadata.json'), 'utf8'));
  const original = injectedMetadata.missions[0];
  const injectedMission = {
    ...original,
    mission_id: 'M-999',
    asset_name: original.asset_name.replace('M-001', 'M-999'),
    release_tag: original.release_tag.replace('M-001', 'M-999'),
  };
  await writeFile(
    path.join(injected, injectedMission.asset_name),
    await readFile(path.join(injected, original.asset_name)),
  );
  injectedMetadata.missions.push(injectedMission);
  await writeFile(path.join(injected, 'metadata.json'), json(injectedMetadata));
  await assert.rejects(
    verifySigningHandoff({
      handoffDir: injected,
      repoDir: injectedFixture.repo,
      expectedBeforeSha: injectedFixture.base,
      expectedHeadSha: injectedFixture.head,
    }),
    /changed mission set/,
  );
});

test('rejects coordinated archive and metadata tampering after inspecting canonical bundle hashes', async (t) => {
  const fixture = await makeBatch(t, ['M-001']);
  const handoff = path.join(fixture.temporary, 'handoff-coordinated-tamper');
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: handoff,
  });
  const metadata = JSON.parse(await readFile(path.join(handoff, 'metadata.json'), 'utf8'));
  const mission = metadata.missions[0];
  const archivePath = path.join(handoff, mission.asset_name);
  const tarBytes = gunzipSync(await readFile(archivePath));
  const originalPayload = Buffer.from('M-001\n');
  const payloadOffset = tarBytes.indexOf(originalPayload);
  assert.notEqual(payloadOffset, -1);
  Buffer.from('X-001\n').copy(tarBytes, payloadOffset);
  const tamperedArchive = gzipSync(tarBytes, {level: 9, mtime: 0});
  await writeFile(archivePath, tamperedArchive);
  mission.tarball_sha256 = `sha256:${sha256(tamperedArchive)}`;
  await writeFile(path.join(handoff, 'metadata.json'), json(metadata));

  await assert.rejects(
    verifySigningHandoff({
      handoffDir: handoff,
      repoDir: fixture.repo,
      expectedBeforeSha: fixture.base,
      expectedHeadSha: fixture.head,
    }),
    /bundle file does not match bundle\.manifest\.json/,
  );
});

test('packages only HEAD tree bytes when ignored and index-hidden working-tree bytes differ', async (t) => {
  const fixture = await makeBatch(t, ['M-001']);
  const bundleDirectory = path.join(fixture.repo, 'missions/M-001/bundle');
  const manifestPath = path.join(bundleDirectory, 'bundle.manifest.json');
  const payloadPath = path.join(bundleDirectory, 'payload.txt');
  git(
    fixture.repo,
    'update-index',
    '--skip-worktree',
    'missions/M-001/bundle/bundle.manifest.json',
    'missions/M-001/bundle/payload.txt',
  );
  await writeFile(path.join(fixture.repo, '.gitignore'), 'missions/*/bundle/ignored.txt\n');
  const mutablePayload = 'mutable index-hidden bytes\n';
  const ignoredPayload = 'mutable ignored bytes\n';
  await Promise.all([
    writeFile(payloadPath, mutablePayload),
    writeFile(path.join(bundleDirectory, 'ignored.txt'), ignoredPayload),
  ]);
  const mission = await readFile(path.join(bundleDirectory, 'mission.json'));
  const files = [
    {path: 'ignored.txt', sha256: sha256(ignoredPayload), bytes: Buffer.byteLength(ignoredPayload)},
    {path: 'mission.json', sha256: sha256(mission), bytes: mission.byteLength},
    {path: 'payload.txt', sha256: sha256(mutablePayload), bytes: Buffer.byteLength(mutablePayload)},
  ];
  const digest = createHash('sha256');
  for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
  await writeFile(manifestPath, json({
    version: '0',
    created_at: '2026-07-16T12:00:00Z',
    files,
    bundle_digest: `sha256:${digest.digest('hex')}`,
  }));

  const handoff = path.join(fixture.temporary, 'handoff-head-tree');
  await createSigningHandoff({
    repoDir: fixture.repo,
    beforeSha: fixture.base,
    headSha: fixture.head,
    outDir: handoff,
  });
  const metadata = JSON.parse(await readFile(path.join(handoff, 'metadata.json'), 'utf8'));
  const archive = path.join(handoff, metadata.missions[0].asset_name);
  const listing = spawnSync('tar', ['-tzf', archive], {encoding: 'utf8'});
  assert.equal(listing.status, 0, listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n'), [
    'bundle/',
    'bundle/bundle.manifest.json',
    'bundle/mission.json',
    'bundle/payload.txt',
  ]);
  const archivedPayload = spawnSync('tar', ['-xOzf', archive, 'bundle/payload.txt'], {encoding: 'utf8'});
  assert.equal(archivedPayload.status, 0, archivedPayload.stderr);
  assert.equal(archivedPayload.stdout, 'M-001\n');
});

test('rejects invalid revisions, mission identities, missing manifests, and invalid bundle digests', async (t) => {
  const invalidIdentity = await temporaryRepo(t, 'northset-signing-invalid-id-');
  await mkdir(path.join(invalidIdentity.repo, 'missions/not-a-mission/bundle'), {recursive: true});
  await writeFile(path.join(invalidIdentity.repo, 'missions/not-a-mission/bundle/payload.txt'), 'x\n');
  const invalidIdentityHead = commit(invalidIdentity.repo, 'invalid mission');
  await assert.rejects(
    createSigningHandoff({
      repoDir: invalidIdentity.repo,
      beforeSha: invalidIdentity.base,
      headSha: invalidIdentityHead,
      outDir: path.join(invalidIdentity.temporary, 'handoff'),
    }),
    /invalid changed mission identity/,
  );
  await assert.rejects(
    createSigningHandoff({
      repoDir: invalidIdentity.repo,
      beforeSha: 'HEAD~1',
      headSha: invalidIdentityHead,
      outDir: path.join(invalidIdentity.temporary, 'bad-revision'),
    }),
    /invalid before SHA/,
  );

  const missingManifest = await temporaryRepo(t, 'northset-signing-missing-manifest-');
  const missingBundleDirectory = path.join(missingManifest.repo, 'missions/M-001/bundle');
  await mkdir(missingBundleDirectory, {recursive: true});
  await writeFile(path.join(missingBundleDirectory, 'mission.json'), json({mission_id: 'M-001'}));
  await writeFile(path.join(missingManifest.repo, 'missions/M-001/mission.json'), json({mission_id: 'M-001'}));
  const missingManifestHead = commit(missingManifest.repo, 'missing manifest');
  await assert.rejects(
    createSigningHandoff({
      repoDir: missingManifest.repo,
      beforeSha: missingManifest.base,
      headSha: missingManifestHead,
      outDir: path.join(missingManifest.temporary, 'handoff'),
    }),
    /bundle\.manifest\.json/,
  );

  const badDigest = await makeBatch(t, ['M-002']);
  const manifestPath = path.join(badDigest.repo, 'missions/M-002/bundle/bundle.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.bundle_digest = 'sha256:not-a-digest';
  await writeFile(manifestPath, json(manifest));
  const badDigestHead = commit(badDigest.repo, 'break digest');
  await assert.rejects(
    createSigningHandoff({
      repoDir: badDigest.repo,
      beforeSha: badDigest.base,
      headSha: badDigestHead,
      outDir: path.join(badDigest.temporary, 'handoff-bad-digest'),
    }),
    /invalid bundle digest/,
  );
});

test('workflows use the tested batch CLI, one multi-subject attestation, and hash-pinned verifier', async () => {
  const [ciWorkflow, signingWorkflow, librarySource, cliSource] = await Promise.all([
    readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8'),
    readFile(path.join(root, '.github/workflows/attest-bundle.yml'), 'utf8'),
    readFile(path.join(root, 'lib/signing-handoff.mjs')),
    readFile(path.join(root, 'bin/signing-handoff.mjs')),
  ]);
  const librarySha256 = sha256(librarySource);
  const cliSha256 = sha256(cliSource);

  assert.match(ciWorkflow, /node bin\/signing-handoff\.mjs create/);
  assert.match(ciWorkflow, /name: ci-release-\$\{\{ github\.event\.before \}\}-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(ciWorkflow, /more than one bundle changed/);
  assert.match(signingWorkflow, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(signingWorkflow, /actions\/runs\/\$\{RUN_ID\}\/artifacts/);
  assert.match(signingWorkflow, /artifact-ids: \$\{\{ steps\.range\.outputs\.artifact_id \}\}/);
  assert.match(
    signingWorkflow,
    /artifact-ids: \$\{\{ steps\.range\.outputs\.artifact_id \}\}\n\s+path: handoff\n\s+merge-multiple: true/,
  );
  assert.match(signingWorkflow, /git -C trusted-source\.git fetch/);
  assert.match(signingWorkflow, /sha256sum --check --strict/);
  assert.match(signingWorkflow, /node handoff\/verifier\/bin\/signing-handoff\.mjs verify/);
  assert.match(signingWorkflow, /--repo trusted-source\.git/);
  assert.match(signingWorkflow, /--expected-before "\$EXPECTED_BEFORE"/);
  assert.match(signingWorkflow, new RegExp(`SIGNING_HANDOFF_LIB_SHA256: "${librarySha256}"`));
  assert.match(signingWorkflow, new RegExp(`SIGNING_HANDOFF_CLI_SHA256: "${cliSha256}"`));
  assert.equal((signingWorkflow.match(/actions\/attest-build-provenance@[0-9a-f]{40}/g) ?? []).length, 1);
  assert.match(signingWorkflow, /subject-path: handoff\/run-record-\*\.tar\.gz/);
  assert.doesNotMatch(signingWorkflow, /matrix:/);
});
