import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditAllDisclosures,
  auditAllFactoryDisclosures,
  auditMissionDisclosure,
  canonicalReceiptUrl,
  createFetchRequest,
  renderDisclosureBlock,
  syncFactoryDisclosure,
  syncMissionDisclosure,
  upsertDisclosureBlock,
  validateDisclosurePolicy,
} from '../lib/pr-receipt-disclosure.mjs';
import { runPrReceiptDisclosureCli } from '../bin/pr-receipt-disclosure.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

const policy = {
  schema_version: 2,
  canonical_receipt_base_url: 'https://northset-oss.github.io/verification-pilot/receipts/',
  legacy_ledger_base_url: 'https://northset-oss.github.io/verification-pilot/',
  current_block_schema_version: 2,
  historical_exempt_mission_ids: [
    'M-007', 'M-008', 'M-009', 'M-011', 'M-012',
    'M-014', 'M-015', 'M-016', 'M-019', 'M-020',
  ],
  factory_block_schema_versions: { 'M-1001': 1 },
  northset_actor_logins: ['AysajanE'],
};

function mission(missionId = 'M-021') {
  return {
    mission_id: missionId,
    variant: 'author_contribution',
    patch_commit: 'abcdef0123456789abcdef0123456789abcdef01',
    commands_declared: ['node --test test/focused.test.mjs'],
  };
}

function publication(missionId = 'M-021', overrides = {}) {
  return {
    mission_id: missionId,
    state: 'open',
    pr_number: 21,
    pr_url: 'https://github.com/example/project/pull/21',
    pr_disclosure: {
      schema_version: 2,
      required: true,
      mode: 'pr_body',
      canonical_url: canonicalReceiptUrl(policy, missionId),
      verified_at: '2026-07-14T16:00:00Z',
    },
    ...overrides,
  };
}

function response(status, json = null, headers = {}) {
  return { status, json, headers };
}

function fakeRequest(routes) {
  const calls = [];
  const request = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    calls.push({ url, method, body: options.body });
    const key = `${method} ${url}`;
    const route = routes.get(key);
    if (typeof route === 'function') return route(options);
    if (route === undefined) throw new Error(`unexpected request: ${key}`);
    return route;
  };
  request.calls = calls;
  return request;
}

async function writeFactoryDisclosureFixture(root, {
  missionId,
  commitOid,
  prState,
  command,
  blockVersion = 2,
  includeNoCiChange = false,
  bodyState = null,
}) {
  const prNumber = Number(missionId.slice(2));
  const receiptUrl = canonicalReceiptUrl(policy, missionId);
  const prUrl = `https://github.com/example/project/pull/${prNumber}`;
  const proof = blockVersion === 1
    ? {
      schema_version: 1,
      mission_id: missionId,
      repository: 'example/project',
      issue_number: prNumber,
      commit_oid: commitOid,
      tested_tree_oid: 'b'.repeat(40),
      patched_observation: { exit_code: 0 },
    }
    : {
      schema_version: 2,
      mission_id: missionId,
      repository: 'example/project',
      issue_number: prNumber,
      commit_oid: commitOid,
      tested_tree_oid: 'b'.repeat(40),
      patched_observation: { command, exit_code: 0 },
      checks: ['declared check passed'],
      claim: { type: 'regression_fix', statement: 'regression_fix' },
      batch_approval_digest: `sha256:${'c'.repeat(64)}`,
      environment: { network: 'none' },
      executed_commands: [],
      checks_not_run: [],
      limitations: [],
    };
  const proofBytes = Buffer.from(`${JSON.stringify(proof)}\n`);
  const proofSha256 = `sha256:${createHash('sha256').update(proofBytes).digest('hex')}`;
  const selectedDir = path.join(root, missionId, commitOid);
  await mkdir(selectedDir, { recursive: true });
  const proofFile = path.join(selectedDir, 'proof.json');
  const currentFile = path.join(root, missionId, 'current.json');
  const publicationFile = path.join(selectedDir, 'publication.json');
  await Promise.all([
    writeFile(proofFile, proofBytes),
    writeFile(currentFile, `${JSON.stringify({
      schema_version: 1,
      mission_id: missionId,
      contribution_commit_oid: commitOid,
      proof_sha256: proofSha256,
    })}\n`),
    writeFile(publicationFile, `${JSON.stringify({
      schema_version: blockVersion === 1 ? 1 : 2,
      mission_id: missionId,
      contribution_commit_oid: commitOid,
      pr_head_oid: commitOid,
      merge_commit_oid: prState === 'MERGED' ? 'd'.repeat(40) : null,
      receipt_url: receiptUrl,
      pr_url: prUrl,
      pr_number: prNumber,
      pr_state: prState,
      merged: prState === 'MERGED',
      ci_state: 'SUCCESS',
      attestation_state: 'RECEIPT_ATTESTED',
      attestation_url: 'https://api.github.com/example/attestation',
      observed_at: '2026-07-21T00:00:00Z',
    })}\n`),
  ]);
  const publicationState = prState === 'MERGED'
    ? 'merged'
    : prState === 'CLOSED' ? 'closed_unmerged' : 'open';
  const body = renderDisclosureBlock({
    missionId,
    receiptUrl,
    publicationState: bodyState ?? publicationState,
    blockVersion,
    command,
    headOid: commitOid,
    includeNoCiChange,
  });
  return {
    missionId,
    currentFile,
    proofFile,
    publicationFile,
    receiptUrl,
    prApi: `https://api.github.com/repos/example/project/pulls/${prNumber}`,
    commentsApi: `https://api.github.com/repos/example/project/issues/${prNumber}/comments?per_page=100`,
    prNumber,
    prUrl,
    body,
  };
}

