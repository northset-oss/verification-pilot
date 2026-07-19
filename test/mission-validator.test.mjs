import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateMission } from '../lib/mission-validator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const examplesDirectory = path.join(root, 'examples');
const invalidDirectory = path.join(root, 'test/fixtures/invalid');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function baseReceipt() {
  return readJson(path.join(examplesDirectory, 'M-001_own_repo_rehearsal.json'));
}

function ruleIds(result) {
  return result.errors.map((error) => error.ruleId);
}

test('all canonical examples pass validation', async (t) => {
  const names = (await readdir(examplesDirectory)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, [
    'M-001_own_repo_rehearsal.json',
    'M-004_verification_give.json',
    'M-005_worker_mission.json',
    'M-006_author_contribution.json',
  ]);

  for (const name of names) {
    await t.test(name, async () => {
      const result = validateMission(await readJson(path.join(examplesDirectory, name)));
      assert.deepEqual(result, { valid: true, errors: [] });
    });
  }
});

test('each policy fixture fails only its named rule', async (t) => {
  const expectedRules = new Map([
    ['attestation_origin.json', 'ATTESTATION_ORIGIN'],
    ['banned_phrases.json', 'BANNED_PHRASES'],
    ['code_identity.json', 'CODE_IDENTITY'],
    ['consent_required.json', 'CONSENT_REQUIRED'],
    ['contribution_base_commit.json', 'CONTRIBUTION_BASE_COMMIT'],
    ['contribution_patch.json', 'CONTRIBUTION_PATCH'],
    ['contribution_role.json', 'CONTRIBUTION_ROLE'],
    ['contributor_label.json', 'CONTRIBUTOR_LABEL'],
    ['e2_variant.json', 'E2_VARIANT'],
    ['external_counterparty.json', 'EXTERNAL_COUNTERPARTY'],
    ['grade_outcome_consistency.json', 'GRADE_OUTCOME_CONSISTENCY'],
    ['grade_variant.json', 'GRADE_VARIANT'],
    ['image_digest_format.json', 'STRUCTURE_PATTERN'],
    ['limitations_baseline.json', 'LIMITATIONS_BASELINE'],
    ['merge_contingent_forbidden.json', 'MERGE_CONTINGENT_FORBIDDEN'],
    ['payment_timing.json', 'PAYMENT_TIMING'],
    ['r1_evidence.json', 'R1_EVIDENCE'],
    ['r2_outcome.json', 'R2_OUTCOME'],
    ['rehearsal_label.json', 'REHEARSAL_LABEL'],
    ['side_alternation.json', 'SIDE_ALTERNATION'],
    ['tier_language.json', 'TIER_LANGUAGE'],
    ['tier_variant.json', 'TIER_VARIANT'],
  ]);
  const names = (await readdir(invalidDirectory)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(names, [...expectedRules.keys()].sort());

  for (const name of names) {
    await t.test(name, async () => {
      const result = validateMission(await readJson(path.join(invalidDirectory, name)));
      assert.equal(result.valid, false);
      assert.deepEqual(ruleIds(result), [expectedRules.get(name)]);
    });
  }
});

test('CONSENT_REQUIRED covers V, W, and F variants', async (t) => {
  for (const variant of ['V', 'W', 'F']) {
    await t.test(variant, async () => {
      const receipt = await baseReceipt();
      receipt.variant = variant;
      receipt.grade = 'B1';
      receipt.consent_artifact = null;
      assert.ok(ruleIds(validateMission(receipt)).includes('CONSENT_REQUIRED'));
    });
  }
});

test('URL fields reject non-http(s) schemes (ledger renders them as hrefs)', async (t) => {
  for (const scheme of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    await t.test(scheme, async () => {
      const receipt = await baseReceipt();
      receipt.variant = 'V';
      receipt.grade = 'B1';
      receipt.consent_artifact = 'https://example.com/consent';
      receipt.target_repo = scheme;
      const result = validateMission(receipt);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.path === '$.target_repo'));
    });
  }
});

test('both GRADE_OUTCOME_CONSISTENCY branches are enforced', async (t) => {
  await t.test('B+ requires an accepted outcome', async () => {
    const receipt = await baseReceipt();
    receipt.variant = 'W';
    receipt.grade = 'B+';
    receipt.consent_artifact = 'https://example.com/consent';
    assert.ok(ruleIds(validateMission(receipt)).includes('GRADE_OUTCOME_CONSISTENCY'));
  });

  await t.test('B0 requires own_repo_rehearsal', async () => {
    const receipt = await baseReceipt();
    receipt.variant = 'V';
    receipt.consent_artifact = 'https://example.com/consent';
    assert.ok(ruleIds(validateMission(receipt)).includes('GRADE_OUTCOME_CONSISTENCY'));
  });
});

