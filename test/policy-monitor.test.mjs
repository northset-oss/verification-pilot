import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkDocumentTargets, checkTargets, diffPolicyState } from '../lib/policy-monitor.mjs';
import { runPolicyMonitorCli } from '../bin/policy-monitor.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(root, 'test/fixtures/policy-monitor');
const fixtureTargets = 'test/fixtures/policy-monitor/targets.json';
const fixtureState = 'test/fixtures/policy-monitor/state.json';
const fixtureStateFile = path.join(root, fixtureState);
const cli = path.join(root, 'bin/policy-monitor.mjs');
const fakeFetchModule = `data:text/javascript,${encodeURIComponent(`
  const fixture = JSON.parse(process.env.POLICY_MONITOR_FAKE_RESPONSE);
  globalThis.fetch = async () => ({
    status: fixture.status,
    statusText: fixture.statusText || '',
    async json() { return fixture.body || {}; },
  });
`)}`;

function response(status, body = {}, statusText = '') {
  return {
    status,
    statusText,
    async json() {
      return body;
    },
  };
}

function documentResponse(body, contentType = 'text/markdown; charset=utf-8') {
  return {
    status: 200,
    statusText: 'OK',
    headers: {get(name) { return name.toLowerCase() === 'content-type' ? contentType : null; }},
    async text() { return body; },
  };
}

function runCli(args, fakeResponse) {
  return spawnSync(
    process.execPath,
    ['--import', fakeFetchModule, cli, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_TOKEN: '',
        POLICY_MONITOR_FAKE_RESPONSE: JSON.stringify(fakeResponse),
      },
    },
  );
}

test('diffPolicyState classifies unchanged, changed, new, and removed files', () => {
  const results = diffPolicyState(
    {
      'repo:unchanged': 'same-sha',
      'repo:changed': 'old-sha',
      'repo:removed': 'removed-sha',
    },
    {
      'repo:unchanged': 'same-sha',
      'repo:changed': 'new-sha',
      'repo:new': 'added-sha',
    },
  );

  assert.deepEqual(results, [
    {
      key: 'repo:unchanged',
      status: 'unchanged',
      previousSha: 'same-sha',
      sha: 'same-sha',
    },
    {
      key: 'repo:changed',
      status: 'changed',
      previousSha: 'old-sha',
      sha: 'new-sha',
    },
    { key: 'repo:removed', status: 'removed', previousSha: 'removed-sha' },
    { key: 'repo:new', status: 'new', sha: 'added-sha' },
  ]);
});

test('checkTargets handles found, missing, rate-limited, and changed files', async () => {
  const scripted = [
    response(200, { sha: 'same-sha' }),
    response(404),
    response(403, { message: 'API rate limit exceeded' }),
    response(200, { sha: 'new-sha' }),
  ];
  const targets = [{
    repo: 'owner/repo',
    paths: ['same.md', 'missing.md', 'limited.md', 'changed.md'],
  }];
  const report = await checkTargets({
    targets,
    state: {
      version: '0',
      files: {
        'owner/repo:same.md': 'same-sha',
        'owner/repo:changed.md': 'old-sha',
      },
    },
    fetchImpl: async () => scripted.shift(),
  });

  assert.equal(report.changed, true);
  assert.deepEqual(report.nextState, {
    version: '0',
    files: {
      'owner/repo:same.md': 'same-sha',
      'owner/repo:changed.md': 'new-sha',
    },
  });
  assert.equal(report.results.find(({ key }) => key.endsWith('missing.md')), undefined);
  assert.deepEqual(
    report.results.find(({ key }) => key.endsWith('changed.md')),
    {
      key: 'owner/repo:changed.md',
      status: 'changed',
      previousSha: 'old-sha',
      sha: 'new-sha',
    },
  );
  const warning = report.results.find(({ status }) => status === 'warning');
  assert.equal(warning.key, 'owner/repo:limited.md');
  assert.match(warning.reason, /403.*rate limit.*API rate limit exceeded/i);
});