test('disclosure policy is exact, future-safe, and produces canonical per-receipt URLs', () => {
  assert.equal(validateDisclosurePolicy(policy), policy);
  assert.equal(
    canonicalReceiptUrl(policy, 'M-021'),
    'https://northset-oss.github.io/verification-pilot/receipts/M-021/',
  );
  assert.equal(
    canonicalReceiptUrl(policy, 'M-1000'),
    'https://northset-oss.github.io/verification-pilot/receipts/M-1000/',
  );
  assert.equal(
    canonicalReceiptUrl(policy, 'M-E2a'),
    'https://northset-oss.github.io/verification-pilot/receipts/M-E2a/',
  );
  assert.throws(
    () => validateDisclosurePolicy({ ...policy, surprise: true }),
    /surprise.*allowed|allowed.*surprise/i,
  );
  assert.throws(
    () => validateDisclosurePolicy({ ...policy, historical_exempt_mission_ids: ['M-020', 'M-020'] }),
    /unique/i,
  );
  assert.throws(
    () => validateDisclosurePolicy({ ...policy, factory_block_schema_versions: { 'M-1001': 3 } }),
    /factory_block_schema_versions.*1 or 2/i,
  );
  assert.throws(
    () => canonicalReceiptUrl(policy, '../M-021'),
    /mission id/i,
  );
});

test('receipt disclosure block is state-specific, marked, and idempotently replaceable', () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const facts = { command: ['node', '--test', 'test/focused.test.mjs'], headOid: 'abcdef0123456789abcdef0123456789abcdef01' };
  const block = renderDisclosureBlock({
    missionId: 'M-021', receiptUrl, publicationState: 'open', ...facts, includeNoCiChange: true,
  });
  assert.equal(block, `<!-- northset-receipt:M-021:start -->
### Verification

\`node --test test/focused.test.mjs\` exited 0 on this exact head (\`abcdef0\`) in a network-off container, before this PR was opened.
No workflow or CI files are modified in this change.
Commands, environment, and hashes: [receipt M-021](${receiptUrl}) — checkable in ~30 seconds without trusting us.
Self-run by the contributor, not maintainer verification.
<!-- northset-receipt:M-021:end -->`);
  assert.doesNotMatch(block, /request a separate, private run/i);
  assert.equal(block.split(receiptUrl).length - 1, 1);
  assert.doesNotMatch(block, /badge|logo|attestation/i);

  const merged = renderDisclosureBlock({
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'merged',
    ...facts,
  });
  assert.match(merged, /This record covers Northset's own contribution; it is not maintainer verification\./);
  assert.match(merged, /Maintainers: request a separate private run for any PR in your queue — open a run request: https:\/\/github\.com\/northset-oss\/verification-pilot\/issues\/new\?template=request-a-run\.yml or email oss@northset\.ai\./);
  assert.match(merged, /adding `northset-verify` to a PR requests a run on that PR\./);
  assert.equal((merged.match(/request a separate private run/g) ?? []).length, 1);

  const closed = renderDisclosureBlock({
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'closed_unmerged',
    ...facts,
  });
  assert.doesNotMatch(closed, /request a separate, private run/i);

  const first = upsertDisclosureBlock('## Summary\n\nFocused fix.', {
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'open',
    ...facts,
  });
  assert.equal(first.changed, true);
  assert.equal(first.body.split(receiptUrl).length - 1, 1);
  const second = upsertDisclosureBlock(first.body, {
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'open',
    ...facts,
  });
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);

  assert.throws(
    () => upsertDisclosureBlock(`Existing unmarked ${receiptUrl}`, {
      missionId: 'M-021',
      receiptUrl,
      publicationState: 'open',
      ...facts,
    }),
    /unmarked/i,
  );
  assert.throws(
    () => upsertDisclosureBlock('<!-- northset-receipt:M-099:start -->\nold\n<!-- northset-receipt:M-099:end -->', {
      missionId: 'M-021',
      receiptUrl,
      publicationState: 'open',
      ...facts,
    }),
    /different mission/i,
  );

  const long = renderDisclosureBlock({
    missionId: 'M-021', receiptUrl, publicationState: 'open', headOid: facts.headOid,
    command: `node --test ${'deep/path/'.repeat(10)}focused.test.mjs`,
  });
  assert.match(long, /the repository's declared test command exited 0/);
  assert.doesNotMatch(long, /No workflow or CI files are modified/);

  const legacy = renderDisclosureBlock({
    missionId: 'M-021', receiptUrl, publicationState: 'open', blockVersion: 1,
  });
  assert.match(legacy, /Northset proof-of-pass receipt M-021/);
  assert.match(legacy, /Contributor self-run; not maintainer verification\./);
});

