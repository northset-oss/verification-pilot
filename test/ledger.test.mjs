import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildLedger,
  buildReceiptViewModel,
  publicationOutcome,
  renderLedger,
  validatePublication,
} from '../lib/ledger.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/ledger.mjs');
const missionsDirectory = path.join(root, 'test/fixtures/ledger/missions');
const generatedAt = '2026-07-15T00:00:00Z';
const committedMissionsDirectory = path.join(root, 'missions');

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'northset-ledger-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function buildArgs(out, extra = []) {
  return [
    'build',
    '--missions-dir',
    missionsDirectory,
    '--out',
    out,
    '--now',
    generatedAt,
    '--allow-skips',
    ...extra,
  ];
}

function collectHttpHosts(value, hosts = new Set()) {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    hosts.add(new URL(value).host);
  } else if (Array.isArray(value)) {
    for (const item of value) collectHttpHosts(item, hosts);
  } else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectHttpHosts(item, hosts);
  }
  return hosts;
}

function collectRenderedHttpHosts(html) {
  const withoutXmlNamespaces = html.replace(/\sxmlns=(?:"[^"]*"|'[^']*')/gi, '');
  return [...withoutXmlNamespaces.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
    .map((match) => match[1]);
}

test('build includes only valid missions in sorted deterministic projections', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const firstPath = path.join(temporaryRoot, 'first.json');
  const secondPath = path.join(temporaryRoot, 'second.json');

  const firstBuild = run(buildArgs(firstPath, ['--json']));
  assert.equal(firstBuild.status, 0, firstBuild.stderr);
  assert.deepEqual(JSON.parse(firstBuild.stdout), { included: 3, skipped: 1 });
  assert.match(firstBuild.stderr, /^warning: .*invalid\/mission\.json: CONSENT_REQUIRED /);
  assert.equal(firstBuild.stderr.trim().split('\n').length, 1);

  const index = JSON.parse(await readFile(firstPath, 'utf8'));
  assert.equal(index.version, '0');
  assert.equal(index.generated_at, generatedAt);
  assert.deepEqual(index.missions.map((mission) => mission.mission_id), [
    'M-001',
    'M-004',
    'M-005',
  ]);
  assert.deepEqual(index.missions.map((mission) => mission.attested), [true, true, true]);

  const expectedFields = [
    'attestation_uri',
    'attested',
    'claims_tier',
    'consent_artifact',
    'disclosure_label',
    'grade',
    'issue_or_task',
    'maintainer_outcome',
    'mission_id',
    'publication',
    'receipt',
    'run_record_bundle_digest',
    'target_repo',
    'variant',
  ];
  for (const mission of index.missions) {
    assert.deepEqual(Object.keys(mission).sort(), expectedFields);
    assert.deepEqual(Object.keys(mission.maintainer_outcome), ['status', 'link']);
  }

  const secondBuild = run(buildArgs(secondPath));
  assert.equal(secondBuild.status, 0, secondBuild.stderr);
  assert.deepEqual(await readFile(secondPath), await readFile(firstPath));
});

test('publication envelopes overlay immutable mission records with factual PR state and direct links', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const copiedMissions = path.join(temporaryRoot, 'missions');
  await cp(missionsDirectory, copiedMissions, {recursive: true});
  await writeFile(path.join(copiedMissions, 'zeta', 'publication.json'), `${JSON.stringify({
    schema_version: 1,
    mission_id: 'M-004',
    state: 'closed_unmerged',
    pr_number: 44,
    pr_url: 'https://github.com/example/project/pull/44',
    pr_head_oid: 'a'.repeat(40),
    base_branch: 'main',
    head_drift: true,
    ci_state: 'success',
    merge_commit_oid: null,
    review_decision: 'changes_requested',
    decision_url: 'https://github.com/example/project/pull/44#pullrequestreview-1',
    opened_at: '2026-07-10T00:00:00Z',
    closed_at: '2026-07-11T00:00:00Z',
    updated_at: '2026-07-11T00:00:00Z',
    observed_at: '2026-07-11T01:00:00Z',
    correction_note: null,
    scope_note: null,
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-004/run-record-M-004.tar.gz',
    bundle_digest: `sha256:${'d'.repeat(64)}`,
    release_asset_sha256: `sha256:${'c'.repeat(64)}`,
    attestation_verified_at: '2026-07-11T01:00:00Z',
  }, null, 2)}\n`);
  const out = path.join(temporaryRoot, 'index.json');
  const result = await buildLedger({missionsDir: copiedMissions, out, now: generatedAt, allowSkips: true});
  const mission = result.index.missions.find((entry) => entry.mission_id === 'M-004');
  assert.equal(mission.publication.pr_url, 'https://github.com/example/project/pull/44');
  assert.equal(mission.publication.state, 'closed_unmerged');
  assert.equal(mission.maintainer_outcome.status, 'closed_unmerged');
});