test('all banned phrases are matched case-insensitively and across spelling variants', async (t) => {
  const phrases = [
    'Proves Tests Pass',
    'Proves Code Quality',
    'Production Ready',
    'Production-Ready',
    'production_ready',
    'Customer',
    'Marketplace',
  ];

  for (const phrase of phrases) {
    await t.test(phrase, async () => {
      const receipt = await baseReceipt();
      receipt.funding_source = `Fixture text: ${phrase}`;
      assert.ok(ruleIds(validateMission(receipt)).includes('BANNED_PHRASES'));
    });
  }
});

test('banned phrases cover every free-text field', async (t) => {
  const cases = [
    ['$.disclosure_label', (receipt) => { receipt.disclosure_label += ' Marketplace'; }],
    ['$.funding_source', (receipt) => { receipt.funding_source = 'Marketplace'; }],
    ['$.external_counterparty', (receipt) => { receipt.external_counterparty = 'Marketplace'; }],
    ['$.repo_policy_snapshot.ai_policy_summary', (receipt) => {
      receipt.repo_policy_snapshot.ai_policy_summary = 'Marketplace';
    }],
    ['$.worker_identity.runtime', (receipt) => { receipt.worker_identity.runtime = 'Marketplace'; }],
    ['$.worker_identity.human_operator', (receipt) => {
      receipt.worker_identity.human_operator = 'Marketplace';
    }],
    ['$.environment.network_policy', (receipt) => {
      receipt.environment.network_policy = 'Marketplace';
    }],
    ['$.commands_declared[0]', (receipt) => { receipt.commands_declared[0] = 'Marketplace'; }],
    ['$.limitations[2]', (receipt) => { receipt.limitations[2] = 'Marketplace'; }],
  ];

  for (const [expectedPath, mutate] of cases) {
    await t.test(expectedPath, async () => {
      const receipt = await baseReceipt();
      mutate(receipt);
      const violation = validateMission(receipt).errors.find(
        (error) => error.ruleId === 'BANNED_PHRASES',
      );
      assert.equal(violation?.path, expectedPath);
    });
  }
});

test('TIER_LANGUAGE rejects settlement wording regardless of claimed tiers', async (t) => {
  for (const phrase of [
    'on-chain evidence',
    'settlement evidence',
    'SETTLED ON-CHAIN',
    'settled_onchain',
    'On Chain anchoring',
  ]) {
    await t.test(phrase, async () => {
      const receipt = await baseReceipt();
      receipt.funding_source = phrase;
      assert.ok(ruleIds(validateMission(receipt)).includes('TIER_LANGUAGE'));
    });
  }
});

test('R3 is not a claimable tier in v0', async () => {
  const receipt = await baseReceipt();
  receipt.claims_tier = ['R3'];

  assert.ok(ruleIds(validateMission(receipt)).includes('STRUCTURE_ENUM'));
});

test('author_contribution needs NO maintainer consent (it is our own work)', async () => {
  const contribution = await readJson(path.join(examplesDirectory, 'M-006_author_contribution.json'));
  assert.equal(contribution.consent_artifact, null);
  assert.deepEqual(validateMission(contribution), { valid: true, errors: [] });

  // ...but it must state, as data, that it is a contributor self-run, not maintainer verification.
  const stripped = { ...contribution, disclosure_label: 'Northset contributed this.' };
  assert.ok(ruleIds(validateMission(stripped)).includes('CONTRIBUTOR_LABEL'));

  // ...and it cannot masquerade as an own-repo rehearsal tier (R0 is own-repo only).
  const r0 = { ...contribution, claims_tier: ['R0'] };
  assert.ok(ruleIds(validateMission(r0)).includes('TIER_VARIANT'));
});

test('an empty claims_tier is a valid "no claim yet" receipt', async () => {
  const receipt = await baseReceipt();
  receipt.variant = 'V';
  receipt.grade = null;
  receipt.claims_tier = [];
  receipt.external_counterparty = 'External maintainer';
  receipt.consent_artifact = 'https://example.com/consent';
  receipt.northset_role = 'verifier';

  assert.deepEqual(validateMission(receipt), { valid: true, errors: [] });
});

