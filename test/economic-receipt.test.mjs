import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildLedger, buildReceiptViewModel, renderLedger } from '../lib/ledger.mjs';
import { validateEconomicIdentity } from '../lib/economic-identity.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'test/fixtures/ledger/missions/alpha');
const generatedAt = '2026-07-15T12:00:00Z';
const taskId = 'TASK-OSS-0A916D075853F7FE';
const issueUrl = 'https://github.com/maintainer/worker-project/issues/17';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'northset-economic-receipt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function economicIdentity(overrides = {}) {
  return {
    schema_version: 1,
    task: {
      task_id: taskId,
      attempt_id: 'M-005',
      attempt_sequence: 1,
      work_category: 'defect_fix',
      external_demand: {
        source: 'public_github_issue',
        issue_url: issueUrl,
        acceptance_contract_digest: `sha256:${'1'.repeat(64)}`,
        invitation_type: 'label',
        invitation_url: issueUrl,
      },
    },
    funding: {
      program: 'Northset OSS Fund',
      initiative: 'OSS mission experimentation',
      budget_id: null,
      financial_cap: null,
      currency: null,
    },
    attempt_lineage: {
      attempts_total: 1,
      successful_attempt_id: 'M-005',
      attempts: [{ attempt_id: 'M-005', attempt_sequence: 1, state: 'READY', terminal_reason_class: null }],
    },
    usage: {
      discovery: { finder_run_id: 'd86d9ac8-99ce-4dc0-b18e-579f6f0b9d78', candidate_rank: 1, elapsed_ms: 1200 },
      qualification: {
        review_id: `sha256:${'2'.repeat(64)}`,
        requested_model: 'gpt-5.6-sol',
        actual_model: null,
        reasoning_effort: 'xhigh',
        service_tier: 'fast',
        duration_ms: 3000,
        model_requests: null,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
      },
      authoring: {
        requested_model: 'gpt-5.6-sol',
        actual_model: null,
        reasoning_effort: 'xhigh',
        service_tier: 'fast',
        duration_ms: 5000,
        bootstrap_duration_ms: 1800,
        bootstrap_retry_count: 0,
        model_requests: null,
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
      },
      preparation: {
        total_duration_ms: 9000,
        stages: [{ stage: 'clone', duration_ms: 2200 }, { stage: 'author', duration_ms: 6800 }],
      },
      verification: {
        executor_elapsed_ms: 9000,
        networked_setup_elapsed_ms: 1800,
        dependency_install_ms: null,
        declared_commands_ms: 4000,
        unclassified_executor_ms: 3200,
        cpu_ms: null,
        peak_rss_bytes: null,
        measurement_status: 'partial',
      },
      resource_envelope: {
        cpus: 2,
        memory_mb: 4096,
        pids: 512,
        wall_clock_seconds_per_command: 1800,
        output_bytes_per_stream: 2000000,
      },
    },
    work_scope: {
      files_changed: 2,
      changed_lines: 18,
      production_files: 1,
      test_files: 1,
      checks_declared: 1,
      checks_not_run: ['Full upstream CI matrix'],
    },
    costs: {
      status: 'partial',
      currency: null,
      lines: [{
        component: 'maintainer_payment',
        measurement_class: 'observed_quantity_unpriced',
        quantity: '0',
        unit: 'external_transfer',
        unit_rate: null,
        amount: null,
        currency: null,
        source_refs: [{ artifact: 'bundle/mission.json', artifact_sha256: `sha256:${'3'.repeat(64)}`, json_pointer: '/payment/maintainer_payment' }],
        rate_card_digest: null,
        allocation_method: null,
        finality: 'final',
        visibility: 'public',
      }],
      known_direct_cost: null,
      allocated_shared_cost: null,
      human_standard_cost: null,
      total_economic_cost: null,
      missing_components: ['model_inference', 'actual_host_compute', 'human_review', 'shared_tooling'],
    },
    completeness: {
      task_identity: 'complete',
      technical_execution: 'complete',
      attempt_lineage: 'complete',
      usage: 'partial',
      cost: 'unpriced',
      external_outcome: 'partial',
      business_value: 'not_observed',
    },
    provenance: {
      spec_sha256: `sha256:${'4'.repeat(64)}`,
      qualification_evidence_sha256: `sha256:${'5'.repeat(64)}`,
      issue_snapshot_sha256: `sha256:${'6'.repeat(64)}`,
    },
    ...overrides,
  };
}