test('open PR review decisions are projected as maintainer outcomes', () => {
  assert.equal(publicationOutcome({state: 'open', review_decision: 'changes_requested'}), 'changes_requested');
  assert.equal(publicationOutcome({state: 'open', review_decision: 'approved'}), 'approved');
  assert.equal(publicationOutcome({state: 'open', review_decision: null}), 'open');
  assert.equal(publicationOutcome({state: 'closed_unmerged', review_decision: 'changes_requested'}), 'closed_unmerged');
});

test('outcome attribution follows recorded state and decision evidence, never URL presence alone', async () => {
  const expected = new Map([
    ['M-016', ['open', 'Live upstream pull request']],
    ['M-020', ['merged', 'Linked maintainer review']],
    ['M-019', ['merged', 'Recorded upstream outcome']],
    ['M-009', ['closed_unmerged', 'Recorded upstream outcome']],
    ['M-011', ['approved', 'Linked maintainer review']],
    ['M-012', ['changes_requested', 'Linked maintainer review']],
  ]);
  for (const [missionId, [status, attribution]] of expected) {
    const receipt = await buildReceiptViewModel({
      missionFile: path.join(committedMissionsDirectory, missionId, 'mission.json'),
    });
    assert.equal(receipt.live_outcome.status, status, missionId);
    assert.equal(receipt.live_outcome.attribution, attribution, missionId);
  }
});

test('M-020 records the confirmed upstream merge without implying the receipt tested the final PR head', async () => {
  const receipt = await buildReceiptViewModel({
    missionFile: path.join(committedMissionsDirectory, 'M-020', 'mission.json'),
  });

  assert.equal(receipt.publication.state, 'merged');
  assert.equal(receipt.publication.review_decision, 'approved');
  assert.equal(receipt.publication.pr_head_oid, '00d27e70410dc78f0fcda582b987d515dc8b5817');
  assert.equal(receipt.publication.head_drift, true);
  assert.equal(receipt.publication.ci_state, 'success');
  assert.equal(receipt.publication.merge_commit_oid, 'b419d921c8de0b68e7eb7054f412b05ee69336a2');
  assert.equal(receipt.publication.closed_at, '2026-07-14T13:27:04Z');
  assert.equal(receipt.publication.decision_url, 'https://github.com/KaotoIO/kaoto/pull/3478#pullrequestreview-4694480971');
  assert.notEqual(receipt.code.recorded_patch_commit, receipt.publication.pr_head_oid);
  assert.equal(receipt.live_outcome.head_drift, true);
  assert.equal(receipt.live_outcome.pr_head_oid, receipt.publication.pr_head_oid);
});

test('publication attestation overlays cannot point outside the signing repository', () => {
  const publication = {
    schema_version: 1,
    mission_id: 'M-008',
    state: 'merged',
    pr_number: 8,
    pr_url: 'https://github.com/example/project/pull/8',
    pr_head_oid: 'a'.repeat(40),
    base_branch: 'main',
    head_drift: false,
    ci_state: 'success',
    merge_commit_oid: 'b'.repeat(40),
    review_decision: 'approved',
    decision_url: 'https://github.com/example/project/pull/8#pullrequestreview-1',
    opened_at: '2026-07-10T00:00:00Z',
    closed_at: '2026-07-11T00:00:00Z',
    updated_at: '2026-07-11T00:00:00Z',
    observed_at: '2026-07-11T01:00:00Z',
    correction_note: null,
    scope_note: null,
    attestation_uri: 'https://example.com/run-record-M-008.tar.gz',
    bundle_digest: `sha256:${'a'.repeat(64)}`,
    release_asset_sha256: `sha256:${'b'.repeat(64)}`,
    attestation_verified_at: '2026-07-11T01:00:00Z',
  };
  assert.throws(() => validatePublication(publication, 'M-008'), /attestation_uri.*signing repository/i);
});

