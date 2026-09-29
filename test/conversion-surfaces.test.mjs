import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const ledgerCli = path.join(repositoryRoot, 'bin/ledger.mjs');
const generatedAt = '2026-07-15T00:00:00Z';

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

function assertPilotEndedNotice(html) {
  const notice = html.match(/<section class="pilot-ended"[\s\S]*?<\/section>/)?.[0];
  assert.ok(notice);
  assert.match(notice, /<p class="eyebrow">PILOT ENDED<\/p>/);
  assert.match(notice, /<h2 id="pilot-ended-title">This pilot has ended<\/h2>/);
  assert.match(notice, /Northset ran this pilot from July 10 to July 28, 2026\./);
  assert.match(notice, /The receipts here record checks Northset ran on its own pull requests and on rehearsals, and they are kept unchanged as published\./);
  assert.match(notice, /Northset no longer takes run requests or publishes new receipts\./);
  assert.match(notice, /To have an entry removed, email <a href="mailto:oss@northset\.ai">oss@northset\.ai<\/a>\./);
  assert.doesNotMatch(html, /Maintain [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\?|Request a private run|Email a private request|Open a public request|northset-verify|request-a-run|FOR MAINTAINERS/);
}

test('ledger and every permanent receipt page show the ended notice without run requests', async (t) => {
  const root = await renderFixtureSite(t);
  const homepage = await readFile(path.join(root, 'index.html'), 'utf8');
  assertPilotEndedNotice(homepage);
  assert.match(homepage, /@media print[^}]*[\s\S]*\.pilot-ended/);

  for (const missionId of ['M-001', 'M-004', 'M-005']) {
    const receipt = await readFile(path.join(root, 'receipts', missionId, 'index.html'), 'utf8');
    assertPilotEndedNotice(receipt);
  }
});

test('public run-request form has been removed', async () => {
  await assert.rejects(
    access(path.join(repositoryRoot, '.github/ISSUE_TEMPLATE/request-a-run.yml')),
    (error) => error.code === 'ENOENT',
  );
});

test('future signed-bundle releases do not invite run requests', async () => {
  const workflow = await readFile(
    path.join(repositoryRoot, '.github/workflows/attest-bundle.yml'),
    'utf8',
  );
  assert.doesNotMatch(workflow, /Maintain an open-source project\? Request a private run/);
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
