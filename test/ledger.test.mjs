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
  assert.deepEqual(index.missions.map((mission) => mission.attested), [false, true, true]);

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
    pr_url: 'https://github.com/example/project/pull/44',
    pr_head_oid: 'a'.repeat(40),
    state: 'closed_unmerged',
    review_decision: 'changes_requested',
    decision_url: 'https://github.com/example/project/pull/44#pullrequestreview-1',
    opened_at: '2026-07-10T00:00:00Z',
    closed_at: '2026-07-11T00:00:00Z',
    updated_at: '2026-07-11T00:00:00Z',
    correction_note: null,
  }, null, 2)}\n`);
  const out = path.join(temporaryRoot, 'index.json');
  const result = await buildLedger({missionsDir: copiedMissions, out, now: generatedAt});
  const mission = result.index.missions.find((entry) => entry.mission_id === 'M-004');
  assert.equal(mission.publication.pr_url, 'https://github.com/example/project/pull/44');
  assert.equal(mission.publication.state, 'closed_unmerged');
  assert.equal(mission.maintainer_outcome.status, 'closed_unmerged');
});

test('an open PR with changes requested is not described as awaiting maintainer review', () => {
  assert.equal(publicationOutcome({state: 'open', review_decision: 'changes_requested'}), 'changes_requested');
  assert.equal(publicationOutcome({state: 'open', review_decision: null}), 'open');
  assert.equal(publicationOutcome({state: 'closed_unmerged', review_decision: 'changes_requested'}), 'closed_unmerged');
});

test('publication attestation overlays cannot point outside the signing repository', () => {
  const publication = {
    schema_version: 1,
    mission_id: 'M-008',
    state: 'merged',
    review_decision: 'approved',
    attestation_uri: 'https://example.com/run-record-M-008.tar.gz',
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
  const previews = [...html.matchAll(/<article class="receipt-preview[\s\S]*?<\/article>/g)].map((match) => match[0]);
  assert.equal(previews.length, 3);
  for (const preview of previews) assert.doesNotMatch(preview, /\bPASS\b/);
  assert.match(previews[0], /attestation: not recorded/);
  assert.match(previews[1], /attestation: recorded/);

  const allowedHosts = collectHttpHosts(index);
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
  assert.equal(receipt.result, 'PASS — 1/1 declared check');
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
});

test('receipt view models bind code, bundle, and attestation identity across committed sources', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const copiedMission = path.join(temporaryRoot, 'missions', 'M-008');
  await cp(path.join(committedMissionsDirectory, 'M-008'), copiedMission, { recursive: true });
  const missionFile = path.join(copiedMission, 'mission.json');
  const publicationFile = path.join(copiedMission, 'publication.json');
  const originalMission = JSON.parse(await readFile(missionFile, 'utf8'));
  const originalPublication = JSON.parse(await readFile(publicationFile, 'utf8'));

  await writeFile(missionFile, `${JSON.stringify({ ...originalMission, base_commit: 'b'.repeat(40) }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /base_commit.*source_commit/i);

  await writeFile(missionFile, `${JSON.stringify({ ...originalMission, patch_diff_hash: `sha256:${'c'.repeat(64)}` }, null, 2)}\n`);
  await assert.rejects(buildReceiptViewModel({ missionFile }), /patch_diff_hash.*patch_sha256/i);

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
  assert.equal(build.included, 12);

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

  const missionIds = (await readdir(committedMissionsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^M-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const missionId of missionIds) {
    const page = await readFile(path.join(temporaryRoot, 'site', 'receipts', missionId, 'index.html'), 'utf8');
    assert.match(page, new RegExp(missionId));
    assert.match(page, /NOT INCLUDED/);
    assert.match(page, /declared check/);
    assert.doesNotMatch(page, /[ \t]+$/m);
    assert.doesNotMatch(page, /^ +\t/m);
  }
  const correction = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-015', 'index.html'), 'utf8');
  const m001 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-001', 'index.html'), 'utf8');
  assert.match(correction, /Correction: compile-typescript was run/);
  const m008 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-008', 'index.html'), 'utf8');
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
  assert.doesNotMatch(m008, /<h3>/);
  assert.match(homepage, /<h2>Proof-of-Pass Receipt<\/h2>/);
  assert.match(homepage, /<svg[^>]+role="img"/);
  assert.match(m008, /signing workflow[^<]+does not witness the recorded run/i);
  assert.match(m008, /policies\/claims_boundary\.md/);
  assert.match(m008, /SELF-FUNDED FIELD-TESTING/);
  assert.match(receiptArticle, /SELF-FUNDED FIELD-TESTING/);
  assert.match(m008, /@media print[\s\S]*color-scheme:light/);
  assert.match(m008, /\.receipt--declared\s*\{/);
  assert.match(m008, /data-print/);
  assert.match(m008, /window\.print\(\)/);
  assert.match(m008, /@page \{ size:80mm 800mm; margin:4mm; \}/);
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'utf8'), 'keep asset\n');
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'utf8'), 'keep legacy\n');
  await assert.rejects(access(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html')), (error) => error.code === 'ENOENT');

  const allowedHosts = collectHttpHosts(JSON.parse(await readFile(indexPath, 'utf8')));
  const renderedHosts = collectRenderedHttpHosts(`${homepage}\n${m008}`);
  assert.ok(renderedHosts.length > 0);
  for (const host of renderedHosts) assert.ok(allowedHosts.has(host), host);
});
