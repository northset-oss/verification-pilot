import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createBundle, validatePublicConsent, validateRunRecord, verifyBundle } from '../lib/bundle.mjs';
import { redactText } from '../lib/redact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = path.join(root, 'test/fixtures/bundle');

async function tempFixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'northset-hardening-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const missionDir = path.join(rootDir, 'sample');
  await cp(path.join(fixtures, 'sample'), missionDir, { recursive: true });
  await createBundle(missionDir, {
    stdoutFile: path.join(missionDir, 'stdout.txt'),
    stderrFile: path.join(missionDir, 'stderr.txt'),
    runRecordFile: path.join(missionDir, 'run_record.json'),
    createdAt: '2026-07-14T14:00:00Z',
  });
  return missionDir;
}

async function rewriteManifest(missionDir) {
  const bundleDir = path.join(missionDir, 'bundle');
  const names = (await readdir(bundleDir)).filter((name) => name !== 'bundle.manifest.json').sort();
  const files = [];
  for (const name of names) {
    const bytes = await readFile(path.join(bundleDir, name));
    files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength });
  }
  const digestInput = files.map((file) => `${file.path}\0${file.sha256}\n`).join('');
  await writeFile(path.join(bundleDir, 'bundle.manifest.json'), `${JSON.stringify({
    version: '0', created_at: '2026-07-14T14:00:00Z', files,
    bundle_digest: `sha256:${createHash('sha256').update(digestInput).digest('hex')}`,
  }, null, 2)}\n`);
}

test('bundle verification rejects semantically forged but hash-consistent contents', async (t) => {
  const missionDir = await tempFixture(t);
  const bundledMissionFile = path.join(missionDir, 'bundle/mission.json');
  const mission = JSON.parse(await readFile(bundledMissionFile, 'utf8'));
  mission.commands_declared = ['forged command'];
  await writeFile(bundledMissionFile, `${JSON.stringify(mission, null, 2)}\n`);
  await rewriteManifest(missionDir);
  const verified = await verifyBundle(missionDir);
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some(({ kind }) => kind === 'semantic'));
});

test('bundle verification rejects symlink members even when their bytes match the manifest', async (t) => {
  const missionDir = await tempFixture(t);
  const target = path.join(missionDir, 'bundle/stdout-target.txt');
  const member = path.join(missionDir, 'bundle/stdout_redacted.txt');
  await writeFile(target, 'safe\n');
  await unlink(member);
  await symlink('stdout-target.txt', member);
  const verified = await verifyBundle(missionDir);
  assert.equal((await lstat(member)).isSymbolicLink(), true);
  assert.equal(verified.ok, false);
  assert.ok(verified.issues.some(({ kind }) => kind === 'type'));
});

test('schema-v1 run records retain exact environment and time/duration invariants', () => {
  const record = {
    schema_version: 1,
    started_at: '2026-07-14T14:00:02Z',
    finished_at: '2026-07-14T14:00:01Z',
    environment: {
      executor_profile: 'node', container_image_ref: 'node:20-bookworm',
      container_image_digest: null, container_image_id: `sha256:${'a'.repeat(64)}`,
      container_os: 'linux', container_architecture: 'amd64', network_policy: 'phaseA:bridge,phaseB:none',
      source_commit: null, base_tree_digest: `sha256:${'b'.repeat(64)}`,
      pre_check_tree_digest: `sha256:${'b'.repeat(64)}`, approved_tracked_tree_digest: null,
      post_check_tree_digest: `sha256:${'b'.repeat(64)}`, check_tree_changed: false,
      patch_sha256: null, install_commands: [],
    },
    commands: [{ cmd: 'node --test', exit_code: 0, duration_ms: -1 }],
    notes: null,
  };
  const invalid = validateRunRecord(record);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(({ ruleId }) => ruleId === 'RUN_RECORD_TIME_ORDER'));
  assert.ok(invalid.errors.some(({ ruleId }) => ruleId === 'RUN_RECORD_RANGE'));
});

test('future public consent receipts require explicit publication consent', () => {
  const mission = {
    mission_id: 'M-004', variant: 'V',
    consent_artifact: 'https://example.com/maintainer/project/consent/42',
  };
  const consent = {
    schema_version: 1,
    mission_id: 'M-004',
    variant: 'V',
    consent_artifact: mission.consent_artifact,
    granted_at: '2026-07-09T11:00:00Z',
    granted_by: 'fixture maintainer',
    scope: ['run the declared verification commands'],
  };
  assert.equal(validatePublicConsent(consent, mission).valid, false);
  assert.equal(validatePublicConsent({ ...consent, publication_consent: true }, mission).valid, true);
  assert.equal(validatePublicConsent({ ...consent, publication_consent: false }, mission).valid, false);
});