test('build exits nonzero when the missions directory is unreadable', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const result = run([
    'build',
    '--missions-dir',
    path.join(temporaryRoot, 'missing'),
    '--out',
    path.join(temporaryRoot, 'index.json'),
    '--now',
    generatedAt,
  ]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^ledger: /);
});

test('render emits a self-contained claims surface with encoded mission data', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const indexPath = path.join(temporaryRoot, 'index.json');
  const htmlPath = path.join(temporaryRoot, 'index.html');
  const build = run(buildArgs(indexPath));
  assert.equal(build.status, 0, build.stderr);

  const render = run([
    'render',
    '--index',
    indexPath,
    '--out',
    htmlPath,
    '--now',
    generatedAt,
  ]);
  assert.equal(render.status, 0, render.stderr);
  assert.equal(render.stdout, '');
  assert.equal(render.stderr, '');

  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const html = await readFile(htmlPath, 'utf8');
  assert.match(html, /<title>Northset Proof-of-Pass Receipts<\/title>/);
  assert.match(html, /<link rel="icon" href="data:,">/);
  assert.match(html, /<a class="northset-brand" href="https:\/\/northset\.ai"/);
  assert.match(html, /<svg class="northset-wordmark" role="img" aria-label="NORTHSET"/);
  assert.match(html, /<p class="northset-domain"><a href="https:\/\/northset\.ai">northset\.ai<\/a><\/p>/);
  assert.doesNotMatch(html, /<p class="eyebrow">PUBLIC LEDGER<\/p>/);
  assert.match(html, /\.northset-wordmark \{[^}]*width:min\(100%,32rem\);/);
  assert.match(html, /\.northset-domain \{[^}]*font-size:clamp\(1\.15rem,3vw,1\.5rem\);/);
  assert.match(html, /Proof-of-Pass Receipts/);
  assert.doesNotMatch(html, /[ \t]+$/m);
  for (const mission of index.missions) assert.ok(html.includes(mission.mission_id));

  assert.doesNotMatch(html, /<script\s+src\s*=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet["'][^>]*href\s*=/i);
  assert.doesNotMatch(html, /\b(?:cdn|googleapis)\b/i);
  assert.doesNotMatch(html, /\bfetch\s*\(/);

  assert.doesNotMatch(html, /<script>alert\(/);
  const xssReceipt = await readFile(path.join(temporaryRoot, 'receipts', 'M-005', 'index.html'), 'utf8');
  const verificationReceipt = await readFile(path.join(temporaryRoot, 'receipts', 'M-004', 'index.html'), 'utf8');
  const unattestedReceipt = await readFile(path.join(temporaryRoot, 'receipts', 'M-001', 'index.html'), 'utf8');
  assert.match(xssReceipt, /NOT INCLUDED/);
  assert.doesNotMatch(xssReceipt, /<script>alert\(/);
  assert.match(xssReceipt, /&lt;script&gt;alert/);
  assert.match(html, /overflow:auto/);
  assert.match(html, /@media print/);
  assert.match(html, /data-filter="merged"/);
  assert.match(html, /SELF-FUNDED FIELD-TESTING/);
  assert.match(html, /policies\/claims_boundary\.md/);
  assert.match(html, /class="hero-notes"/);
  assert.equal((html.match(/<li class="hero-note">/g) ?? []).length, 4);
  assert.match(verificationReceipt, /Maintainer consent/);
  assert.match(verificationReceipt, /https:\/\/example\.com\/maintainer\/project\/consent\/42/);
  assert.match(unattestedReceipt, /Attestation confirms that Northset's signing workflow produced this exact bundle/);
  const previews = [...html.matchAll(/<article class="receipt-preview[\s\S]*?<\/article>/g)].map((match) => match[0]);
  assert.equal(previews.length, 3);
  for (const preview of previews.filter((preview) => !/REHEARSAL/.test(preview))) {
    assert.match(preview, /PASS — \d+\/\d+ declared command/);
  }
  assert.ok(previews.every((preview) => /attestation: recorded/.test(preview)));

  const allowedHosts = collectHttpHosts(index);
  allowedHosts.add('northset.ai');
  const renderedHosts = collectRenderedHttpHosts(html);
  assert.ok(renderedHosts.length > 0);
  for (const host of renderedHosts) assert.ok(allowedHosts.has(host), host);
});

test('receipt view models copy command-level evidence from committed sources and fail closed on a mismatch', async (t) => {
  const missionFile = path.join(committedMissionsDirectory, 'M-008', 'mission.json');
  const receipt = await buildReceiptViewModel({ missionFile });

  assert.equal(receipt.mission_id, 'M-008');
  assert.deepEqual(receipt.commands.map((command) => command.cmd), [
    'npm run test --workspace=@blockly/plugin-workspace-search',
  ]);
  assert.deepEqual(receipt.commands.map((command) => command.exit_code), [0]);
  assert.equal(receipt.result, 'PASS — 1/1 declared command');
  assert.equal(receipt.issue_title, 'workspace-search buttons need type=button');
  assert.equal(receipt.classification, 'CONTRIBUTOR SELF-RUN — NOT MAINTAINER VERIFICATION');
  assert.equal(receipt.environment.container_image_ref, 'node:22-bookworm');
  assert.equal(receipt.publication.state, 'merged');
  assert.match(receipt.stdout_redacted, /Building tests for @blockly\/plugin-workspace-search/);
  assert.match(receipt.stderr_redacted, /Tried to move a non-movable workspace/);

  const temporaryRoot = await temporaryDirectory(t);
  const copiedMission = path.join(temporaryRoot, 'missions', 'M-008');
  await cp(path.dirname(missionFile), copiedMission, { recursive: true });
  const runRecordFile = path.join(copiedMission, 'bundle', 'run_record.json');
  const runRecord = JSON.parse(await readFile(runRecordFile, 'utf8'));
  runRecord.commands[0].cmd = 'npm run invented-check';
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);

  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /commands_declared.*run_record\.json:commands/i,
  );

  runRecord.commands[0].cmd = receipt.commands[0].cmd;
  runRecord.finished_at = '07/12/2026';
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /finished_at.*ISO-8601/i,
  );

  runRecord.finished_at = receipt.finished_at;
  runRecord.commands[0].timed_out = 'true';
  runRecord.commands[0].exit_code = 0;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /timed_out.*boolean/i,
  );

  runRecord.commands[0].timed_out = true;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /exit_code.*timed_out/i,
  );

  runRecord.commands[0].exit_code = 1;
  runRecord.commands[0].timed_out = false;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /proof-of-pass.*exit 0/i,
  );

  runRecord.commands[0].exit_code = null;
  runRecord.commands[0].timed_out = true;
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(copiedMission, 'mission.json') }),
    /proof-of-pass.*timed out/i,
  );
});