test('live audit requires one canonical body link, a live receipt, and no Northset receipt comment', async () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  const body = renderDisclosureBlock({
    missionId: 'M-021', receiptUrl, publicationState: 'open',
    command: mission().commands_declared[0], headOid: mission().patch_commit,
  });
  const request = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));

  const report = await auditMissionDisclosure({
    mission: mission(),
    publication: publication(),
    policy,
    request,
  });
  assert.deepEqual(report, {
    mission_id: 'M-021',
    status: 'verified',
    canonical_url: receiptUrl,
    body_occurrences: 1,
    legacy_occurrences: 0,
    actor_comment_occurrences: 0,
  });

  const bodyWithNoCiClaim = renderDisclosureBlock({
    missionId: 'M-021', receiptUrl, publicationState: 'open',
    command: mission().commands_declared[0], headOid: mission().patch_commit,
    includeNoCiChange: true,
  });
  const withConditionalLine = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body: bodyWithNoCiClaim })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: withConditionalLine });

  const missing = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body: 'No receipt.' })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: missing }),
    /exactly once/i,
  );

  const legacy = `${policy.legacy_ledger_base_url}#M-021`;
  const legacyRequest = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body: `${body}\n${legacy}` })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: legacyRequest }),
    /legacy/i,
  );

  const promotionalRequest = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, {
      number: 21,
      html_url: publication().pr_url,
      body: `${body}\nMore: ${policy.legacy_ledger_base_url}`,
    })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: promotionalRequest }),
    /exactly 1 Northset URL/i,
  );

  const commentRequest = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body })],
    [`GET ${commentsApi}`, response(200, [{ user: { login: 'AysajanE' }, body: receiptUrl }])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: commentRequest }),
    /comment/i,
  );

  const unavailable = fakeRequest(new Map([[`GET ${receiptUrl}`, response(404)]]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: unavailable }),
    /receipt.*200/i,
  );
});

test('live audit enforces the merged-only invitation exactly once', async () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  const mergedPublication = publication('M-021', { state: 'merged' });
  const mergedBody = renderDisclosureBlock({
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'merged',
    command: mission().commands_declared[0], headOid: mission().patch_commit,
  });
  const valid = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: mergedPublication.pr_url, body: mergedBody })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await auditMissionDisclosure({
    mission: mission(),
    publication: mergedPublication,
    policy,
    request: valid,
  });

  const missing = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, {
      number: 21,
      html_url: mergedPublication.pr_url,
      body: renderDisclosureBlock({
        missionId: 'M-021', receiptUrl, publicationState: 'open',
        command: mission().commands_declared[0], headOid: mission().patch_commit,
      }),
    })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: mergedPublication, policy, request: missing }),
    /merged.*invitation|expected.*marked block|exactly 2 Northset URL/i,
  );

  const openWithInvitation = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body: mergedBody })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: openWithInvitation }),
    /open.*invitation|expected.*marked block|exactly 1 Northset URL/i,
  );
});

