import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditAllDisclosures,
  auditMissionDisclosure,
  canonicalReceiptUrl,
  createFetchRequest,
  renderDisclosureBlock,
  syncMissionDisclosure,
  upsertDisclosureBlock,
  validateDisclosurePolicy,
} from '../lib/pr-receipt-disclosure.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

const policy = {
  schema_version: 1,
  canonical_receipt_base_url: 'https://northset-oss.github.io/verification-pilot/receipts/',
  legacy_ledger_base_url: 'https://northset-oss.github.io/verification-pilot/',
  historical_exempt_mission_ids: [
    'M-007', 'M-008', 'M-009', 'M-011', 'M-012',
    'M-014', 'M-015', 'M-016', 'M-019', 'M-020',
  ],
  northset_actor_logins: ['AysajanE'],
};

function mission(missionId = 'M-021') {
  return { mission_id: missionId, variant: 'author_contribution' };
}

function publication(missionId = 'M-021', overrides = {}) {
  return {
    mission_id: missionId,
    state: 'open',
    pr_number: 21,
    pr_url: 'https://github.com/example/project/pull/21',
    pr_disclosure: {
      schema_version: 1,
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

test('disclosure policy is exact, future-safe, and produces canonical per-receipt URLs', () => {
  assert.equal(validateDisclosurePolicy(policy), policy);
  assert.equal(
    canonicalReceiptUrl(policy, 'M-021'),
    'https://northset-oss.github.io/verification-pilot/receipts/M-021/',
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
    () => canonicalReceiptUrl(policy, '../M-021'),
    /mission id/i,
  );
});

test('receipt disclosure block is state-specific, marked, and idempotently replaceable', () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const block = renderDisclosureBlock({ missionId: 'M-021', receiptUrl, publicationState: 'open' });
  assert.match(block, /<!-- northset-receipt:M-021:start -->/);
  assert.match(block, /Northset proof-of-pass receipt/);
  assert.match(block, /Contributor self-run; not maintainer verification\./);
  assert.doesNotMatch(block, /request a separate, private run/i);
  assert.equal(block.split(receiptUrl).length - 1, 1);
  assert.doesNotMatch(block, /badge|logo|attestation/i);

  const merged = renderDisclosureBlock({
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'merged',
  });
  assert.match(merged, /This record covers Northset’s own contribution; it is not maintainer verification\./);
  assert.match(merged, /Maintainers can request a separate, private run for a PR already in their queue at oss@northset\.ai\./);
  assert.match(merged, /adding `northset-verify` to a PR requests a run on that PR\./);
  assert.equal((merged.match(/request a separate, private run/g) ?? []).length, 1);

  const closed = renderDisclosureBlock({
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'closed_unmerged',
  });
  assert.doesNotMatch(closed, /request a separate, private run/i);

  const first = upsertDisclosureBlock('## Summary\n\nFocused fix.', {
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'open',
  });
  assert.equal(first.changed, true);
  assert.equal(first.body.split(receiptUrl).length - 1, 1);
  const second = upsertDisclosureBlock(first.body, {
    missionId: 'M-021',
    receiptUrl,
    publicationState: 'open',
  });
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);

  assert.throws(
    () => upsertDisclosureBlock(`Existing unmarked ${receiptUrl}`, {
      missionId: 'M-021',
      receiptUrl,
      publicationState: 'open',
    }),
    /unmarked/i,
  );
  assert.throws(
    () => upsertDisclosureBlock('<!-- northset-receipt:M-099:start -->\nold\n<!-- northset-receipt:M-099:end -->', {
      missionId: 'M-021',
      receiptUrl,
      publicationState: 'open',
    }),
    /different mission/i,
  );
});

test('live audit requires one canonical body link, a live receipt, and no Northset receipt comment', async () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  const body = renderDisclosureBlock({ missionId: 'M-021', receiptUrl, publicationState: 'open' });
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
    /one.*ledger link|ledger link.*one/i,
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
      body: renderDisclosureBlock({ missionId: 'M-021', receiptUrl, publicationState: 'open' }),
    })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: mergedPublication, policy, request: missing }),
    /merged.*invitation|expected.*marked block/i,
  );

  const openWithInvitation = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, { number: 21, html_url: publication().pr_url, body: mergedBody })],
    [`GET ${commentsApi}`, response(200, [])],
  ]));
  await assert.rejects(
    auditMissionDisclosure({ mission: mission(), publication: publication(), policy, request: openWithInvitation }),
    /open.*invitation|expected.*marked block/i,
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

test('comment pagination cannot leave the original GitHub API endpoint', async () => {
  const receiptUrl = canonicalReceiptUrl(policy, 'M-021');
  const prApi = 'https://api.github.com/repos/example/project/pulls/21';
  const commentsApi = 'https://api.github.com/repos/example/project/issues/21/comments?per_page=100';
  const request = fakeRequest(new Map([
    [`GET ${receiptUrl}`, response(200)],
    [`GET ${prApi}`, response(200, {
      number: 21,
      html_url: publication().pr_url,
      body: renderDisclosureBlock({ missionId: 'M-021', receiptUrl, publicationState: 'open' }),
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
    schema_version: 1,
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