test('checkTargets keeps a tracked file through a transient API failure', async () => {
  const scripted = [
    response(403, { message: 'API rate limit exceeded' }),
    response(404),
  ];
  const report = await checkTargets({
    targets: [{ repo: 'owner/repo', paths: ['limited.md', 'gone.md'] }],
    state: {
      version: '0',
      files: {
        'owner/repo:limited.md': 'kept-sha',
        'owner/repo:gone.md': 'gone-sha',
      },
    },
    fetchImpl: async () => scripted.shift(),
  });

  const limited = report.results.filter(({ key }) => key === 'owner/repo:limited.md');
  assert.deepEqual(limited.map(({ status }) => status).sort(), ['unchanged', 'warning']);
  assert.deepEqual(
    report.results.find(({ key }) => key === 'owner/repo:gone.md'),
    { key: 'owner/repo:gone.md', status: 'removed', previousSha: 'gone-sha' },
  );
  assert.equal(report.changed, true);
  assert.equal(report.nextState.files['owner/repo:limited.md'], 'kept-sha');
  assert.equal(Object.hasOwn(report.nextState.files, 'owner/repo:gone.md'), false);
});

test('checkTargets sends authorization only when a token is set', async () => {
  const seenHeaders = [];
  const fetchImpl = async (_url, options) => {
    seenHeaders.push(options.headers);
    return response(200, { sha: 'fixture-sha' });
  };
  const base = {
    targets: [{ repo: 'owner/repo', paths: ['POLICY.md'] }],
    state: { version: '0', files: {} },
    fetchImpl,
  };

  await checkTargets({ ...base, token: 'test-token' });
  await checkTargets(base);

  assert.equal(seenHeaders[0].Authorization, 'Bearer test-token');
  assert.equal(Object.hasOwn(seenHeaders[1], 'Authorization'), false);
  assert.equal(seenHeaders[0].Accept, 'application/vnd.github+json');
  assert.equal(seenHeaders[0]['User-Agent'], 'northset-policy-monitor');
});

test('document targets record URL, fetched time, digest, previous digest, and disposition without credentials', async () => {
  const seen = [];
  const first = await checkDocumentTargets({
    documents: [{id: 'github-tos', url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service'}],
    state: {documents: {}},
    now: () => new Date('2026-07-17T12:00:00Z'),
    fetchImpl: async (url, options) => {
      seen.push({url, options});
      return documentResponse('# Terms v1');
    },
  });
  assert.equal(first.changed, true);
  assert.match(first.results[0].digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.results[0].previous_digest, null);
  assert.equal(first.results[0].disposition, 'new');
  assert.equal(first.results[0].fetched_at, '2026-07-17T12:00:00.000Z');
  assert.equal(seen[0].options.headers.Authorization, undefined);
  assert.equal(seen[0].options.headers.Accept, 'text/markdown');

  const second = await checkDocumentTargets({
    documents: [{id: 'github-tos', url: seen[0].url}],
    state: first.nextState,
    now: () => new Date('2026-07-24T12:00:00Z'),
    fetchImpl: async () => documentResponse('# Terms v1'),
  });
  assert.equal(second.changed, false);
  assert.equal(second.results[0].previous_digest, first.results[0].digest);
  assert.equal(second.results[0].disposition, 'unchanged');
  assert.equal(second.nextState.documents['github-tos'].fetched_at, '2026-07-24T12:00:00.000Z');

  const htmlFallback = await checkDocumentTargets({
    documents: [{id: 'github-tos', url: seen[0].url}],
    state: second.nextState,
    now: () => new Date('2026-07-31T12:00:00Z'),
    fetchImpl: async () => documentResponse('<html>site shell</html>', 'text/html; charset=utf-8'),
  });
  assert.equal(htmlFallback.changed, false);
  assert.equal(htmlFallback.results[0].status, 'warning');
  assert.match(htmlFallback.results[0].reason, /unexpected content type.*text\/html/i);
  assert.deepEqual(htmlFallback.nextState, second.nextState);
});

test('version 1 CLI snapshots repository and official document targets into one state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-monitor-v1-'));
  const targetsFile = path.join(directory, 'targets.json');
  const stateFile = path.join(directory, 'state.json');
  await writeFile(targetsFile, JSON.stringify({version: '1', targets: [], documents: [{
    id: 'github-tos', url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
  }]}));
  await writeFile(stateFile, JSON.stringify({version: '1', files: {}, documents: {}}));
  let stdout = '';
  let stderr = '';
  const status = await runPolicyMonitorCli({
    args: ['check', '--targets', targetsFile, '--state', stateFile, '--write', '--json'],
    fetchImpl: async () => documentResponse('# Terms v1'),
    env: {},
    stdout: {write(value) { stdout += value; }},
    stderr: {write(value) { stderr += value; }},
  });
  assert.equal(status, 2, stderr);
  assert.equal(JSON.parse(stdout).results[0].disposition, 'new');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.version, '1');
  assert.match(state.documents['github-tos'].digest, /^sha256:/);
});

