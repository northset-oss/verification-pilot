import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('attestation workflow pins actions and publishes immutable digest-qualified assets', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/attest-bundle.yml'), 'utf8');
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /bundle_digest|BUNDLE_DIGEST/);
  assert.match(workflow, /run-record-\$\{?M\}?-[^\n]*DIGEST|run-record-\$M-[^\n]*DIGEST/);
  assert.match(workflow, /node bin\/verify-proof-of-pass\.mjs "missions\/\$\{M\}"/);
});

test('CI proves every committed public receipt passed before checking generated output', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node bin\/verify-proof-of-pass\.mjs/);
});