test('repository audit explicitly exempts historical PRs but fails closed for a future disclosure gap', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-pr-disclosure-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historical = path.join(root, 'M-020');
  const future = path.join(root, 'M-021');
  await Promise.all([mkdir(historical), mkdir(future)]);
  await Promise.all([
    writeFile(path.join(historical, 'mission.json'), JSON.stringify(mission('M-020'))),
    writeFile(path.join(historical, 'publication.json'), JSON.stringify(publication('M-020', {
      pr_number: 20,
      pr_url: 'https://github.com/example/project/pull/20',
      pr_disclosure: undefined,
    }))),
    writeFile(path.join(future, 'mission.json'), JSON.stringify(mission('M-021'))),
    writeFile(path.join(future, 'publication.json'), JSON.stringify(publication('M-021', {
      pr_disclosure: undefined,
    }))),
  ]);
  let requested = false;
  const request = async () => {
    requested = true;
    throw new Error('network must not be reached');
  };

  await assert.rejects(
    auditAllDisclosures({ missionsDir: root, policy, request }),
    /M-021.*pr_disclosure|pr_disclosure.*M-021/i,
  );
  assert.equal(requested, false);
});

test('factory receipts audit verifies versioned open, closed, and merged PR blocks offline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-disclosure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = await Promise.all([
    writeFactoryDisclosureFixture(root, {
      missionId: 'M-1000',
      commitOid: '1'.repeat(40),
      prState: 'OPEN',
      command: ['node', '--test', 'test/focused.test.mjs'],
      includeNoCiChange: true,
    }),
    writeFactoryDisclosureFixture(root, {
      missionId: 'M-1001',
      commitOid: '2'.repeat(40),
      prState: 'OPEN',
      command: null,
      blockVersion: 1,
    }),
    writeFactoryDisclosureFixture(root, {
      missionId: 'M-1002',
      commitOid: '3'.repeat(40),
      prState: 'CLOSED',
      command: 'npm test',
    }),
    writeFactoryDisclosureFixture(root, {
      missionId: 'M-1003',
      commitOid: '4'.repeat(40),
      prState: 'MERGED',
      command: `node --test ${'deep/path/'.repeat(10)}focused.test.mjs`,
    }),
    writeFactoryDisclosureFixture(root, {
      missionId: 'M-1004',
      commitOid: '5'.repeat(40),
      prState: 'MERGED',
      bodyState: 'open',
      command: 'npm test',
    }),
  ]);
  const routes = new Map();
  for (const fixture of fixtures) {
    routes.set(`GET ${fixture.receiptUrl}`, response(200));
    routes.set(`GET ${fixture.prApi}`, response(200, {
      number: fixture.prNumber,
      html_url: fixture.prUrl,
      body: fixture.missionId === 'M-1001' ? fixture.body.replaceAll('\n', '\r\n') : fixture.body,
    }));
    routes.set(`GET ${fixture.commentsApi}`, response(200, []));
  }
  const request = fakeRequest(routes);
  const report = await auditAllFactoryDisclosures({
    factoryReceiptsDir: root,
    policy,
    request,
  });
  assert.equal(report.lane, 'factory_receipts');
  assert.equal(report.checked, 4);
  assert.equal(report.merged_sync_pending, 1);
  assert.equal(report.block_v1, 1);
  assert.equal(report.block_v2, 4);
  assert.deepEqual(report.reports.map(({ mission_id: missionId }) => missionId), [
    'M-1000', 'M-1001', 'M-1002', 'M-1003', 'M-1004',
  ]);
  assert.equal(report.reports.find(({ mission_id: missionId }) => missionId === 'M-1003')?.block_schema_version, 2);
  assert.equal(report.reports.find(({ mission_id: missionId }) => missionId === 'M-1003')?.status, 'verified');
  assert.equal(report.reports.find(({ mission_id: missionId }) => missionId === 'M-1004')?.status, 'merged_sync_pending');
  assert.equal(request.calls.length, 15);
});