test('B+ accepts an approved outcome on a coherent external receipt', async () => {
  const receipt = await baseReceipt();
  receipt.variant = 'V';
  receipt.grade = 'B+';
  receipt.claims_tier = ['R2'];
  receipt.external_counterparty = 'External maintainer';
  receipt.consent_artifact = 'https://example.com/consent';
  receipt.northset_role = 'verifier';
  receipt.maintainer_outcome.status = 'approved';
  receipt.maintainer_outcome.link = 'https://example.com/maintainer/decision';

  assert.deepEqual(validateMission(receipt), { valid: true, errors: [] });
});

test('attributed maintainer outcomes require linked evidence', async (t) => {
  for (const status of ['merged', 'approved', 'rejected', 'closed']) {
    await t.test(status, async () => {
      const receipt = await baseReceipt();
      receipt.maintainer_outcome.status = status;
      receipt.maintainer_outcome.link = null;

      const missingEvidence = validateMission(receipt);
      assert.equal(missingEvidence.valid, false);
      assert.ok(missingEvidence.errors.some(
        (error) => error.ruleId === 'OUTCOME_EVIDENCE_REQUIRED' &&
          error.path === '$.maintainer_outcome.link',
      ));

      receipt.maintainer_outcome.link = 'https://example.com/maintainer/decision';
      assert.deepEqual(validateMission(receipt), { valid: true, errors: [] });
    });
  }
});

test('unattributed maintainer outcomes do not require linked evidence', async (t) => {
  for (const status of ['silent', 'pending']) {
    await t.test(status, async () => {
      const receipt = await baseReceipt();
      receipt.maintainer_outcome.status = status;
      receipt.maintainer_outcome.link = null;

      assert.ok(!ruleIds(validateMission(receipt)).includes('OUTCOME_EVIDENCE_REQUIRED'));
    });
  }
});

test('structural validation covers the exact v0 constraints', async (t) => {
  const cases = [
    {
      name: 'top-level object',
      mutate: () => null,
      rule: 'STRUCTURE_TYPE',
    },
    {
      name: 'required properties',
      mutate: (receipt) => {
        delete receipt.mission_id;
        return receipt;
      },
      rule: 'STRUCTURE_REQUIRED',
    },
    {
      name: 'additional properties',
      mutate: (receipt) => ({ ...receipt, unexpected: true }),
      rule: 'STRUCTURE_ADDITIONAL_PROPERTY',
    },
    {
      name: 'mission ID pattern',
      mutate: (receipt) => ({ ...receipt, mission_id: 'M-12' }),
      rule: 'STRUCTURE_PATTERN',
    },
    {
      name: 'R4 is excluded',
      mutate: (receipt) => ({ ...receipt, claims_tier: ['R4'] }),
      rule: 'STRUCTURE_ENUM',
    },
    {
      name: 'claim tiers are unique',
      mutate: (receipt) => ({ ...receipt, claims_tier: ['R0', 'R0'] }),
      rule: 'STRUCTURE_UNIQUE_ITEMS',
    },
    {
      name: 'URLs are absolute',
      mutate: (receipt) => ({ ...receipt, target_repo: '/relative' }),
      rule: 'STRUCTURE_FORMAT',
    },
    {
      name: 'timestamps are real ISO-8601 date-times',
      mutate: (receipt) => {
        receipt.repo_policy_snapshot.checked_at = '2026-02-30T25:00:00Z';
        return receipt;
      },
      rule: 'STRUCTURE_FORMAT',
    },
    {
      name: 'commit identifiers contain 40 hex characters',
      mutate: (receipt) => ({ ...receipt, base_commit: 'not-a-commit' }),
      rule: 'STRUCTURE_PATTERN',
    },
    {
      name: 'nested members are required',
      mutate: (receipt) => {
        delete receipt.payment.maintainer_payment;
        return receipt;
      },
      rule: 'STRUCTURE_REQUIRED',
    },
  ];

  for (const { name, mutate, rule } of cases) {
    await t.test(name, async () => {
      const receipt = mutate(await baseReceipt());
      assert.ok(ruleIds(validateMission(receipt)).includes(rule));
    });
  }
});

test('schema declares draft 2020-12 and package stays dependency-free', async () => {
  const schema = await readJson(path.join(root, 'schema/mission.schema.json'));
  const packageJson = await readJson(path.join(root, 'package.json'));

  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false);
  assert.equal(Object.hasOwn(packageJson, 'devDependencies'), false);
});