function approvalRecord() {
  return {
    schema_version: 1,
    mission_id: 'M-005',
    task_id: taskId,
    attempt_id: 'M-005',
    approved_manifest_digest: `sha256:${'7'.repeat(64)}`,
    approved_by: 'internal-user:operator',
    approved_at: '2026-07-15T11:45:00Z',
    funding_program: 'Northset OSS Fund',
    initiative: 'OSS mission experimentation',
    budget_id: null,
    financial_cap: null,
    operational_caps: {
      finder_wall_seconds: 1200,
      qualification_wall_seconds: 300,
      prepare_wall_seconds: 3600,
      ship_wall_seconds: 3600,
      maximum_attempts: null,
    },
  };
}

async function v2Mission(t, { economic = economicIdentity(), approval = approvalRecord() } = {}) {
  const directory = await temporaryDirectory(t);
  const missionDirectory = path.join(directory, 'missions', 'M-005');
  await cp(fixture, missionDirectory, { recursive: true });
  for (const relative of ['mission.json', 'bundle/mission.json']) {
    const file = path.join(missionDirectory, relative);
    const mission = JSON.parse(await readFile(file, 'utf8'));
    mission.variant = 'author_contribution';
    mission.claims_tier = [];
    mission.grade = null;
    mission.disclosure_label = 'Northset contributed this fix and ran its declared checks. Contributor self-run. Not maintainer verification.';
    mission.funding_source = 'Northset OSS Fund';
    mission.target_repo = 'https://github.com/maintainer/worker-project';
    mission.issue_or_task = issueUrl;
    mission.consent_artifact = null;
    mission.payment = { maintainer_payment: 'none', merge_contingent: false };
    await writeFile(file, `${JSON.stringify(mission, null, 2)}\n`);
  }
  const bundledMissionSource = await readFile(path.join(missionDirectory, 'bundle', 'mission.json'));
  economic.costs.lines[0].source_refs[0].artifact_sha256 = `sha256:${createHash('sha256').update(bundledMissionSource).digest('hex')}`;
  const issueSnapshotSource = `${JSON.stringify({
    issue: {
      title: 'Bounded maintainer-requested defect',
      html_url: issueUrl,
    },
  }, null, 2)}\n`;
  await writeFile(path.join(missionDirectory, 'bundle', 'issue_snapshot.json'), issueSnapshotSource);
  economic.provenance.issue_snapshot_sha256 = `sha256:${createHash('sha256').update(issueSnapshotSource).digest('hex')}`;
  const runRecordFile = path.join(missionDirectory, 'bundle', 'run_record.json');
  const runRecord = JSON.parse(await readFile(runRecordFile, 'utf8'));
  runRecord.usage = {
    networked_setup_elapsed_ms: 1800,
    dependency_install_ms: null,
    declared_commands_ms: 4000,
    cpu_ms: null,
    peak_rss_bytes: null,
  };
  await writeFile(runRecordFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  const economicSource = `${JSON.stringify(economic, null, 2)}\n`;
  await writeFile(path.join(missionDirectory, 'bundle', 'economic.json'), economicSource);
  const topMission = JSON.parse(await readFile(path.join(missionDirectory, 'mission.json'), 'utf8'));
  await writeFile(path.join(missionDirectory, 'bundle', 'bundle.manifest.json'), `${JSON.stringify({
    bundle_digest: topMission.run_record_bundle_digest,
    files: [{
      path: 'economic.json',
      sha256: createHash('sha256').update(economicSource).digest('hex'),
      bytes: Buffer.byteLength(economicSource),
    }],
  }, null, 2)}\n`);
  await writeFile(path.join(missionDirectory, 'approval.json'), `${JSON.stringify(approval, null, 2)}\n`);
  return { directory, missionDirectory };
}

test('economic evidence and approval produce one factual schema-v2 receipt', async (t) => {
  const { missionDirectory } = await v2Mission(t);
  const receipt = await buildReceiptViewModel({ missionFile: path.join(missionDirectory, 'mission.json') });

  assert.equal(receipt.version, 2);
  assert.equal(receipt.economic_identity.task.task_id, taskId);
  assert.equal(receipt.economic_identity.authorization.approved_by, 'internal-user:operator');
  assert.equal(receipt.economic_identity.costs.status, 'partial');
  assert.equal(receipt.economic_identity.costs.total_economic_cost, null);
  assert.equal(receipt.economic_identity.outcome.time_to_close_ms, null);
});

test('receipt rejects a zero total while known economic components are missing', async (t) => {
  const economic = economicIdentity({
    costs: { ...economicIdentity().costs, total_economic_cost: '0.00' },
  });
  const { missionDirectory } = await v2Mission(t, { economic });
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(missionDirectory, 'mission.json') }),
    /total_economic_cost.*must be null.*missing/i,
  );
});