test('version 1 CLI formats document digest changes without undefined SHA fields', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-monitor-v1-format-'));
  const targetsFile = path.join(directory, 'targets.json');
  const stateFile = path.join(directory, 'state.json');
  await writeFile(targetsFile, JSON.stringify({version: '1', targets: [], documents: [{
    id: 'github-tos', url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
  }]}));
  await writeFile(stateFile, JSON.stringify({version: '1', files: {}, documents: {
    'github-tos': {
      url: 'https://docs.github.com/en/site-policy/github-terms/github-terms-of-service',
      fetched_at: '2026-07-10T12:00:00.000Z',
      digest: `sha256:${'a'.repeat(64)}`,
      previous_digest: null,
      disposition: 'new',
    },
  }}));
  let stdout = '';
  let stderr = '';
  const status = await runPolicyMonitorCli({
    args: ['check', '--targets', targetsFile, '--state', stateFile],
    fetchImpl: async () => documentResponse('# Terms v2'),
    env: {},
    stdout: {write(value) { stdout += value; }},
    stderr: {write(value) { stderr += value; }},
  });

  assert.equal(status, 2, stderr);
  assert.match(stdout, new RegExp(`^changed document:github-tos: sha256:${'a'.repeat(64)} -> sha256:[0-9a-f]{64}\\n$`));
  assert.doesNotMatch(stdout, /undefined/);
});

test('CLI exits zero for an unchanged fixture snapshot', () => {
  const result = runCli(
    ['check', '--targets', fixtureTargets, '--state', fixtureState, '--json'],
    { status: 200, body: { sha: 'fixture-sha' } },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).changed, false);
});

test('CLI exits two when a blob SHA changes', () => {
  const result = runCli(
    ['check', '--targets', fixtureTargets, '--state', fixtureState, '--json'],
    { status: 200, body: { sha: 'changed-sha' } },
  );

  assert.equal(result.status, 2, result.stderr);
  assert.equal(JSON.parse(result.stdout).results[0].status, 'changed');
});

test('CLI exits one when the targets config is unreadable', () => {
  const result = runCli(
    [
      'check',
      '--targets', path.join(fixtureDirectory, 'does-not-exist.json'),
      '--state', fixtureState,
      '--json',
    ],
    { status: 200, body: { sha: 'fixture-sha' } },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /cannot read targets config/);
});

test('--write persists state and the second CLI run sees no change', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-monitor-'));
  const stateFile = path.join(directory, 'state.json');
  await writeFile(stateFile, await readFile(fixtureStateFile, 'utf8'));
  const args = [
    'check',
    '--targets', fixtureTargets,
    '--state', stateFile,
    '--write',
    '--json',
  ];

  const first = runCli(args, { status: 200, body: { sha: 'updated-sha' } });
  assert.equal(first.status, 2, first.stderr);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')), {
    version: '0',
    files: { 'fixture/policy:POLICY.md': 'updated-sha' },
  });

  const second = runCli(args, { status: 200, body: { sha: 'updated-sha' } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).changed, false);
});

test('CLI treats all-request warnings as a hard error and does not write state', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-monitor-'));
  const stateFile = path.join(directory, 'state.json');
  const initialState = await readFile(fixtureStateFile, 'utf8');
  await writeFile(stateFile, initialState);

  const result = runCli(
    [
      'check',
      '--targets', fixtureTargets,
      '--state', stateFile,
      '--write',
      '--json',
    ],
    { status: 403, body: { message: 'API rate limit exceeded' } },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /all GitHub API requests failed/);
  assert.equal(await readFile(stateFile, 'utf8'), initialState);
});
