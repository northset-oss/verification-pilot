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
  formatHumanDate,
  formatRunInterval,
  publicationOutcome,
  renderLedger,
  truncateHash,
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

test('presentation helpers humanize UTC dates and compact SHA-256 values deterministically', () => {
  assert.equal(formatHumanDate('2026-07-12T23:49:17-02:00'), 'Jul 13, 2026');
  assert.equal(
    formatRunInterval('2026-07-12T01:49:17.299Z', '2026-07-12T01:51:33.547Z', 136248),
    'Jul 12, 2026 · 01:49–01:51 UTC · 2m 16s',
  );
  assert.equal(
    truncateHash(`sha256:${'a'.repeat(64)}`),
    `sha256:${'a'.repeat(6)}…${'a'.repeat(7)}`,
  );
  assert.equal(
    truncateHash(`node@sha256:${'b'.repeat(64)}`),
    `node@sha256:${'b'.repeat(6)}…${'b'.repeat(7)}`,
  );
  assert.equal(truncateHash('not recorded'), 'not recorded');
});

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

function assertWellFormedStandaloneSvg(svg) {
  assert.match(svg, /^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>/);
  assert.match(svg, /<title\b[^>]*>[^<]+<\/title>/);
  assert.match(svg, /<desc\b[^>]*>[^<]+<\/desc>/);
  assert.match(svg, /<\/svg>\n$/);
  assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|\b(?:href|src)=/i);
  const stack = [];
  for (const match of svg.matchAll(/<(\/)?([A-Za-z][\w:-]*)\b[^>]*>/g)) {
    const [tag, closing, name] = match;
    if (closing) assert.equal(stack.pop(), name, `unexpected closing tag ${name}`);
    else if (!tag.endsWith('/>')) stack.push(name);
  }
  assert.deepEqual(stack, []);
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
  assert.equal(index.version, '1');
  assert.equal(index.generated_at, generatedAt);
  assert.deepEqual(index.ci_agreement, { agreed: 2, total: 2 });
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
    ['M-011', ['merged', 'Linked maintainer review']],
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