test('receipt rejects estimates and provider billing claims without provider evidence', async (t) => {
  const base = economicIdentity();
  base.costs.lines[0].measurement_class = 'estimated';
  let prepared = await v2Mission(t, { economic: base });
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /estimated.*forbidden/i,
  );

  const billed = economicIdentity();
  billed.costs.lines[0].measurement_class = 'provider_billed';
  prepared = await v2Mission(t, { economic: billed });
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /provider_billed.*provider billing evidence/i,
  );
});

test('receipt rejects omitted attempts and non-public cost evidence', async (t) => {
  const gapped = economicIdentity();
  gapped.task.attempt_sequence = 2;
  gapped.attempt_lineage.attempts_total = 1;
  gapped.attempt_lineage.attempts[0].attempt_sequence = 2;
  let prepared = await v2Mission(t, { economic: gapped });
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /contiguous|attempt.*sequence|attempts_total/i,
  );

  const privateLine = economicIdentity();
  privateLine.costs.lines[0].visibility = 'confidential_finance';
  prepared = await v2Mission(t, { economic: privateLine });
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /public receipt.*cost line|visibility.*public/i,
  );
});

test('receipt resolves every cost source reference to the signed public bundle', async (t) => {
  let prepared = await v2Mission(t);
  let file = path.join(prepared.missionDirectory, 'bundle', 'economic.json');
  let economic = JSON.parse(await readFile(file, 'utf8'));
  economic.costs.lines[0].source_refs[0].artifact_sha256 = `sha256:${'0'.repeat(64)}`;
  await writeFile(file, `${JSON.stringify(economic, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /cost source digest.*does not match/i,
  );

  prepared = await v2Mission(t);
  file = path.join(prepared.missionDirectory, 'bundle', 'economic.json');
  economic = JSON.parse(await readFile(file, 'utf8'));
  economic.costs.lines[0].source_refs[0].json_pointer = '/payment/not_a_field';
  await writeFile(file, `${JSON.stringify(economic, null, 2)}\n`);
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(prepared.missionDirectory, 'mission.json') }),
    /cost source pointer.*does not exist/i,
  );
});

test('receipt rejects approval timestamps that predate the recorded work', async (t) => {
  const approval = approvalRecord();
  approval.approved_at = '2020-01-01T00:00:00Z';
  const { missionDirectory } = await v2Mission(t, {approval});
  await assert.rejects(
    buildReceiptViewModel({ missionFile: path.join(missionDirectory, 'mission.json') }),
    /approved_at cannot precede.*run finish/i,
  );
});

test('schema-v2 receipt requires a signed economic manifest entry and deterministic task identity', async (t) => {
  let prepared = await v2Mission(t);
  await rm(path.join(prepared.missionDirectory, 'bundle', 'bundle.manifest.json'));
  await assert.rejects(
    buildReceiptViewModel({missionFile: path.join(prepared.missionDirectory, 'mission.json')}),
    /schema-v2.*bundle.*manifest/i,
  );

  const economic = economicIdentity();
  economic.task.task_id = 'TASK-OSS-0000000000000000';
  const approval = approvalRecord();
  approval.task_id = economic.task.task_id;
  prepared = await v2Mission(t, {economic, approval});
  await assert.rejects(
    buildReceiptViewModel({missionFile: path.join(prepared.missionDirectory, 'mission.json')}),
    /task_id.*GitHub issue/i,
  );
});

test('complete verification measurement cannot conceal unavailable measurements', () => {
  const economic = economicIdentity();
  economic.usage.verification.measurement_status = 'complete';
  assert.throws(
    () => validateEconomicIdentity(economic),
    /measurement_status.*complete.*null|complete.*measurements/i,
  );
});

test('priced cost arithmetic reconciles source lines, subtotals, and the total exactly', () => {
  const economic = economicIdentity();
  economic.costs = {
    status: 'complete',
    currency: 'USD',
    lines: [...economic.costs.lines, {
      component: 'model_inference',
      measurement_class: 'calculated_from_usage',
      quantity: '2',
      unit: 'request',
      unit_rate: '0.50',
      amount: '1.00',
      currency: 'USD',
      source_refs: [{artifact: 'bundle/provider_usage.json', artifact_sha256: `sha256:${'8'.repeat(64)}`, json_pointer: '/requests'}],
      rate_card_digest: `sha256:${'9'.repeat(64)}`,
      allocation_method: null,
      finality: 'final',
      visibility: 'public',
    }],
    known_direct_cost: '1.00',
    allocated_shared_cost: '0',
    human_standard_cost: '0',
    total_economic_cost: '999.00',
    missing_components: [],
  };
  assert.throws(() => validateEconomicIdentity(economic), /total_economic_cost.*sum|total.*subtotals/i);

  economic.costs.total_economic_cost = '1.00';
  economic.costs.lines[1].amount = '1.01';
  assert.throws(() => validateEconomicIdentity(economic), /calculated.*amount|quantity.*unit rate/i);
});

test('legacy missions remain schema v1 while v2 renders the proofline visual hierarchy', async (t) => {
  const legacy = await buildReceiptViewModel({ missionFile: path.join(fixture, 'mission.json') });
  assert.equal(legacy.version, 1);

  const { directory } = await v2Mission(t);
  const indexFile = path.join(directory, 'missions', 'index.json');
  const siteFile = path.join(directory, 'site', 'index.html');
  await buildLedger({ missionsDir: path.join(directory, 'missions'), out: indexFile, now: generatedAt });
  await renderLedger({ indexPath: indexFile, out: siteFile, now: generatedAt });

  const html = await readFile(path.join(directory, 'site/receipts/M-005/index.html'), 'utf8');
  const receiptJson = JSON.parse(await readFile(path.join(directory, 'site/receipts/M-005/receipt.json'), 'utf8'));
  assert.equal(receiptJson.schema_version, 2);
  assert.equal(receiptJson.economic_identity.task.task_id, taskId);
  assert.match(html, /class="economic-overview"/);
  assert.match(html, /class="proof-hero"/);
  assert.match(html, /class="proofline-instrument"/);
  assert.match(html, /class="proofline-anatomy"/);
  assert.match(html, /class="anatomy-bar"/);
  assert.equal((html.match(/class="anatomy-segment"/g) ?? []).length, 4);
  assert.match(html, /ATTEMPT 1 \/ EXECUTION ANATOMY/);
  assert.match(html, /class="proof-score">1\/1</);
  assert.match(html, /class="attempt-proofline"/);
  assert.match(html, /class="proofline-stages"/);
  assert.match(html, /class="identity-flow"/);
  assert.equal((html.match(/class="flow-lede"/g) ?? []).length, 3);
  assert.match(html, /class="receipt-cost-total"/);
  assert.match(html, /TOTAL COST/);
  assert.match(html, /class="folio-watermark"/);
  assert.match(html, /class="receipt-provenance"/);
  assert.match(html, /class="evidence-drawer evidence-annex"/);
  assert.match(html, /<details class="annex-chapter annex-economic" open>/);
  assert.match(html, /<details class="annex-chapter annex-technical">/);
  assert.match(html, /<details class="annex-chapter annex-provenance">/);
  assert.match(html, /class="evidence-null"/);
  assert.equal((html.match(/<details class="evidence-drawer/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="glance-grid"/);
  assert.doesNotMatch(html, /class="identity-grid"/);
  assert.match(html, /Economic identity/);
  assert.match(html, /Known, unknown, and unpriced/);
  assert.match(html, /@keyframes proofline-reveal/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /--sans:/);
  assert.doesNotMatch(html, /setup \+ install \(derived\)/);
  assert.match(html, /unclassified executor time/i);

  const pageNav = html.match(/<header class="page-nav">[\s\S]*?<\/header>/)?.[0];
  assert.ok(pageNav);
  assert.doesNotMatch(pageNav, /Canonical receipt|Generated at/);
  assert.match(pageNav, /← Receipts/);
  assert.match(pageNav, />JSON</);

  // Optional visual-QA export: production rendering still supplies every byte; this only preserves
  // the otherwise-temporary test site for a real browser inspection.
  if (process.env.ECONOMIC_RECEIPT_QA_OUTPUT) {
    const qaOutput = path.resolve(process.env.ECONOMIC_RECEIPT_QA_OUTPUT);
    await rm(qaOutput, {recursive: true, force: true});
    await cp(path.join(directory, 'site'), qaOutput, {recursive: true});
  }
});

test('proofline groups repeated terminal attempts without hiding their recorded count', async (t) => {
  const economic = economicIdentity();
  economic.task.attempt_sequence = 7;
  economic.attempt_lineage = {
    attempts_total: 7,
    successful_attempt_id: 'M-005',
    attempts: [
      ...Array.from({length: 6}, (_, index) => ({
        attempt_id: `M-${String(index + 101).padStart(3, '0')}`,
        attempt_sequence: index + 1,
        state: 'FAILED_ORACLE',
        terminal_reason_class: 'verification',
      })),
      {attempt_id: 'M-005', attempt_sequence: 7, state: 'READY', terminal_reason_class: null},
    ],
  };
  const {directory} = await v2Mission(t, {economic});
  const indexFile = path.join(directory, 'missions', 'index.json');
  const siteFile = path.join(directory, 'site', 'index.html');
  await buildLedger({missionsDir: path.join(directory, 'missions'), out: indexFile, now: generatedAt});
  await renderLedger({indexPath: indexFile, out: siteFile, now: generatedAt});

  const html = await readFile(path.join(directory, 'site/receipts/M-005/index.html'), 'utf8');
  assert.match(html, /proofline-attempt--grouped/);
  assert.match(html, /class="attempt-group-bracket"/);
  assert.match(html, /data-attempt-count="6"/);
  assert.match(html, /ATTEMPTS 1–6/);
  assert.match(html, /6× FAILED ORACLE/);
  assert.equal((html.match(/class="attempt-cluster-mark"/g) ?? []).length, 6);
  assert.match(html, /M-101 → M-106/);
  assert.match(html, /aria-label="Attempts 1 through 6:/);
});
