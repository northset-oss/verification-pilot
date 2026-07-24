import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('attestation workflow consumes only a successful CI handoff and publishes immutable digest-qualified assets', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/attest-bundle.yml'), 'utf8');
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d+/);
  assert.doesNotMatch(workflow, /--clobber/);
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /conclusion == 'success'/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /bundle_digest|BUNDLE_DIGEST/);
  assert.match(workflow, /run-record-\$\{mission\}-\[0-9a-f\]\{12\}/);
});

test('CI proves every committed public receipt passed before checking generated output', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /node bin\/verify-proof-of-pass\.mjs/);
  assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(workflow, /github\.event\.before/);
  assert.match(workflow, /node bin\/publication-policy\.mjs validate/);
  assert.doesNotMatch(workflow, /pr-disclosure:|pr-receipt-disclosure\.mjs/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write|issues:\s*write/);
});
