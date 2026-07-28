import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ledgerCli = path.join(repositoryRoot, 'bin/ledger.mjs');
const generatedAt = '2026-07-15T00:00:00Z';
const publicRequestUrl = 'https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml';

async function renderFixtureSite(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-conversion-surfaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, 'index.json');
  const htmlPath = path.join(root, 'index.html');
  const build = spawnSync(process.execPath, [
    ledgerCli,
    'build',
    '--missions-dir',
    path.join(repositoryRoot, 'test/fixtures/ledger/missions'),
    '--out',
    indexPath,
    '--now',
    generatedAt,
    '--allow-skips',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const render = spawnSync(process.execPath, [
    ledgerCli,
    'render',
    '--index',
    indexPath,
    '--out',
    htmlPath,
    '--now',
    generatedAt,
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(render.status, 0, render.stderr);
  return root;
}

function decodeAttribute(value) {
  return value.replaceAll('&amp;', '&');
}

function assertCompleteRequestCta(html, repository = null) {
  assert.match(html, /<section class="request-run"/);
  if (repository === null) {
    assert.match(html, /<h2[^>]*>Request a private run<\/h2>/);
    assert.match(html, /Maintain an open-source project\?/);
    assert.match(html, /repository-declared checks/);
    assert.match(html, /Nothing is published without your approval\./);
    assert.match(html, /Free during the pilot\./);
  } else {
    assert.ok(html.includes(`<h2 id="request-run-title">Maintain ${repository}?</h2>`));
    assert.match(html, /Get this same run for any PR in your queue — private, free during the pilot, nothing published without your approval\./);
  }
  assert.match(html, /Open a public request/);
  assert.ok(html.includes(publicRequestUrl.replaceAll('&', '&amp;')));
  assert.ok(
    html.indexOf(publicRequestUrl.replaceAll('&', '&amp;')) < html.indexOf('mailto:oss@northset.ai'),
    'the public issue-template CTA must precede the private email CTA',
  );
  assert.match(html, /northset-verify/);
  assert.doesNotMatch(html, /run the proof/i);

  const match = html.match(/href="(mailto:oss@northset\.ai\?[^\"]+)"/);
  assert.ok(match, 'CTA must contain a prefilled email request');
  const mailto = new URL(decodeAttribute(match[1]));
  assert.equal(mailto.protocol, 'mailto:');
  assert.equal(mailto.pathname, 'oss@northset.ai');
  assert.equal(
    mailto.searchParams.get('subject'),
    repository === null
      ? 'Northset run request: owner/repository#123'
      : `Northset run request: ${repository}`,
  );
  assert.equal(mailto.searchParams.get('body'), [
    'PR URL:',
    'Repository:',
    'I am a maintainer or authorized representative:',
    'Checks to run, if different from repo defaults:',
    'Anything Northset should know:',
  ].join('\n'));
}

test('ledger and every permanent receipt page expose a complete, modest conversion CTA', async (t) => {
  const root = await renderFixtureSite(t);
  const homepage = await readFile(path.join(root, 'index.html'), 'utf8');
  assertCompleteRequestCta(homepage);
  assert.match(homepage, /class="button-link mast-request request-primary"[^>]*>Open a public request<\/a>/);
  assert.match(homepage, /@media print[^}]*[\s\S]*\.request-run/);

  for (const [missionId, repository] of [
    ['M-001', 'northset/oss-run-records'],
    ['M-004', 'maintainer/project'],
    ['M-005', 'project/%3Cscript%3Ealert(1)%3C/script%3E'],
  ]) {
    const receipt = await readFile(path.join(root, 'receipts', missionId, 'index.html'), 'utf8');
    assertCompleteRequestCta(receipt, repository);
  }
});

test('dedicated request form is public, private-by-default, and captures authorization', async () => {
  const form = await readFile(
    path.join(repositoryRoot, '.github/ISSUE_TEMPLATE/request-a-run.yml'),
    'utf8',
  );
  assert.match(form, /^name: Request a run$/m);
  assert.match(form, /^labels:\s*\["run-request"\]$/m);
  assert.match(form, /This issue is public/);
  assert.match(form, /Do not include secrets/);
  for (const id of [
    'pr_url',
    'repository',
    'relationship',
    'requested_checks',
    'private_by_default',
    'publish_later',
    'preferred_contact',
    'consent',
  ]) {
    assert.match(form, new RegExp(`^- type: [^\\n]+\\n  id: ${id}$`, 'm'), id);
  }
  assert.match(form, /options:\n      - Maintainer\n      - Authorized organization member\n      - Other/);
  assert.match(form, /id: private_by_default[\s\S]*?options:\n      - "Yes"\n      - "No"[\s\S]*?default: 0/);
  assert.match(form, /Nothing is published without my additional approval/);
  assert.match(form, /id: consent[\s\S]*?required: true/);
});

test('future signed-bundle releases carry the restrained private-run footer', async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, '.github/workflows/attest-bundle.yml'),
    'utf8',
  );
  assert.match(workflow, /Maintain an open-source project\? Request a private run for a PR already in your queue at oss@northset\.ai\./);
  assert.match(workflow, /Nothing is published without your approval\./);
  assert.doesNotMatch(workflow, /run the proof/i);
});

test('private email requests have an equivalent consent-evidence procedure without public copying', async () => {
  const procedure = await readFile(
    path.join(repositoryRoot, 'docs/run-request-intake.md'),
    'utf8',
  );
  assert.match(procedure, /public issue itself is the consent artifact/i);
  assert.match(procedure, /preserve the original correspondence/i);
  assert.match(procedure, /do not copy.*private correspondence.*public/i);
  assert.match(procedure, /maintainer or authorized representative/i);
  assert.match(procedure, /separate[\s\S]*publication approval/i);
  assert.match(procedure, /stop or withdrawal/i);
});