test('JWT redaction requires a JWT-shaped header/payload and preserves ordinary dotted identifiers', () => {
  const ordinary = 'packages.abcdefgh.module.exports and abcdefgh.ijklmnop.qrstuvwx';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const redactions = {};
  const result = redactText(`${ordinary}\n${jwt}\n`, redactions);
  assert.match(result, new RegExp(ordinary.replaceAll('.', '\\.')));
  assert.doesNotMatch(result, new RegExp(jwt.replaceAll('.', '\\.')));
  assert.deepEqual(redactions, { jwt: 1 });
});

test('CI and signing use the successful-CI handoff while Pages merges factory proof into the canonical ledger', async () => {
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const attest = await readFile(path.join(root, '.github/workflows/attest-bundle.yml'), 'utf8');
  const pages = await readFile(path.join(root, '.github/workflows/pages.yml'), 'utf8');
  const receiptSignal = await readFile(path.join(root, '.github/workflows/receipt-pages-source.yml'), 'utf8');
  for (const workflow of [ci, attest, pages, receiptSignal]) assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
  assert.match(ci, /github\.event\.before.*github\.sha|github\.sha.*github\.event\.before/s);
  assert.match(ci, /upload-artifact@([0-9a-f]{40})/);
  for (const workflow of [attest, pages]) {
    assert.match(workflow, /workflow_run:/);
    assert.match(workflow, /conclusion\s*==\s*'success'/);
    assert.doesNotMatch(workflow, /workflow_dispatch:/);
  }
  assert.match(pages, /workflows:\s*\["ci", "receipt-pages-source"\]/);
  assert.match(pages, /branches:\s*\[main, receipts\]/);
  assert.doesNotMatch(pages, /\n\s{2}push:/);
  assert.match(pages, /workflow_run\.name == 'ci'.*workflow_run\.head_branch == 'main'/s);
  assert.match(pages, /workflow_run\.name == 'receipt-pages-source'.*workflow_run\.head_branch == 'receipts'/s);
  assert.match(pages, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/heads\/main" --jq \.object\.sha/);
  assert.match(pages, /ref: \$\{\{ steps\.ledger-source\.outputs\.sha \}\}/);
  assert.match(pages, /git -C source rev-parse HEAD.*EXPECTED_LEDGER_SHA/);
  assert.match(pages, /gh api "repos\/\$GITHUB_REPOSITORY\/git\/ref\/heads\/receipts" --jq \.object\.sha/);
  assert.match(pages, /ref: \$\{\{ steps\.receipt-source\.outputs\.sha \}\}/);
  assert.match(pages, /git -C factory-proof-source rev-parse HEAD.*EXPECTED_RECEIPTS_SHA/);
  assert.match(pages, /node source\/bin\/factory-receipts\.mjs merge/);
  assert.match(pages, /--receipts-revision "\$EXPECTED_RECEIPTS_SHA"/);
  assert.match(pages, /--index source\/missions\/index\.json/);
  assert.match(pages, /node source\/bin\/ledger\.mjs render/);
  assert.doesNotMatch(pages, /compact-receipts|compact-index/);
  assert.match(pages, /path: source\/site/);
  assert.match(receiptSignal, /branches:\s*\[receipts\]/);
  assert.match(receiptSignal, /permissions:\s*\{\}/);
  assert.match(receiptSignal, /test "\$GITHUB_REF" = "refs\/heads\/receipts"/);
  assert.doesNotMatch(receiptSignal, /environment:|pages:\s*write|id-token:\s*write|actions\/checkout|workflow_dispatch|repository_dispatch/);
  assert.match(attest, /download-artifact@([0-9a-f]{40})/);
  assert.doesNotMatch(attest, /actions\/checkout/);
});

test('governance, security, third-party attribution, ownership, and public consent schema are committed', async () => {
  for (const file of ['GOVERNANCE.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md', '.github/CODEOWNERS', 'schema/public-consent.schema.json']) {
    await readFile(path.join(root, file), 'utf8');
  }
  assert.match(await readFile(path.join(root, 'SECURITY.md'), 'utf8'), /oss@northset\.ai/);
  assert.match(await readFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), /not relicensed|not.*relicensed/i);
  assert.match(await readFile(path.join(root, 'docs/executor.md'), 'utf8'), /COREPACK_HOME.*NPM_CONFIG_CACHE.*XDG_CACHE_HOME.*XDG_DATA_HOME/s);
  assert.match(await readFile(path.join(root, '.github/CODEOWNERS'), 'utf8'), /@AysajanE/);
});
