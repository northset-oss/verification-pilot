import assert from 'node:assert/strict';
import {access, readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('public site contains no acquisition surface or repository aggregate', async () => {
  const files = [
    'site/index.html',
    'site/receipts/M-004/index.html',
    'site/receipts/M-012/index.html',
    'site/ledger.json',
  ];
  for (const relative of files) {
    const source = await readFile(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /mailto:|request-a-run\.yml|northset-verify|(?:href|src)=["'](?:\/|(?:\.\.\/)*)repo\//i, relative);
  }
  await assert.rejects(access(path.join(root, 'site/repo')), (error) => error.code === 'ENOENT');
});

test('run-request template and release solicitation are removed', async () => {
  await assert.rejects(
    access(path.join(root, '.github/ISSUE_TEMPLATE/request-a-run.yml')),
    (error) => error.code === 'ENOENT',
  );
  const release = await readFile(path.join(root, '.github/workflows/attest-bundle.yml'), 'utf8');
  assert.doesNotMatch(release, /request a private run|oss@northset\.ai/i);
});

test('consent documentation defines four independent fail-closed scopes', async () => {
  const source = await readFile(path.join(root, 'docs/run-request-intake.md'), 'utf8');
  for (const scope of [
    'contribution_invitation',
    'verification_execution_consent',
    'receipt_publication_consent',
    'marketing_reference_consent',
  ]) assert.match(source, new RegExp(scope));
  assert.match(source, /fails closed/i);
  assert.match(source, /never a separate decision|always a separate decision/i);
});