test('factory receipts audit rejects merged-style blocks on open and unmerged closed PRs', async (t) => {
  for (const [index, prState] of ['OPEN', 'CLOSED'].entries()) {
    const root = await mkdtemp(path.join(os.tmpdir(), `northset-factory-non-promotional-${index}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = await writeFactoryDisclosureFixture(root, {
      missionId: `M-101${index}`,
      commitOid: String(index + 6).repeat(40),
      prState,
      bodyState: 'merged',
      command: 'npm test',
    });
    const request = fakeRequest(new Map([
      [`GET ${fixture.receiptUrl}`, response(200)],
      [`GET ${fixture.prApi}`, response(200, {
        number: fixture.prNumber,
        html_url: fixture.prUrl,
        body: fixture.body,
      })],
    ]));
    await assert.rejects(
      auditAllFactoryDisclosures({ factoryReceiptsDir: root, policy, request }),
      /expected state-specific marked block/i,
    );
  }
});

test('factory receipts audit rejects a proof byte mismatch before any remote read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFactoryDisclosureFixture(root, {
    missionId: 'M-1000',
    commitOid: '5'.repeat(40),
    prState: 'OPEN',
    command: 'npm test',
  });
  const proofBytes = await readFile(fixture.proofFile);
  await writeFile(fixture.proofFile, Buffer.concat([proofBytes, Buffer.from(' ')]));
  let requested = false;
  const request = async () => {
    requested = true;
    throw new Error('network must not be reached');
  };
  await assert.rejects(
    auditAllFactoryDisclosures({ factoryReceiptsDir: root, policy, request }),
    /proof_sha256 mismatch/i,
  );
  assert.equal(requested, false);
});

test('CLI check accepts an empty factory receipts directory without network access', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let output = '';
  let errorOutput = '';
  const exitCode = await runPrReceiptDisclosureCli({
    args: [
      'check',
      '--factory-receipts-dir', root,
      '--policy', path.join(repositoryRoot, 'policies/pr_receipt_disclosure_policy.json'),
      '--json',
    ],
    env: {},
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { errorOutput += value; } },
    fetchImpl: async () => { throw new Error('network must not be reached'); },
  });
  assert.equal(exitCode, 0, errorOutput);
  assert.deepEqual(JSON.parse(output), {
    lane: 'factory_receipts',
    checked: 0,
    merged_sync_pending: 0,
    block_v1: 0,
    block_v2: 0,
    reports: [],
  });
});

test('CLI labels and counts merged_sync_pending in text and JSON output', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-cli-pending-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFactoryDisclosureFixture(root, {
    missionId: 'M-1060',
    commitOid: '8'.repeat(40),
    prState: 'MERGED',
    bodyState: 'open',
    command: 'npm test',
  });
  const fetchImpl = async (url) => {
    if (url === fixture.receiptUrl) return new Response('', { status: 200 });
    if (url === fixture.prApi) {
      return Response.json({ number: fixture.prNumber, html_url: fixture.prUrl, body: fixture.body });
    }
    if (url === fixture.commentsApi) return Response.json([]);
    throw new Error(`unexpected request: ${url}`);
  };
  const run = async (json) => {
    let output = '';
    let errorOutput = '';
    const exitCode = await runPrReceiptDisclosureCli({
      args: [
        'check',
        '--factory-receipts-dir', root,
        '--policy', path.join(repositoryRoot, 'policies/pr_receipt_disclosure_policy.json'),
        ...(json ? ['--json'] : []),
      ],
      env: {},
      stdout: { write: (value) => { output += value; } },
      stderr: { write: (value) => { errorOutput += value; } },
      fetchImpl,
    });
    assert.equal(exitCode, 0, errorOutput);
    return output;
  };

  const textOutput = await run(false);
  assert.equal(
    textOutput,
    'Factory PR receipt disclosure: 0 verified, 1 merged sync pending, 0 block v1, 1 block v2\n',
  );
  const jsonOutput = JSON.parse(await run(true));
  assert.equal(jsonOutput.checked, 0);
  assert.equal(jsonOutput.merged_sync_pending, 1);
  assert.equal(jsonOutput.reports[0].status, 'merged_sync_pending');

  let syncOutput = '';
  let syncError = '';
  const syncExit = await runPrReceiptDisclosureCli({
    args: [
      'sync',
      '--factory-receipts-dir', root,
      '--mission', fixture.missionId,
      '--policy', path.join(repositoryRoot, 'policies/pr_receipt_disclosure_policy.json'),
      '--json',
    ],
    env: {},
    stdout: { write: (value) => { syncOutput += value; } },
    stderr: { write: (value) => { syncError += value; } },
    fetchImpl,
  });
  assert.equal(syncExit, 0, syncError);
  assert.equal(JSON.parse(syncOutput).status, 'merged_sync_pending');
});

test('comment pagination cannot leave the original GitHub API endpoint', async () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  const request = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, {
      number: 21,
      html_url: publication().pr_url,
      body: renderDisclosureBlock({
        missionId: 'M-021', receiptUrl, publicationState: 'open',
        command: mission().commands_declared[0], headOid: mission().patch_commit,
      }),
    })],
    [`GET ${commentsApi}`, response(200, [], {
      link: '<https://example.com/redirect?page=2>; rel="next"',
    })],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request }),
    /pagination.*GitHub API endpoint/i,
  );
});

test('factory synchronizer is read-only by default and applies exact merged bytes without local writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeFactoryDisclosureFixture(root, {
    missionId: 'M-1030',
    commitOid: '9'.repeat(40),
    prState: 'MERGED',
    bodyState: 'open',
    command: ['node', '--test', 'test/focused.test.mjs'],
    includeNoCiChange: true,
  });
  const originalFiles = await Promise.all([
    readFile(fixture.currentFile),
    readFile(fixture.proofFile),
    readFile(fixture.publicationFile),
  ]);
  let body = fixture.body;
  const request = fakeRequest(new Map([
    [`GET ${fixture.receiptUrl}`, response(200)],
    [`GET ${fixture.prApi}`, () => response(200, {
      number: fixture.prNumber,
      html_url: fixture.prUrl,
      body,
    })],
    [`GET ${fixture.commentsApi}`, response(200, [])],
    [`PATCH ${fixture.prApi}`, ({ body: next }) => {
      body = next.body;
      return response(200, { number: fixture.prNumber, html_url: fixture.prUrl, body });
    }],
  ]));

  const readOnly = await syncFactoryDisclosure({
    factoryReceiptsDir: root,
    missionId: fixture.missionId,
    policy,
    request,
  });
  assert.equal(readOnly.status, 'merged_sync_pending');
  assert.equal(readOnly.changed, false);
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 0);

  await assert.rejects(
    syncFactoryDisclosure({
      factoryReceiptsDir: root,
      missionId: fixture.missionId,
      policy,
      request,
      apply: true,
      confirmPrUrl: 'https://github.com/example/project/pull/9999',
    }),
    /confirm PR URL.*exactly match/i,
  );
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 0);

  const applied = await syncFactoryDisclosure({
    factoryReceiptsDir: root,
    missionId: fixture.missionId,
    policy,
    request,
    apply: true,
    confirmPrUrl: fixture.prUrl,
  });
  assert.equal(applied.status, 'verified');
  assert.equal(applied.changed, true);
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 1);
  assert.equal(body, renderDisclosureBlock({
    missionId: fixture.missionId,
    receiptUrl: fixture.receiptUrl,
    publicationState: 'merged',
    blockVersion: 2,
    command: ['node', '--test', 'test/focused.test.mjs'],
    headOid: '9'.repeat(40),
    includeNoCiChange: true,
  }));
  assert.equal((body.match(/request a separate private run/g) ?? []).length, 1);
  assert.equal(body.split('https://').length - 1, 2);
  await assert.rejects(
    syncFactoryDisclosure({
      factoryReceiptsDir: root,
      missionId: fixture.missionId,
      policy,
      request,
      apply: true,
      confirmPrUrl: fixture.prUrl,
    }),
    /requires the exact open-state marked block/i,
  );
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 1);
  const finalFiles = await Promise.all([
    readFile(fixture.currentFile),
    readFile(fixture.proofFile),
    readFile(fixture.publicationFile),
  ]);
  assert.deepEqual(finalFiles, originalFiles);
});

test('factory synchronizer refuses a missing open block, digest mismatch, and live PR URL mismatch', async (t) => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-sync-missing-'));
  const digestRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-sync-digest-'));
  const urlRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-factory-pr-sync-url-'));
  t.after(() => Promise.all([missingRoot, digestRoot, urlRoot].map((root) => (
    rm(root, { recursive: true, force: true })
  ))));

  const missing = await writeFactoryDisclosureFixture(missingRoot, {
    missionId: 'M-1031', commitOid: 'a'.repeat(40), prState: 'MERGED', bodyState: 'open', command: 'npm test',
  });
  const missingRequest = fakeRequest(new Map([
    [`GET ${missing.receiptUrl}`, response(200)],
    [`GET ${missing.prApi}`, response(200, {
      number: missing.prNumber,
      html_url: missing.prUrl,
      body: missing.body.replace(
        'Self-run by the contributor, not maintainer verification.',
        'Altered disclosure text.',
      ),
    })],
  ]));
  await assert.rejects(
    syncFactoryDisclosure({
      factoryReceiptsDir: missingRoot, missionId: missing.missionId, policy, request: missingRequest,
      apply: true, confirmPrUrl: missing.prUrl,
    }),
    /expected state-specific marked block|exact open-state marked block/i,
  );
  assert.equal(missingRequest.calls.some(({ method }) => method === 'PATCH'), false);

  const digest = await writeFactoryDisclosureFixture(digestRoot, {
    missionId: 'M-1032', commitOid: 'b'.repeat(40), prState: 'MERGED', bodyState: 'open', command: 'npm test',
  });
  await writeFile(digest.proofFile, Buffer.concat([await readFile(digest.proofFile), Buffer.from(' ')]));
  let digestRequested = false;
  await assert.rejects(
    syncFactoryDisclosure({
      factoryReceiptsDir: digestRoot,
      missionId: digest.missionId,
      policy,
      request: async () => { digestRequested = true; throw new Error('must not request'); },
      apply: true,
      confirmPrUrl: digest.prUrl,
    }),
    /proof_sha256 mismatch/i,
  );
  assert.equal(digestRequested, false);

  const url = await writeFactoryDisclosureFixture(urlRoot, {
    missionId: 'M-1033', commitOid: 'c'.repeat(40), prState: 'MERGED', bodyState: 'open', command: 'npm test',
  });
  const urlRequest = fakeRequest(new Map([
    [`GET ${url.receiptUrl}`, response(200)],
    [`GET ${url.prApi}`, response(200, {
      number: url.prNumber,
      html_url: 'https://github.com/example/project/pull/9999',
      body: url.body,
    })],
  ]));
  await assert.rejects(
    syncFactoryDisclosure({
      factoryReceiptsDir: urlRoot, missionId: url.missionId, policy, request: urlRequest,
      apply: true, confirmPrUrl: url.prUrl,
    }),
    /GitHub PR API response does not match publication\.json/i,
  );
  assert.equal(urlRequest.calls.some(({ method }) => method === 'PATCH'), false);
});

test('synchronizer is read-only by default and apply requires the exact confirmed PR URL', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'northset-pr-disclosure-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missionDir = path.join(root, 'M-021');
  await mkdir(missionDir);
  const sourcePublication = publication('M-021');
  delete sourcePublication.pr_disclosure;
  await Promise.all([
    writeFile(path.join(missionDir, 'mission.json'), `${JSON.stringify(mission(), null, 2)}\n`),
    writeFile(path.join(missionDir, 'publication.json'), `${JSON.stringify(sourcePublication, null, 2)}\n`),
  ]);

  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  let body = '## Summary\n\nFocused fix.';
  const request = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, () => response(200, { number: 21, html_url: sourcePublication.pr_url, body })],
    [`GET ${commentsApi}`, response(200, [])],
    [`PATCH ${prApi}`, ({ body: next }) => {
      body = next.body;
      return response(200, { number: 21, html_url: sourcePublication.pr_url, body });
    }],
  ]));

  await assert.rejects(
    syncMissionDisclosure({ missionDir, policy, request }),
    /read-only check.*missing|missing.*read-only check/i,
  );
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(missionDir, 'publication.json'), 'utf8')), sourcePublication);

  await assert.rejects(
    syncMissionDisclosure({ missionDir, policy, request, apply: true }),
    /confirm.*PR URL/i,
  );
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 0);

  const result = await syncMissionDisclosure({
    missionDir,
    policy,
    request,
    apply: true,
    confirmPrUrl: sourcePublication.pr_url,
    now: '2026-07-14T16:00:00Z',
  });
  assert.equal(result.changed, true);
  assert.equal(body.split(receiptUrl).length - 1, 1);
  assert.equal(request.calls.filter(({ method }) => method === 'PATCH').length, 1);
  const saved = JSON.parse(await readFile(path.join(missionDir, 'publication.json'), 'utf8'));
  assert.deepEqual(saved.pr_disclosure, {
    schema_version: 2,
    required: true,
    mode: 'pr_body',
    canonical_url: receiptUrl,
    verified_at: '2026-07-14T16:00:00Z',
  });
});

test('repository audit checks committed receipts without network access', async () => {
  const committedPolicy = JSON.parse(await readFile(
    path.join(repositoryRoot, 'policies/pr_receipt_disclosure_policy.json'),
    'utf8',
  ));
  const missionEntries = (await readdir(path.join(repositoryRoot, 'missions'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^M-/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const records = [];
  for (const entry of missionEntries) {
    const missionRecord = JSON.parse(await readFile(
      path.join(repositoryRoot, 'missions', entry.name, 'mission.json'),
      'utf8',
    ));
    if (missionRecord.variant !== 'author_contribution') continue;
    records.push({
      mission: missionRecord,
      publication: JSON.parse(await readFile(
        path.join(repositoryRoot, 'missions', entry.name, 'publication.json'),
        'utf8',
      )),
    });
  }
  const expected = {
    prepared: records
      .filter(({ publication: source }) => source.state === 'prepared')
      .map(({ mission: source }) => source.mission_id),
    historical_exempt: records
      .filter(({ mission: source, publication: envelope }) => (
        envelope.state !== 'prepared'
        && committedPolicy.historical_exempt_mission_ids.includes(source.mission_id)
      ))
      .map(({ mission: source }) => source.mission_id),
    verified: records
      .filter(({ mission: source, publication: envelope }) => (
        envelope.state !== 'prepared'
        && !committedPolicy.historical_exempt_mission_ids.includes(source.mission_id)
      ))
      .map(({ mission: source }) => source.mission_id),
  };
  const routes = new Map();
  for (const { mission: source, publication: envelope } of records) {
    if (!expected.verified.includes(source.mission_id)) continue;
    const receiptUrl = canonicalReceiptUrl(committedPolicy, source.mission_id);
    const parsedPrUrl = new URL(envelope.pr_url);
    const [owner, repository, resource, number] = parsedPrUrl.pathname.split('/').filter(Boolean);
    assert.equal(resource, 'pull');
    assert.equal(Number(number), envelope.pr_number);
    const prApi = `https://api.github.com/repos/${owner}/${repository}/pulls/${number}`;
    const commentsApi = `https://api.github.com/repos/${owner}/${repository}/issues/${number}/comments?per_page=100`;
    routes.set(`GET ${receiptUrl}`, response(200));
    routes.set(`GET ${prApi}`, response(200, {
      number: envelope.pr_number,
      html_url: envelope.pr_url,
      body: renderDisclosureBlock({
        missionId: source.mission_id,
        receiptUrl,
        publicationState: envelope.state,
        blockVersion: envelope.pr_disclosure.schema_version,
        command: source.commands_declared[0],
        headOid: source.patch_commit,
      }),
    }));
    routes.set(`GET ${commentsApi}`, response(200, []));
  }
  const request = fakeRequest(routes);
  const report = await auditAllDisclosures({
    missionsDir: path.join(repositoryRoot, 'missions'),
    policy: committedPolicy,
    request,
  });
  assert.equal(report.checked, expected.verified.length);
  assert.equal(report.historical_exempt, expected.historical_exempt.length);
  assert.equal(report.prepared, expected.prepared.length);
  for (const status of ['historical_exempt', 'prepared', 'verified']) {
    assert.deepEqual(
      report.reports.filter((entry) => entry.status === status).map((entry) => entry.mission_id),
      expected[status],
    );
  }
  assert.equal(report.reports.find(({ mission_id: missionId }) => missionId === 'M-021')?.status, 'historical_exempt');
  for (const missionId of expected.prepared) {
    const receiptUrl = canonicalReceiptUrl(committedPolicy, missionId);
    assert.equal(routes.has(`GET ${receiptUrl}`), false, missionId);
    assert.equal(request.calls.some(({ url }) => url === receiptUrl), false, missionId);
  }
});

test('committed policy freezes the historical cutover and active Northset actors', async () => {
  const committed = JSON.parse(await readFile(
    path.join(repositoryRoot, 'policies/pr_receipt_disclosure_policy.json'),
    'utf8',
  ));
  assert.deepEqual(committed.historical_exempt_mission_ids, [
    ...policy.historical_exempt_mission_ids,
    'M-021',
  ]);
  assert.deepEqual(committed.northset_actor_logins, ['AysajanE']);
  assert.equal(committed.current_block_schema_version, 2);
});

test('HTTP request adapter sends GitHub credentials only to the GitHub API origin', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'text/html' }),
    };
  };
  const request = createFetchRequest({ fetchImpl, token: 'secret-token' });
  await request('https://northset-oss.github.io/verification-pilot/receipts/M-021/');
  await request('https://api.github.com/repos/example/project/pulls/21');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer secret-token');
  await assert.rejects(
    request('https://example.com/api', { method: 'PATCH', body: { body: 'x' } }),
    /write.*GitHub API origin/i,
  );
});