test('a prepared receipt with pending attestation builds and renders without claiming verification', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const missions = path.join(temporaryRoot, 'missions');
  const missionDirectory = path.join(missions, 'M-020');
  await cp(path.join(committedMissionsDirectory, 'M-020'), missionDirectory, { recursive: true });
  const publicationFile = path.join(missionDirectory, 'publication.json');
  const publication = JSON.parse(await readFile(publicationFile, 'utf8'));
  const staleMissionAttestation = publication.attestation_uri;
  const staleReleaseAssetSha256 = publication.release_asset_sha256;
  const staleAttestationVerifiedAt = publication.attestation_verified_at;
  const missionFile = path.join(missionDirectory, 'mission.json');
  const mission = JSON.parse(await readFile(missionFile, 'utf8'));
  mission.attestation_uri = staleMissionAttestation;
  await writeFile(missionFile, `${JSON.stringify(mission, null, 2)}\n`);
  Object.assign(publication, {
    state: 'prepared',
    pr_number: null,
    pr_url: null,
    pr_head_oid: null,
    base_branch: null,
    head_drift: false,
    ci_state: null,
    merge_commit_oid: null,
    review_decision: null,
    decision_url: null,
    opened_at: null,
    closed_at: null,
    updated_at: null,
    observed_at: null,
    attestation_uri: null,
    release_asset_sha256: null,
    attestation_verified_at: null,
  });
  await writeFile(publicationFile, `${JSON.stringify(publication, null, 2)}\n`);

  const indexPath = path.join(temporaryRoot, 'index.json');
  const siteFile = path.join(temporaryRoot, 'site', 'index.html');
  await buildLedger({ missionsDir: missions, out: indexPath, now: generatedAt });
  await renderLedger({ indexPath, out: siteFile, now: generatedAt });

  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  assert.equal(index.missions[0].attested, false);
  assert.equal(index.missions[0].attestation_uri, null);
  assert.equal(index.missions[0].receipt.attestation_uri, null);
  assert.equal(index.missions[0].receipt.verify_command, null);
  assert.equal(index.missions[0].receipt.download_url, null);
  const receiptHtml = await readFile(path.join(temporaryRoot, 'site/receipts/M-020/index.html'), 'utf8');
  assert.match(receiptHtml, /Signed asset SHA-256<\/dt><dd><code>not recorded<\/code>/);
  assert.match(receiptHtml, /Signed provenance recorded<\/dt><dd>not verified<\/dd>/);
  assert.match(receiptHtml, /Attestation URL was not recorded/);
  assert.doesNotMatch(receiptHtml, /Download signed bundle/);
  const receiptJson = JSON.parse(await readFile(path.join(temporaryRoot, 'site/receipts/M-020/receipt.json'), 'utf8'));
  assert.equal(receiptJson.bundle.signed_asset_sha256, null);
  assert.equal(receiptJson.bundle.attestation_verified_at, null);
  assert.equal(receiptJson.bundle.attestation_uri, null);
  assert.equal(receiptJson.bundle.provenance, 'Signed provenance has not been verified.');
  assert.equal(receiptJson.upstream_outcome.status, 'prepared');

  const incoherentReceipt = index.missions[0].receipt;
  incoherentReceipt.attestation_uri = staleMissionAttestation;
  incoherentReceipt.release_asset_sha256 = staleReleaseAssetSha256;
  incoherentReceipt.attestation_verified_at = staleAttestationVerifiedAt;
  incoherentReceipt.verify_command = 'gh attestation verify stale.tar.gz';
  incoherentReceipt.download_url = staleMissionAttestation;
  const incoherentIndex = path.join(temporaryRoot, 'incoherent-index.json');
  await writeFile(incoherentIndex, `${JSON.stringify(index, null, 2)}\n`);
  const defensiveSite = path.join(temporaryRoot, 'defensive-site', 'index.html');
  await renderLedger({ indexPath: incoherentIndex, out: defensiveSite, now: generatedAt });
  const defensiveHome = await readFile(defensiveSite, 'utf8');
  assert.match(defensiveHome, /attestation: not recorded/);
  assert.doesNotMatch(defensiveHome, /attestation: recorded/);
  const defensiveHtml = await readFile(path.join(temporaryRoot, 'defensive-site/receipts/M-020/index.html'), 'utf8');
  assert.match(defensiveHtml, /Attestation URL was not recorded/);
  assert.match(defensiveHtml, /Signed asset SHA-256<\/dt><dd><code>not recorded<\/code>/);
  assert.match(defensiveHtml, /Signed provenance recorded<\/dt><dd>not verified<\/dd>/);
  assert.doesNotMatch(defensiveHtml, /Download signed bundle|gh attestation verify stale|attestation-scope/);
  const defensiveJson = JSON.parse(await readFile(path.join(temporaryRoot, 'defensive-site/receipts/M-020/receipt.json'), 'utf8'));
  assert.equal(defensiveJson.bundle.attestation_uri, null);
  assert.equal(defensiveJson.bundle.provenance, 'Signed provenance has not been verified.');
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
  assert.equal((html.match(/<li class="hero-note">/g) ?? []).length, 3);
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
  await mkdir(path.join(temporaryRoot, 'site', 'repo', 'stale--repository'), { recursive: true });
  await mkdir(path.join(temporaryRoot, 'site', 'repo', 'keep--repository'), { recursive: true });
  await Promise.all([
    writeFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'keep asset\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'keep legacy\n'),
    writeFile(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html'), 'remove stale generated receipt\n'),
    writeFile(path.join(temporaryRoot, 'site', 'repo', 'stale--repository', '.northset-ledger-generated'), 'northset-ledger-repository-page\n'),
    writeFile(path.join(temporaryRoot, 'site', 'repo', 'keep--repository', 'index.html'), 'keep unrelated repository page\n'),
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
  assert.match(featuredArticle, /Signed provenance verified[\s\S]+signer does not witness the recorded run/i);
  assert.match(featuredArticle, /NOT MAINTAINER VERIFICATION/);
  assert.match(featuredArticle, /Evidence of what ran — not a verdict that the code is good/);
  assert.match(featuredArticle, /SELF-FUNDED FIELD-TESTING/);
  assert.match(homepage, /<details class="rehearsal-archive">/);
  assert.match(homepage, /External receipts/);
  assert.match(homepage, /Merged upstream/);
  assert.match(homepage, /Open · awaiting review/);
  assert.match(homepage, /A proof-of-pass receipt records that the declared commands returned exit 0 on the named code in the named environment\./);
  assert.match(homepage, /workspace-search buttons need type=button/);
  assert.match(homepage, /for open-source work/);
  const expectedAgreement = build.index.ci_agreement;
  assert.match(homepage, new RegExp(`agreed with the receipt in <strong>${expectedAgreement.agreed} of ${expectedAgreement.total}<\\/strong> runs`));
  assert.match(homepage, /If your CI disagrees with this receipt,[\s\S]*report it[\s\S]*we publish discrepancies on this ledger/);
  const masthead = homepage.match(/<header class="mast">[\s\S]*?<\/header>/)?.[0];
  assert.ok(masthead);
  assert.ok(masthead.indexOf('request-a-run.yml') < masthead.indexOf('mailto:oss@northset.ai'));
  const externalGallery = homepage.match(/<section class="gallery"[\s\S]*?<\/section>/)?.[0];
  assert.ok(externalGallery);
  const externalReceipts = build.index.missions
    .map((mission) => mission.receipt)
    .filter((receipt) => receipt.variant !== 'own_repo_rehearsal')
    .sort((left, right) => right.finished_at.localeCompare(left.finished_at) || left.mission_id.localeCompare(right.mission_id));
  let lastPreviewPosition = -1;
  for (const receipt of externalReceipts) {
    const position = externalGallery.indexOf(`class="preview-id">Receipt ${receipt.mission_id}<`);
    assert.ok(position > lastPreviewPosition, `${receipt.mission_id} should follow newest-first external order`);
    lastPreviewPosition = position;
  }
  const rehearsalIds = build.index.missions
    .map((mission) => mission.receipt)
    .filter((receipt) => receipt.variant === 'own_repo_rehearsal')
    .map((receipt) => receipt.mission_id);
  for (const missionId of rehearsalIds) assert.doesNotMatch(externalGallery, new RegExp(`>${missionId}<`));
  for (const state of ['open', 'merged', 'closed_unmerged']) {
    const expectedCount = externalReceipts.filter(({ publication }) => publication?.state === state).length;
    assert.equal(
      (externalGallery.match(new RegExp(`data-publication-state="${state}"`, 'g')) ?? []).length,
      expectedCount,
      state,
    );
  }
  const changesRequestedCount = externalReceipts
    .filter(({ publication }) => publication?.review_decision === 'changes_requested')
    .length;
  assert.equal(
    (externalGallery.match(/data-review-decision="changes_requested"/g) ?? []).length,
    changesRequestedCount,
    'changes_requested',
  );
  for (const preview of externalGallery.match(/<article class="receipt-preview[\s\S]*?<\/article>/g) ?? []) {
    const labelledBy = preview.match(/aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(labelledBy, 'preview must have aria-labelledby');
    assert.match(preview, new RegExp(`<h3 id="${labelledBy}" class="preview-repo">`));
  }

  const missionIds = (await readdir(committedMissionsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^M-/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const receiptVersions = new Map(
    build.index.missions.map(({ mission_id: missionId, receipt }) => [missionId, receipt.version]),
  );
  for (const missionId of missionIds) {
    const page = await readFile(path.join(temporaryRoot, 'site', 'receipts', missionId, 'index.html'), 'utf8');
    const publication = JSON.parse(await readFile(
      path.join(committedMissionsDirectory, missionId, 'publication.json'), 'utf8',
    ));
    const preparedPending = publication.state === 'prepared' && publication.attestation_uri === null;
    assert.match(page, new RegExp(missionId));
    assert.match(page, /NOT INCLUDED/);
    assert.match(page, /declared command/);
    assert.match(page, /Receipt ID/);
    assert.match(page, /Verification execution/);
    assert.match(page, /Signed bundle/);
    assert.match(page, /Download receipt\.json/);
    if (preparedPending) {
      assert.match(page, /Attestation URL was not recorded/);
      assert.doesNotMatch(page, /Download signed bundle|Verify this receipt/);
    } else {
      assert.match(page, /Download signed bundle/);
      assert.match(page, /Verify this receipt/);
      assert.match(page, /Check this receipt without trusting this site/);
      assert.match(page, /Expected output includes <code>Verification succeeded!<\/code>/);
    }
    assert.match(page, /If your CI disagrees with this receipt,[\s\S]*report it[\s\S]*we publish discrepancies on this ledger/);
    const requestBox = page.match(/<section class="request-run"[\s\S]*?<\/section>/)?.[0];
    assert.ok(requestBox);
    assert.ok(requestBox.indexOf('request-a-run.yml') < requestBox.indexOf('mailto:oss@northset.ai'));
    assert.match(requestBox, /href="https:\/\/github\.com\/northset-oss\/verification-pilot\/issues\/new\?template=request-a-run\.yml">Open a public request<\/a>/);
    assert.match(requestBox, /href="mailto:oss@northset\.ai\?/);
    assert.match(requestBox, /<code>northset-verify<\/code>/);
    assert.match(requestBox, /href="https:\/\/northset-oss\.github\.io\/verification-pilot\/receipts\/M-004\/">See a sample private check receipt<\/a>/);
    const repository = new URL(build.index.missions.find((mission) => mission.mission_id === missionId).receipt.target_repo).pathname.replace(/^\//, '');
    assert.match(page, new RegExp(`Maintain ${repository.replace('/', '\\/')}\\?`));
    if (publication.state !== 'prepared') {
      assert.match(page, new RegExp(`All Northset work in ${repository.replace('/', '\\/')} →`));
    }
    if (['success', 'failure'].includes(publication.ci_state)) {
      assert.match(page, new RegExp(`Upstream CI ${publication.ci_state === 'success' ? 'agreed' : 'disagreed'} with this receipt`));
    } else {
      assert.doesNotMatch(page, /class="receipt-ci-agreement"/);
    }
    assert.match(page, /Print \/ Save receipt/);
    assert.match(page, /Unlisted test, lint, typecheck, build, coverage, compiler, full-suite, and CI gates are not implied or recorded\./);
    const receiptJson = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', missionId, 'receipt.json'), 'utf8'));
    assert.equal(receiptJson.schema_version, receiptVersions.get(missionId), missionId);
    assert.equal(receiptJson.receipt_id, missionId);
    assert.match(receiptJson.receipt_result, /^PASS — \d+\/\d+ declared command/);
    assert.equal(receiptJson.passed_commands, receiptJson.declared_commands);
    assert.ok(Array.isArray(receiptJson.commands));
    assert.ok(receiptJson.environment);
    assert.ok(receiptJson.code);
    assert.ok(receiptJson.bundle.bundle_contents_digest);
    if (preparedPending) {
      assert.equal(receiptJson.bundle.signed_asset_sha256, null);
      assert.equal(receiptJson.bundle.attestation_uri, null);
      assert.equal(receiptJson.bundle.attestation_verified_at, null);
      assert.equal(receiptJson.bundle.provenance, 'Signed provenance has not been verified.');
    } else {
      assert.ok(receiptJson.bundle.signed_asset_sha256);
    }
    assert.ok(!Object.hasOwn(receiptJson, 'patch_diff'));
    assert.ok(!Object.hasOwn(receiptJson, 'stdout_redacted'));
    assert.ok(!Object.hasOwn(receiptJson, 'stderr_redacted'));
    assert.ok(!Object.hasOwn(receiptJson, 'publication'));
    assert.doesNotMatch(page, /[ \t]+$/m);
    assert.doesNotMatch(page, /^ +\t/m);
    const receiptArticle = page.match(/<article class="receipt[\s\S]*?<\/article>/)?.[0];
    assert.ok(receiptArticle, `${missionId} receipt article`);
    if (receiptJson.schema_version === 1) {
      assert.match(receiptArticle, /class="receipt [^"]*receipt--economic receipt--v1"/);
      assert.match(receiptArticle, /class="folio-watermark"/);
      assert.match(receiptArticle, /class="proof-hero"/);
      assert.match(receiptArticle, new RegExp(`class="proof-score">${receiptJson.passed_commands}\\/${receiptJson.declared_commands}<`));
      assert.match(receiptArticle, /class="proof-status-rail" data-receipt-version="1"/);
      assert.match(receiptArticle, /<dt>Upstream<\/dt>[\s\S]*<dt>Environment<\/dt>[\s\S]*<dt>Signature<\/dt>/);
      assert.match(receiptArticle, /class="evidence-drawer evidence-annex evidence-annex--v1"/);
      assert.match(receiptArticle, /<summary><span>\d{2} \/ Evidence annex<\/span>/);
      assert.match(receiptArticle, /class="class-stamp"/);
      assert.match(receiptArticle, /NOT INCLUDED/);
      assert.match(page, /not maintainer verification/i);
      assert.ok(receiptArticle.indexOf('DECLARED CHECKS') < receiptArticle.indexOf('class="evidence-drawer'));
      assert.ok(receiptArticle.indexOf('NOT INCLUDED') < receiptArticle.indexOf('class="evidence-drawer'));
      if (receiptJson.scope_note !== null) {
        const escapedScopeNote = receiptJson.scope_note
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
        assert.equal(receiptArticle.split(escapedScopeNote).length - 1, 1);
        assert.ok(receiptArticle.indexOf('PUBLIC SCOPE INTERPRETATION') < receiptArticle.indexOf('class="evidence-drawer'));
      }
      assert.doesNotMatch(receiptArticle, /class="[^"]*(?:proofline|anatomy-|identity-flow|economic-identity|economic-unknowns|receipt-cost-total|annex-economic)/);
      assert.doesNotMatch(receiptArticle, /data-cost-state=|Cost record|TOTAL COST|Known, unknown, and unpriced/);
    } else {
      assert.match(page, /<section class="proofline"/);
      assert.match(page, /<section class="economic-identity"/);
      assert.match(page, /<section class="economic-unknowns"/);
      assert.match(page, /<section class="receipt-cost-total"/);
    }
  }
  const correction = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-015', 'index.html'), 'utf8');
  const m001 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-001', 'index.html'), 'utf8');
  const m004 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-004', 'index.html'), 'utf8');
  assert.match(correction, /Correction: compile-typescript was run/);
  assert.match(m004, /REHEARSAL — NOT EXTERNAL VALIDATION/);
  assert.match(m004, /Self-authorized verification-lane rehearsal/);
  const m008 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-008', 'index.html'), 'utf8');
  const m016 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-016', 'index.html'), 'utf8');
  const m019 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-019', 'index.html'), 'utf8');
  const m020 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-020', 'index.html'), 'utf8');
  const m105 = await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-105', 'index.html'), 'utf8');
  const receiptArticle = m008.match(/<article class="receipt[\s\S]*?<\/article>/)?.[0];
  assert.ok(receiptArticle);
  assert.doesNotMatch(homepage, /[ \t]+$/m);
  assert.doesNotMatch(m008, /[ \t]+$/m);
  assert.doesNotMatch(m008, /\.qr-link\s*\{\s*display:none/);
  assert.match(m008, /\.patch,\.evidence-output\s*\{\s*display:none/);
  assert.doesNotMatch(m008, /size:80mm auto/);
  assert.match(m008, /run wall \(derived from recorded timestamps\)/);
  assert.match(m008, /class="run-interval">[\s\S]*<time datetime="2026-07-12T01:49:17\.299Z">Jul 12, 2026 · 01:49<\/time>/);
  assert.match(m008, /<time datetime="2026-07-12T01:51:33\.547Z">01:51 UTC<\/time>/);
  assert.match(m008, /<summary>Redacted stdout<\/summary>/);
  assert.match(m008, /<summary>Redacted stderr<\/summary>/);
  assert.match(m008, /Building tests for @blockly\/plugin-workspace-search/);
  assert.match(m008, /Tried to move a non-movable workspace/);
  assert.doesNotMatch(m001, /run wall \(derived from recorded timestamps\)/);
  assert.doesNotMatch(m001, /unclassified executor time \(derived residual\)/);
  assert.doesNotMatch(m008, /setup \+ install/);
  assert.match(m008, /unclassified executor time \(derived residual\)/);
  assert.match(m008, /<h1>Proof-of-Pass Receipt<\/h1><p class="folio-receipt-id"><span>Receipt ID<\/span> <code>M-008<\/code><\/p>/);
  assert.ok(m008.indexOf('class="proof-hero"') < m008.indexOf('<h2>Code</h2>'));
  assert.match(m008, /class="proof-score">1\/1<\/div>[\s\S]*declared command passed/);
  assert.match(m008, /sha256:d171e1…3fad922/);
  assert.match(m008, /node@sha256:a25c99…127c365/);
  assert.match(m008, /sha256:58c3a6…f0cd64c/);
  assert.match(m008, /sha256:78d812…eb56638/);
  assert.match(m008, /class="evidence-drawer evidence-annex evidence-annex--v1"[\s\S]*Full cryptographic values[\s\S]*sha256:d171e1897e488dbb5f732e13f892ab2380eec800be4d4aea07862dd413fad922/);
  assert.match(m008, /workspace-search buttons need type=button/);
  assert.match(m016, /Public scope interpretation/);
  assert.match(m016, /The declared network-off check runs one focused Vitest spec for Quadlet digest replacement\. It does not run Renovate’s full test, lint, typecheck, or coverage gates\./);
  assert.match(m019, /The focused test inspects generated Swift output\. It does not invoke a Swift compiler or run the full quicktype test suite\./);
  assert.equal((m016.match(/The declared network-off check runs one focused Vitest spec/g) ?? []).length, 1);
  const m016Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-016', 'receipt.json'), 'utf8'));
  const m019Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-019', 'receipt.json'), 'utf8'));
  const m020Json = JSON.parse(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'M-020', 'receipt.json'), 'utf8'));
  const m020Publication = JSON.parse(
    await readFile(path.join(committedMissionsDirectory, 'M-020', 'publication.json'), 'utf8'),
  );
  const m105Publication = JSON.parse(
    await readFile(path.join(committedMissionsDirectory, 'M-105', 'publication.json'), 'utf8'),
  );
  assert.equal(m016Json.scope_note, 'The declared network-off check runs one focused Vitest spec for Quadlet digest replacement. It does not run Renovate’s full test, lint, typecheck, or coverage gates.');
  assert.equal(m019Json.scope_note, 'The focused test inspects generated Swift output. It does not invoke a Swift compiler or run the full quicktype test suite.');
  assert.ok(m020.includes(
    `<strong>PR changed since this record.</strong> Recorded patch commit <code>ffc3e052480163e7338e3164008c6a7a26a77605</code>; current PR head observed <time datetime="${m020Publication.observed_at}">`,
  ));
  assert.ok(m105.includes(
    `<strong>PR changed since this record.</strong> Recorded patch commit <code>a47489b19c182d54b14a0c8d78afda5b1e23864a</code>; current PR head observed <time datetime="${m105Publication.observed_at}">`,
  ));
  assert.match(m105, /<code>486bca786277fc37db65978c98f74188cff11493<\/code>/);
  assert.doesNotMatch(m020, /This receipt tested/);
  assert.equal(m020Json.upstream_outcome.head_drift, true);
  assert.equal(m020Json.upstream_outcome.pr_head_oid, '00d27e70410dc78f0fcda582b987d515dc8b5817');
  assert.doesNotMatch(m016, /OPEN[\s\S]{0,160}Maintainer decision/);
  assert.doesNotMatch(m019, /MERGED[\s\S]{0,160}Maintainer decision/);
  assert.doesNotMatch(m008, /<h3>/);
  assert.match(homepage, /<h3 id="featured-stub-title">Proof-of-Pass Receipt<\/h3>/);
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
  assert.match(m008, /@page \{ margin:8mm; \}/);
  assert.match(m008, /\.receipt:not\(\.receipt--economic\)\s*\{\s*width:72mm/);
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'assets', 'keep.txt'), 'utf8'), 'keep asset\n');
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'receipts', 'legacy', 'index.html'), 'utf8'), 'keep legacy\n');
  assert.equal(await readFile(path.join(temporaryRoot, 'site', 'repo', 'keep--repository', 'index.html'), 'utf8'), 'keep unrelated repository page\n');
  await assert.rejects(access(path.join(temporaryRoot, 'site', 'receipts', 'M-999', 'index.html')), (error) => error.code === 'ENOENT');
  await assert.rejects(access(path.join(temporaryRoot, 'site', 'repo', 'stale--repository')), (error) => error.code === 'ENOENT');

  const externalRepositories = new Map();
  for (const receipt of externalReceipts) {
    const repository = new URL(receipt.target_repo).pathname.replace(/^\//, '');
    const slug = repository.replace('/', '--');
    const list = externalRepositories.get(slug) ?? [];
    list.push(receipt);
    externalRepositories.set(slug, list);
  }
  for (const [slug, receipts] of externalRepositories) {
    const repositoryPage = await readFile(path.join(temporaryRoot, 'site', 'repo', slug, 'index.html'), 'utf8');
    assert.match(repositoryPage, /← Receipt ledger/);
    for (const receipt of receipts) assert.match(repositoryPage, new RegExp(`Receipt ${receipt.mission_id}`));
    const agreement = {
      total: receipts.filter((receipt) => ['success', 'failure'].includes(receipt.publication?.ci_state)).length,
      agreed: receipts.filter((receipt) => receipt.publication?.ci_state === 'success').length,
    };
    assert.match(repositoryPage, new RegExp(`${agreement.agreed} of ${agreement.total}<\\/strong> conclusive runs`));
    const repositoryRequest = repositoryPage.match(/<section class="request-run"[\s\S]*?<\/section>/)?.[0];
    assert.ok(repositoryRequest);
    assert.ok(repositoryRequest.indexOf('request-a-run.yml') < repositoryRequest.indexOf('mailto:oss@northset.ai'));
  }

  const allowedHosts = collectHttpHosts(JSON.parse(await readFile(indexPath, 'utf8')));
  allowedHosts.add('northset.ai');
  const renderedHosts = collectRenderedHttpHosts(`${homepage}\n${m008}`);
  assert.ok(renderedHosts.length > 0);
  for (const host of renderedHosts) assert.ok(allowedHosts.has(host), host);
});

test('render emits deterministic standalone OG SVGs and absolute PNG social metadata for every page', async (t) => {
  const temporaryRoot = await temporaryDirectory(t);
  const indexPath = path.join(committedMissionsDirectory, 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  const firstSite = path.join(temporaryRoot, 'first', 'site');
  const secondSite = path.join(temporaryRoot, 'second', 'site');
  await renderLedger({indexPath, out: path.join(firstSite, 'index.html')});
  await renderLedger({indexPath, out: path.join(secondSite, 'index.html')});

  const expectedSvgNames = ['index.svg', ...index.missions.map(({mission_id: missionId}) => `${missionId}.svg`)].sort();
  const firstSvgNames = (await readdir(path.join(firstSite, 'og'))).filter((name) => name.endsWith('.svg')).sort();
  assert.deepEqual(firstSvgNames, expectedSvgNames);

  const homepageSvg = await readFile(path.join(firstSite, 'og', 'index.svg'), 'utf8');
  assert.equal(homepageSvg, await readFile(path.join(secondSite, 'og', 'index.svg'), 'utf8'));
  assertWellFormedStandaloneSvg(homepageSvg);
  const externalReceipts = index.missions.map(({receipt}) => receipt).filter(({variant}) => variant !== 'own_repo_rehearsal');
  const homepageStats = [
    [externalReceipts.length, 'EXTERNAL RECEIPTS'],
    [externalReceipts.filter(({publication}) => publication?.state === 'merged').length, 'MERGED UPSTREAM'],
    [new Set(externalReceipts.map(({target_repo: targetRepo}) => targetRepo)).size, 'DISTINCT REPOSITORIES'],
    [externalReceipts.filter(({attestation_uri: attestationUri}) => attestationUri !== null).length, 'ATTESTED'],
  ];
  for (const [value, label] of homepageStats) {
    assert.match(homepageSvg, new RegExp(`>${value}<`));
    assert.match(homepageSvg, new RegExp(`>${label}<`));
  }

  const homepage = await readFile(path.join(firstSite, 'index.html'), 'utf8');
  assert.match(homepage, /<meta property="og:image" content="https:\/\/northset-oss\.github\.io\/verification-pilot\/og\/index\.png">/);
  assert.match(homepage, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(homepage, /<meta property="og:url" content="https:\/\/northset-oss\.github\.io\/verification-pilot\/">/);

  for (const {receipt} of index.missions) {
    const relativeSvg = path.join('og', `${receipt.mission_id}.svg`);
    const firstSvg = await readFile(path.join(firstSite, relativeSvg), 'utf8');
    const secondSvg = await readFile(path.join(secondSite, relativeSvg), 'utf8');
    assert.equal(firstSvg, secondSvg, receipt.mission_id);
    assertWellFormedStandaloneSvg(firstSvg);
    const repositoryCharacters = Array.from(new URL(receipt.target_repo).pathname.replace(/^\/+/, ''));
    const repository = repositoryCharacters.length <= 40
      ? repositoryCharacters.join('')
      : `${repositoryCharacters.slice(0, 39).join('')}…`;
    assert.ok(firstSvg.includes(receipt.mission_id), receipt.mission_id);
    assert.ok(firstSvg.includes(repository), repository);
    assert.ok(firstSvg.includes(`${receipt.successful_checks}/${receipt.declared_checks}`), receipt.mission_id);
    assert.ok(firstSvg.includes(`declared command${receipt.declared_checks === 1 ? '' : 's'} passed`), receipt.mission_id);
    assert.ok(firstSvg.includes(receipt.classification), receipt.mission_id);
    if (receipt.publication?.state) assert.ok(firstSvg.includes(receipt.publication.state.toUpperCase().replaceAll('_', ' ')));

    const page = await readFile(path.join(firstSite, 'receipts', receipt.mission_id, 'index.html'), 'utf8');
    const expectedPng = `https://northset-oss.github.io/verification-pilot/og/${receipt.mission_id}.png`;
    assert.ok(page.includes(`<meta property="og:image" content="${expectedPng}">`), receipt.mission_id);
    assert.ok(page.includes('<meta name="twitter:card" content="summary_large_image">'), receipt.mission_id);
    assert.ok(page.includes(`<meta name="twitter:image" content="${expectedPng}">`), receipt.mission_id);
    assert.ok(page.includes(`<meta property="og:url" content="${receipt.canonical_url}">`), receipt.mission_id);
  }
});
