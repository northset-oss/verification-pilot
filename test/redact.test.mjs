import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { redactJsonStrings, redactText, sortRedactions } from '../lib/redact.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'test/fixtures/bundle/redaction-leaks.txt');

test('redacts every required secret class and reports exact counts', async () => {
  const source = await readFile(fixture, 'utf8');
  const redactions = {};
  const redacted = redactText(source, redactions);
  const secrets = [
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
    'AKIA1234567890ABCDEF',
    'super-secret-private-key-body',
    'dXNlcjpwYXNz',
    'bearer-secret-value',
    'alice:hunter2',
    'one-secret',
    'two-secret',
    'three-secret',
    'four-secret',
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'env-password-value',
    'person@example.org',
    '/Users/alice/',
    '/home/bob/',
  ];

  for (const secret of secrets) assert.equal(redacted.includes(secret), false, secret);
  assert.deepEqual(sortRedactions(redactions), {
    authorization: 1,
    aws_access_key: 1,
    bearer: 1,
    email: 1,
    env: 1,
    github_token: 1,
    hex_private_key: 1,
    path: 2,
    private_key: 1,
    url_query: 4,
    url_userinfo: 1,
  });
  assert.match(redacted, /ops@northset\.ai/);
  assert.match(redacted, /abcdefgh\.ijklmnop\.qrstuvwx/);
  assert.match(redacted, /0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
});

test('over-redacts 0x-prefixed sha256-shaped values but preserves digest fields', async () => {
  const source = await readFile(fixture, 'utf8');
  const redactions = {};
  const redacted = redactText(source, redactions);

  assert.match(redacted, /\[REDACTED:hex_private_key\]/);
  assert.match(redacted, /sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.equal(redactions.hex_private_key, 1);
});

test('redacts string values recursively without changing keys or scalar types', () => {
  const redactions = {};
  const input = {
    token_label: 'gho_1234567890ABCDEFGHIJ',
    nested: ['person@example.net', 7, null, { allowed: 'team@northset.ai' }],
  };

  assert.deepEqual(redactJsonStrings(input, redactions), {
    token_label: '[REDACTED:github_token]',
    nested: ['[REDACTED:email]', 7, null, { allowed: 'team@northset.ai' }],
  });
  assert.deepEqual(redactions, { github_token: 1, email: 1 });
  assert.equal(input.token_label, 'gho_1234567890ABCDEFGHIJ');
});

test('preserves npm package versions and dotted Java provider names', () => {
  const source = '@eslint/eslintrc@3.3.1 org.apache.maven.surefire.booter.ForkedBooter\n';
  const redactions = {};
  assert.equal(redactText(source, redactions), source);
  assert.deepEqual(redactions, {});
});