test('HTTP request adapter falls back to authenticated GraphQL for GitHub PR REST 503s', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url !== 'https://api.github.com/graphql') {
      return { status: 503, headers: new Headers({ 'content-type': 'text/html' }) };
    }
    const payload = JSON.parse(options.body);
    const comments = payload.query.includes('comments(first:100');
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      async json() {
        return comments
          ? { data: { repository: { pullRequest: { comments: {
            nodes: [{ body: 'No receipt link.', author: { login: 'maintainer' } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          } } } } }
          : { data: { repository: { pullRequest: {
            number: 21,
            url: 'https://github.com/example/project/pull/21',
            body: 'PR body',
          } } } };
      },
    };
  };
  const request = createFetchRequest({ fetchImpl, token: 'secret-token' });
  const pr = await request('https://api.github.com/repos/example/project/pulls/21');
  assert.deepEqual(pr.json, {
    number: 21,
    html_url: 'https://github.com/example/project/pull/21',
    body: 'PR body',
  });
  const comments = await request('https://api.github.com/repos/example/project/issues/21/comments?per_page=100');
  assert.deepEqual(comments.json, [{ body: 'No receipt link.', user: { login: 'maintainer' } }]);
  assert.equal(calls.filter(({ url }) => url === 'https://api.github.com/graphql').length, 2);
  assert.ok(calls.filter(({ url }) => url === 'https://api.github.com/graphql')
    .every(({ options }) => options.headers.Authorization === 'Bearer secret-token'));
});
