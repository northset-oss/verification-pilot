import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'bin/ledger.mjs');
const missionsDirectory = path.join(root, 'test/fixtures/ledger/missions');
const generatedAt = '2026-07-15T00:00:00Z';
const headerSentence = 'A run record is evidence of declared execution metadata and artifacts. It is not proof of code quality, security, maintainer approval, or production readiness.';
const footerSentence = 'Self-funded field-testing. The reported signal is the external maintainer decision, which Northset does not control.';

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
  assert.match(html, /<title>Northset OSS Run Records<\/title>/);
  assert.ok(html.includes(headerSentence));
  assert.ok(html.includes(footerSentence));
  for (const mission of index.missions) assert.ok(html.includes(mission.mission_id));

  assert.doesNotMatch(html, /<script\s+src\s*=/i);
  assert.doesNotMatch(html, /<link\s+[^>]*rel=["']stylesheet["'][^>]*href\s*=/i);
  assert.doesNotMatch(html, /\b(?:cdn|googleapis)\b/i);
  assert.doesNotMatch(html, /\bfetch\s*\(/);

  const allowedHosts = collectHttpHosts(index);
  const renderedHosts = [...html.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
    .map((match) => match[1]);
  assert.ok(renderedHosts.length > 0);
  for (const host of renderedHosts) assert.ok(allowedHosts.has(host), host);

  assert.doesNotMatch(html, /<script>alert\(/);
  assert.ok(html.includes('\\u003cscript\\u003e'));
  const dataBlock = html.match(/<script type="application\/json" id="ledger-data">([\s\S]*?)<\/script>/);
  assert.ok(dataBlock);
  const inlinedIndex = JSON.parse(dataBlock[1]);
  assert.deepEqual(inlinedIndex, index);
  assert.match(inlinedIndex.missions[2].target_repo, /<script>.*"quoted"/);
  assert.match(inlinedIndex.missions[2].disclosure_label, /<script>.*<\/script>/);

  assert.match(html, /overflow-x: auto/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.ok(html.includes("document.createElement('code')"));
  assert.ok(html.includes('gh attestation verify <bundle> --owner northset-oss'));
});