test('receipt view models bind the signed mission and expose only a URL-bound issue title', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const copiedMission = path.join(temporaryRoot, 'missions', 'M-008');
  await cp(path.join(committedMissionsDirectory, 'M-008'), copiedMission, { recursive: true });
  const missionFile = path.join(copiedMission, 'mission.json');
  const bundledMissionFile = path.join(copiedMission, 'bundle', 'mission.json');
  const bundledMission = JSON.parse(await readFile(bundledMissionFile, 'utf8'));
  bundledMission.disclosure_label = 'A divergent signed disclosure.';
  await writeFile(bundledMissionFile, `${JSON.stringify(bundledMission, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /signed bundle.*disclosure_label/i);

  await cp(path.join(committedMissionsDirectory, 'M-008', 'bundle', 'mission.json'), bundledMissionFile);
  const issueFile = path.join(copiedMission, 'bundle', 'issue_snapshot.json');
  const issueSnapshot = JSON.parse(await readFile(issueFile, 'utf8'));
  issueSnapshot.issue.html_url = 'https://github.com/example/other/issues/99';
  await writeFile(issueFile, `${JSON.stringify(issueSnapshot, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /issue_snapshot.*issue_or_task/i);

  for (const missingValue of [null, undefined]) {
    const freshSnapshot = JSON.parse(await readFile(path.join(committedMissionsDirectory, 'M-008', 'bundle', 'issue_snapshot.json'), 'utf8'));
    if (missingValue === undefined) delete freshSnapshot.issue.html_url;
    else freshSnapshot.issue.html_url = missingValue;
    await writeFile(issueFile, `${JSON.stringify(freshSnapshot, null, 2)}\n`);
    await assert.rejects(buildReceiptViewModel({ missionFile }), /issue_snapshot.*html_url.*must equal.*issue_or_task/i);
  }
});

test('receipt view models bind code, bundle, and attestation identity across committed sources', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const copiedMission = path.join(temporaryRoot, 'missions', 'M-008');
  await cp(path.join(committedMissionsDirectory, 'M-008'), copiedMission, { recursive: true });
  const missionFile = path.join(copiedMission, 'mission.json');
  const publicationFile = path.join(copiedMission, 'publication.json');
  const bundledMissionFile = path.join(copiedMission, 'bundle', 'mission.json');
  const originalMission = JSON.parse(await readFile(missionFile, 'utf8'));
  const originalBundledMission = JSON.parse(await readFile(bundledMissionFile, 'utf8'));
  const originalPublication = JSON.parse(await readFile(publicationFile, 'utf8'));

  await writeFile(missionFile, `${JSON.stringify({ ...originalMission, base_commit: 'b'.repeat(40) }, null, 2)}\n`);
  await writeFile(bundledMissionFile, `${JSON.stringify({ ...originalBundledMission, base_commit: 'b'.repeat(40) }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /base_commit.*source_commit/i);

  await writeFile(missionFile, `${JSON.stringify({ ...originalMission, patch_diff_hash: `sha256:${'c'.repeat(64)}` }, null, 2)}\n`);
  await writeFile(bundledMissionFile, `${JSON.stringify({ ...originalBundledMission, patch_diff_hash: `sha256:${'c'.repeat(64)}` }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /patch_diff_hash.*patch_sha256/i);

  await writeFile(bundledMissionFile, `${JSON.stringify(originalBundledMission, null, 2)}\n`);
  await writeFile(missionFile, `${JSON.stringify({ ...originalMission, run_record_bundle_digest: `sha256:${'d'.repeat(64)}` }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /bundle digest.*disagree/i);

  await writeFile(missionFile, `${JSON.stringify(originalMission, null, 2)}\n`);
  await writeFile(publicationFile, `${JSON.stringify({
    ...originalPublication,
    attestation_uri: 'https://github.com/northset-oss/verification-pilot/releases/download/run-record-M-019/run-record-M-019.tar.gz',
  }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /attestation.*M-008/i);
});

test('an invalid publication fails the ledger build instead of hiding mutable outcome data', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missionsDir = path.join(temporaryRoot, 'missions');
  const copiedMission = path.join(missionsDir, 'M-015');
  await cp(path.join(committedMissionsDirectory, 'M-015'), copiedMission, { recursive: true });
  const publicationFile = path.join(copiedMission, 'publication.json');
  const publication = JSON.parse(await readFile(publicationFile, 'utf8'));
  publication.correction_note = ['hidden by invalid type'];
  await writeFile(publicationFile, `${JSON.stringify(publication, null, 2)}\n`);

  await assert.rejects(
    buildLedger({ missionsDir, out: path.join(temporaryRoot, 'index.json'), now: generatedAt }),
    /publication correction_note must be a string or null/i,
  );

  publication.correction_note = null;
  publication.scope_note = ['not transparent prose'];
  await writeFile(publicationFile, `${JSON.stringify(publication, null, 2)}\n`);
  await assert.rejects(
    buildLedger({ missionsDir, out: path.join(temporaryRoot, 'index.json'), now: generatedAt }),
    /publication scope_note must be a string or null/i,
  );
});

test('a failed direct render leaves existing generated receipt pages intact', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const index = JSON.parse(await readFile(path.join(committedMissionsDirectory, 'index.json'), 'utf8'));
  index.missions.find((mission) => mission.mission_id === 'M-008').receipt.canonical_url = `https://example.com/${'x'.repeat(200)}`;
  const indexPath = path.join(temporaryRoot, 'index.json');
  const out = path.join(temporaryRoot, 'site', 'index.html');
  const marker = path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html');
  await mkdir(path.dirname(marker), { recursive: true });
  await Promise.all([
    writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`),
    writeFile(marker, 'existing generated receipt\n'),
  ]);

  await assert.rejects(renderLedger({ indexPath, out }), /QR version 5-L byte capacity/);
  assert.equal(await readFile(marker, 'utf8'), 'existing generated receipt\n');
});

test('render rejects an unsafe receipt mission id before writing outside the site tree', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const index = JSON.parse(await readFile(path.join(committedMissionsDirectory, 'index.json'), 'utf8'));
  index.missions[0].receipt.mission_id = '../../escaped';
  const indexPath = path.join(temporaryRoot, 'index.json');
  const out = path.join(temporaryRoot, 'site', 'index.html');
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);

  await assert.rejects(renderLedger({ indexPath, out }), /receipt mission_id/i);
  await assert.rejects(access(out), (error) => error.code === 'ENOENT');
  await assert.rejects(
    access(path.join(temporaryRoot, 'escaped', 'index.html')),
    (error) => error.code === 'ENOENT',
  );
});

test('render creates a permanent printable receipt for every committed mission and features M-008', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const indexPath = path.join(temporaryRoot, 'index.json');
  const siteFile = path.join(temporaryRoot, 'site', 'index.html');
  const build = await buildLedger({
    missionsDir: committedMissionsDirectory,
    out: indexPath,
    now: '2026-07-13T22:32:35Z',
  });
  const committedIndex = JSON.parse(
    await readFile(path.join(committedMissionsDirectory, 'index.json'), 'utf8'),
  );
  assert.equal(build.included, committedIndex.missions.length);

  await mkdir(path.join(temporaryRoot, 'site', 'assets'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'site', 'receipts', 'legacy'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'site', 'receipts', 'M-999'), { recursive: true });
  await Promise.all([
    writeFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'keep asset\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'keep legacy\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html'), 'remove stale generated receipt\n'),
  ]);

  const render = run([
    'render',
    '--index',
    indexPath,
    '--out',
    siteFile,
  ]);
  assert.equal(render.status, 0, render.stderr);
  const homepage = await readFile(siteFile, 'utf8');
  assert.match(homepage, /Proof-of-Pass Receipt/);
  assert.match(homepage, /id="M-008"/);
  assert.match(homepage, /receipts\/M-008\//);
  const featuredArticle = homepage.match(/<article class="receipt[^>]*id="M-008"[\s\S]*?<\/article>/)?.[0];
  assert.ok(featuredArticle);
  assert.match(featuredArticle, /signing workflow[^<]+does not witness the recorded run/i);
  assert.match(featuredArticle, /SELF-FUNDED FIELD-TESTING/);
  assert.match(homepage, /<details class="rehearsal-archive">/);
  assert.match(homepage, /External receipts/);
  assert.match(homepage, /Merged upstream/);
  assert.match(homepage, /Open awaiting review/);
  assert.match(homepage, /A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment\./);
  assert.match(homepage, /workspace-search buttons need type=button/);
  assert.match(homepage, /for open-source work/);
  const externalGallery = homepage.match(/<section class="gallery"[\s\S]*?<\/section>/)?.[0];
  assert.ok(externalGallery);
  const externalReceipts = build.index.missions
    .map((mission) => mission.receipt)
    .filter((receipt) => receipt.variant !== 'own_repo_rehearsal')
    .sort((left, right) => right.finished_at.localeCompare(left.finished_at) || left.mission_id.localeCompare(right.mission_id));
  let lastPreviewPosition = -1;
  for (const receipt of externalReceipts) {
    const position = externalGallery.indexOf(`class="preview-id">${receipt.mission_id}<`);
    assert.ok(position > lastPreviewPosition, `${receipt.mission_id} should follow newest-first external order`);
    lastPreviewPosition = position;
  }
  const rehearsalIds = build.index.missions
    .map((mission) => mission.receipt)
    .filter((receipt) => receipt.variant === 'own_repo_rehearsal')
    .map((receipt) => receipt.mission_id);
  for (const missionId of rehearsalIds) assert.doesNotMatch(externalGallery, new RegExp(`>${missionId}<`));
  assert.equal((externalGallery.match(/data-publication-state="open"/g) ?? []).length, 4);
  assert.equal((externalGallery.match(/data-review-decision="changes_requested"/g) ?? []).length, 2);
  assert.equal((externalGallery.match(/data-publication-state="merged"/g) ?? []).length, 3);
  assert.equal((externalGallery.match(/data-publication-state="closed_unmerged"/g) ?? []).length, 3);
  for (const preview of externalGallery.match(/<article class="receipt-preview[\s\S]*?<\/article>/g) ?? []) {
    const labelledBy = preview.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(labelledBy, 'preview must have aria-labelledby');
    assert.match(preview, new RegExp(`<h3 id="${labelledBy}" class="preview-id">`));
  }

  const missionIds = (await readdir(committedMissionsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^M-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const missionId of missionIds) {
    const page = await readFile(path.join(temporaryRoot, 'site', 'receipts', missionId, 'index.html'), 'utf8');
    assert.match(page, new RegExp(missionId));
    assert.match(page, /NOT INCLUDED/);
    assert.match(page, /declared command/);
    assert.match(page, /Receipt ID/);
    assert.match(page, /Verification execution/);
    assert.match(page, /Signed bundle/);
    assert.match(page, /Download receipt\.json/);
    assert.match(page, /Download signed bundle/);
    assert.match(page, /Verify this receipt/);
    assert.match(page, /Print \/ Save receipt/);
    assert.match(page, /Unlisted test, lint, typecheck, build, coverage, compiler, full-suite, and CI gates are not implied or recorded\./);
    const receiptJson = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', missionId, 'receipt.json'), 'utf8'));
    assert.equal(receiptJson.schema_version, 1);
    assert.equal(receiptJson.receipt_id, missionId);
    assert.match(receiptJson.receipt_result, /^PASS — \d+\/\d+ declared command/);
    assert.equal(receiptJson.passed_commands, receiptJson.declared_commands);
    assert.ok(Array.isArray(receiptJson.commands));
    assert.ok(receiptJson.environment);
    assert.ok(receiptJson.code);
    assert.ok(receiptJson.bundle.bundle_contents_digest);
    assert.ok(receiptJson.bundle.signed_asset_sha256);
    assert.ok(!Object.hasOwn(receiptJson, 'patch_diff'));
    assert.ok(!Object.hasOwn(receiptJson, 'stdout_redacted'));
    assert.ok(!Object.hasOwn(receiptJson, 'stderr_redacted'));
    assert.ok(!Object.hasOwn(receiptJson, 'publication'));
    assert.doesNotMatch(page, /[ \t]+$/m);
    assert.doesNotMatch(page, /^ +\t/m);
  }
  const correction = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-015', 'index.html'), 'utf8');
  const m001 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-001', 'index.html'), 'utf8');
  assert.match(correction, /Correction: compile-typescript was run/);
  const m008 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-008', 'index.html'), 'utf8');
  const m016 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-016', 'index.html'), 'utf8');
  const m019 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-019', 'index.html'), 'utf8');
  const m020 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-020', 'index.html'), 'utf8');
  const receiptArticle = m008.match(/<article class="receipt[\s\S]*?<\/article>/)?.[0];
  assert.ok(receiptArticle);
  assert.doesNotMatch(homepage, /[ \t]+$/m);
  assert.doesNotMatch(m008, /[ \t]+$/m);
  assert.doesNotMatch(m008, /\.qr-link\s*\{\s*display:none/);
  assert.match(m008, /\.patch,\.evidence-output\s*\{\s*display:none/);
  assert.doesNotMatch(m008, /size:80mm auto/);
  assert.match(m008, /run wall \(derived from recorded timestamps\)/);
  assert.match(m008, /<dt>Run start<\/dt><dd>2026-07-12T01:49:17\.299Z<\/dd>/);
  assert.match(m008, /<dt>Run finish<\/dt><dd>2026-07-12T01:51:33\.547Z<\/dd>/);
  assert.match(m008, /<summary>Redacted stdout<\/summary>/);
  assert.match(m008, /<summary>Redacted stderr<\/summary>/);
  assert.match(m008, /Building tests for @blockly\/plugin-workspace-search/);
  assert.match(m008, /Tried to move a non-movable workspace/);
  assert.doesNotMatch(m001, /run wall \(derived from recorded timestamps\)/);
  assert.doesNotMatch(m001, /setup \+ install \(derived\)/);
  assert.doesNotMatch(m008, /setup \+ install \(online, derived\)/);
  assert.match(m008, /setup \+ install \(derived\)/);
  assert.match(m008, /<h1>Proof-of-Pass Receipt — M-008<\/h1>/);
  assert.match(m008, /workspace-search buttons need type=button/);
  assert.match(m016, /Public scope interpretation/);
  assert.match(m016, /The declared network-off check runs one focused Vitest spec for Quadlet digest replacement\. It does not run Renovate’s full test, lint, typecheck, or coverage gates\./);
  assert.match(m019, /The focused test inspects generated Swift output\. It does not invoke a Swift compiler or run the full quicktype test suite\./);
  const m016Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-016', 'receipt.json'), 'utf8'));
  const m019Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-019', 'receipt.json'), 'utf8'));
  const m020Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-020', 'receipt.json'), 'utf8'));
  assert.equal(m016Json.scope_note, 'The declared network-off check runs one focused Vitest spec for Quadlet digest replacement. It does not run Renovate’s full test, lint, typecheck, or coverage gates.');
  assert.equal(m019Json.scope_note, 'The focused test inspects generated Swift output. It does not invoke a Swift compiler or run the full quicktype test suite.');
  assert.match(m020, /PR changed since this record\.[\s\S]*Recorded patch commit <code>ffc3e052480163e7338e3164008c6a7a26a77605<\/code>; current PR head observed at 2026-07-14T15:02:48Z: <code>00d27e70410dc78f0fcda582b987d515dc8b5817<\/code>/);
  assert.doesNotMatch(m020, /This receipt tested/);
  assert.equal(m020Json.upstream_outcome.head_drift, true);
  assert.equal(m020Json.upstream_outcome.pr_head_oid, '00d27e70410dc78f0fcda582b987d515dc8b5817');
  assert.doesNotMatch(m016, /OPEN[\s\S]{0,160}Maintainer decision/);
  assert.doesNotMatch(m019, /MERGED[\s\S]{0,160}Maintainer decision/);
  assert.doesNotMatch(m008, /<h3>/);
  assert.match(homepage, /<h2>Proof-of-Pass Receipt<\/h2>/);
  assert.match(homepage, /<svg[^>]+role="img"/);
  assert.match(m008, /signing workflow[^<]+does not witness the recorded run/i);
  assert.match(m008, /policies\/claims_boundary\.md/);
  assert.match(m008, /SELF-FUNDED FIELD-TESTING/);
  assert.match(receiptArticle, /SELF-FUNDED FIELD-TESTING/);
  assert.match(m008, /@media print[\s\S]*color-scheme:light/);
  assert.match(m008, /@media print[\s\S]*\.facts,\.receipt-meta\s*\{\s*grid-template-columns:1fr/);
  assert.match(m008, /\.receipt--declared\s*\{/);
  assert.match(m008, /data-print/);
  assert.match(m008, /window\.print\(\)/);
  assert.match(m008, /@page \{ size:80mm 800mm; margin:4mm; \}/);
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'utf8'), 'keep asset\n');
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'utf8'), 'keep legacy\n');
  await assert.rejects(access(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html')), (error) => error.code === 'ENOENT');

  const allowedHosts = collectHttpHosts(JSON.parse(await readFile(indexPath, 'utf8')));
  allowedHosts.add('northset.ai');
  const renderedHosts = collectRenderedHttpHosts(`${homepage}\n${m008}`);
  assert.ok(renderedHosts.length > 0);
  for (const host of renderedHosts) assert.ok(allowedHosts.has(host), host);
});
