const TOP_LEVEL_FIELDS = new Set([
  'mission_id',
  'variant',
  'claims_tier',
  'grade',
  'disclosure_label',
  'funding_source',
  'northset_role',
  'external_counterparty',
  'target_repo',
  'issue_or_task',
  'consent_artifact',
  'repo_policy_snapshot',
  'worker_identity',
  'base_commit',
  'patch_commit',
  'patch_diff_hash',
  'commands_declared',
  'environment',
  'run_record_bundle_digest',
  'attestation_uri',
  'maintainer_outcome',
  'payment',
  'limitations',
]);

const REQUIRED_FIELDS = [
  'mission_id',
  'variant',
  'claims_tier',
  'grade',
  'disclosure_label',
  'funding_source',
  'northset_role',
  'external_counterparty',
  'target_repo',
  'consent_artifact',
  'commands_declared',
  'maintainer_outcome',
  'payment',
  'limitations',
];

// author_contribution: Northset contributes a fix to an external repo and documents its OWN
// work. It is external (not own-repo) for tier/grade/side purposes, but needs NO maintainer
// consent — the receipt is about our own contribution, states who operated the runtime as
// data, and never claims maintainer verification.
const VARIANTS = new Set(['own_repo_rehearsal', 'V', 'W', 'F', 'author_contribution']);
// R3 (deterministic on-chain settlement) is deliberately NOT claimable in v0: no receipt can
// carry the settlement/predicate evidence that tier requires until the narrow-verifier track
// lands, and the program's decoupling rule keeps on-chain language off every OSS surface
// until then. Reintroduce R3 together with its required evidence fields, never before.
const CLAIMS_TIERS = new Set(['R0', 'R1', 'R2']);
// "External" for tier/side/counterparty/grade — anything that is not the own-repo rehearsal.
const EXTERNAL_VARIANTS = new Set(['V', 'W', 'F', 'author_contribution']);
// Consent is required only where we touch SOMEONE ELSE'S work (V/W/F); author_contribution is
// our own work and is consent-exempt.
const CONSENT_VARIANTS = new Set(['V', 'W', 'F']);
const EXTERNAL_GRADES = new Set(['B1', 'B+', 'A-', 'A']);
const DECIDED_OUTCOME_STATUSES = new Set(['merged', 'approved', 'rejected', 'silent']);
const ATTESTATION_URI_PREFIX = 'https://github.com/northset-oss/verification-pilot/';
const IMAGE_DIGEST_PATTERN = /^(?:[^\s@]+@)?sha256:[0-9a-fA-F]{64}$/;
const GRADES = new Set(['B0', 'B1', 'B+', 'A-', 'A']);
const NORTHSET_ROLES = new Set([
  'worker_runtime_operator',
  'funder',
  'verifier',
  'both_sides_disclosed',
]);
const OUTCOME_STATUSES = new Set([
  'merged',
  'approved',
  'rejected',
  'silent',
  'closed',
  'pending',
]);
const ATTRIBUTED_OUTCOME_STATUSES = new Set([
  'merged',
  'approved',
  'rejected',
  'closed',
]);
const MAINTAINER_PAYMENTS = new Set([
  'none',
  'fixed_review_honorarium',
  'post_decision_donation',
]);

const MISSION_ID_PATTERN = /^M-(\d{3}|E2[a-c])$/;
const COMMIT_PATTERN = /^[0-9a-fA-F]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-fA-F]{64}$/;
const REHEARSAL_DISCLOSURE = 'Self-funded rehearsal. Not external validation.';
const CONTRIBUTOR_DISCLOSURE = 'Contributor self-run. Not maintainer verification.';
const REQUIRED_LIMITATIONS = [
  'Does not prove code quality',
  'Does not prove security',
];
// Matched against NORMALIZED text (lowercased; hyphens/underscores/whitespace runs collapsed
// to single spaces), so "Production-Ready", "settled  on_chain", etc. cannot slip through on
// ordinary spelling variation. Threat model: honest-but-sloppy receipt authoring, not forgery.
const BANNED_PHRASES = [
  'proves tests pass',
  'proves code quality',
  'production ready',
  'customer',
  'marketplace',
];
const TIER_LANGUAGE_PHRASES = ['on chain', 'onchain', 'settlement'];

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function addError(errors, ruleId, path, message) {
  errors.push({ ruleId, path, message });
}

function checkType(errors, value, expected, path) {
  const valid =
    (expected === 'object' && isObject(value)) ||
    (expected === 'array' && Array.isArray(value)) ||
    (expected !== 'object' && expected !== 'array' && typeof value === expected);

  if (!valid) {
    addError(
      errors,
      'STRUCTURE_TYPE',
      path,
      `must be ${expected}; received ${describeType(value)}`,
    );
  }
  return valid;
}

function checkNullableType(errors, value, expected, path) {
  if (value === null) return true;
  return checkType(errors, value, expected, path);
}

function checkEnum(errors, value, allowed, path) {
  if (!allowed.has(value)) {
    addError(
      errors,
      'STRUCTURE_ENUM',
      path,
      `must be one of ${[...allowed].join(', ')}`,
    );
    return false;
  }
  return true;
}

function checkPattern(errors, value, pattern, expected, path) {
  if (!pattern.test(value)) {
    addError(errors, 'STRUCTURE_PATTERN', path, `must match ${expected}`);
    return false;
  }
  return true;
}

// URL fields are rendered as href targets on the public ledger, so only http(s) is allowed —
// this rejects javascript:/data:/file: and similar script-bearing or local schemes at the
// single validation chokepoint, keeping every downstream receipt surface XSS-safe.
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:']);

function isUri(value) {
  try {
    const parsed = new URL(value);
    return ALLOWED_URL_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

function checkUri(errors, value, path) {
  if (!isUri(value)) {
    addError(errors, 'STRUCTURE_FORMAT', path, 'must be an absolute http(s) URL');
    return false;
  }
  return true;
}

function isIsoDateTime(value) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 60 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function checkDateTime(errors, value, path) {
  if (!isIsoDateTime(value)) {
    addError(errors, 'STRUCTURE_FORMAT', path, 'must be an ISO-8601 date-time');
    return false;
  }
  return true;
}

function checkAdditionalProperties(errors, value, allowedFields, path) {
  for (const key of Object.keys(value).sort()) {
    if (!allowedFields.has(key)) {
      addError(
        errors,
        'STRUCTURE_ADDITIONAL_PROPERTY',
        `${path}.${key}`,
        'is not an allowed property',
      );
    }
  }
}

function checkRequiredProperties(errors, value, fields, path) {
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      addError(
        errors,
        'STRUCTURE_REQUIRED',
        `${path}.${field}`,
        'is required',
      );
    }
  }
}

function validateStringArray(errors, value, path, { minItems = 0, unique = false } = {}) {
  if (!checkType(errors, value, 'array', path)) return false;

  if (value.length < minItems) {
    addError(
      errors,
      'STRUCTURE_MIN_ITEMS',
      path,
      `must contain at least ${minItems} item${minItems === 1 ? '' : 's'}`,
    );
  }

  if (unique && new Set(value).size !== value.length) {
    addError(errors, 'STRUCTURE_UNIQUE_ITEMS', path, 'must contain unique items');
  }

  value.forEach((item, index) => {
    checkType(errors, item, 'string', `${path}[${index}]`);
  });
  return true;
}

function validateRepoPolicySnapshot(errors, value) {
  const path = '$.repo_policy_snapshot';
  if (value === null) return;
  if (!checkType(errors, value, 'object', path)) return;

  const fields = new Set(['url', 'checked_at', 'ai_policy_summary']);
  checkAdditionalProperties(errors, value, fields, path);
  checkRequiredProperties(errors, value, [...fields], path);

  if (Object.hasOwn(value, 'url') && checkType(errors, value.url, 'string', `${path}.url`)) {
    checkUri(errors, value.url, `${path}.url`);
  }
  if (
    Object.hasOwn(value, 'checked_at') &&
    checkType(errors, value.checked_at, 'string', `${path}.checked_at`)
  ) {
    checkDateTime(errors, value.checked_at, `${path}.checked_at`);
  }
  if (Object.hasOwn(value, 'ai_policy_summary')) {
    checkType(errors, value.ai_policy_summary, 'string', `${path}.ai_policy_summary`);
  }
}

function validateWorkerIdentity(errors, value) {
  const path = '$.worker_identity';
  if (value === null) return;
  if (!checkType(errors, value, 'object', path)) return;

  const fields = new Set(['runtime', 'human_operator']);
  checkAdditionalProperties(errors, value, fields, path);
  checkRequiredProperties(errors, value, [...fields], path);
  for (const field of fields) {
    if (Object.hasOwn(value, field)) {
      checkType(errors, value[field], 'string', `${path}.${field}`);
    }
  }
}

function validateEnvironment(errors, value) {
  const path = '$.environment';
  if (value === null) return;
  if (!checkType(errors, value, 'object', path)) return;

  const fields = new Set(['container_image_digest', 'network_policy']);
  checkAdditionalProperties(errors, value, fields, path);
  checkRequiredProperties(errors, value, [...fields], path);

  if (Object.hasOwn(value, 'container_image_digest')) {
    if (
      checkNullableType(
        errors,
        value.container_image_digest,
        'string',
        `${path}.container_image_digest`,
      ) &&
      value.container_image_digest !== null
    ) {
      checkPattern(
        errors,
        value.container_image_digest,
        IMAGE_DIGEST_PATTERN,
        'an optional image reference followed by sha256: and 64 hexadecimal characters',
        `${path}.container_image_digest`,
      );
    }
  }
  if (Object.hasOwn(value, 'network_policy')) {
    checkType(errors, value.network_policy, 'string', `${path}.network_policy`);
  }
}

function validateMaintainerOutcome(errors, value) {
  const path = '$.maintainer_outcome';
  if (!checkType(errors, value, 'object', path)) return;

  const fields = new Set(['status', 'link', 'decided_at']);
  checkAdditionalProperties(errors, value, fields, path);
  checkRequiredProperties(errors, value, [...fields], path);

  if (Object.hasOwn(value, 'status') && checkType(errors, value.status, 'string', `${path}.status`)) {
    checkEnum(errors, value.status, OUTCOME_STATUSES, `${path}.status`);
  }
  if (
    Object.hasOwn(value, 'link') &&
    checkNullableType(errors, value.link, 'string', `${path}.link`) &&
    value.link !== null
  ) {
    checkUri(errors, value.link, `${path}.link`);
  }
  if (
    Object.hasOwn(value, 'decided_at') &&
    checkNullableType(errors, value.decided_at, 'string', `${path}.decided_at`) &&
    value.decided_at !== null
  ) {
    checkDateTime(errors, value.decided_at, `${path}.decided_at`);
  }
}

function validatePayment(errors, value) {
  const path = '$.payment';
  if (!checkType(errors, value, 'object', path)) return;

  const fields = new Set(['maintainer_payment', 'merge_contingent']);
  checkAdditionalProperties(errors, value, fields, path);
  checkRequiredProperties(errors, value, [...fields], path);

  if (
    Object.hasOwn(value, 'maintainer_payment') &&
    checkType(errors, value.maintainer_payment, 'string', `${path}.maintainer_payment`)
  ) {
    checkEnum(errors, value.maintainer_payment, MAINTAINER_PAYMENTS, `${path}.maintainer_payment`);
  }
  if (Object.hasOwn(value, 'merge_contingent')) {
    checkType(errors, value.merge_contingent, 'boolean', `${path}.merge_contingent`);
  }
}

function validateStructural(receipt, errors) {
  if (!checkType(errors, receipt, 'object', '$')) return false;

  checkAdditionalProperties(errors, receipt, TOP_LEVEL_FIELDS, '$');
  checkRequiredProperties(errors, receipt, REQUIRED_FIELDS, '$');

  if (
    Object.hasOwn(receipt, 'mission_id') &&
    checkType(errors, receipt.mission_id, 'string', '$.mission_id')
  ) {
    checkPattern(errors, receipt.mission_id, MISSION_ID_PATTERN, '^M-(\\d{3}|E2[a-c])$', '$.mission_id');
  }

  if (
    Object.hasOwn(receipt, 'variant') &&
    checkType(errors, receipt.variant, 'string', '$.variant')
  ) {
    checkEnum(errors, receipt.variant, VARIANTS, '$.variant');
  }

  if (Object.hasOwn(receipt, 'claims_tier')) {
    // An EMPTY claims_tier is legal and means "no claim yet": tiers are achieved evidence
    // levels, added only once their evidence exists (an in-flight external mission has none).
    if (validateStringArray(errors, receipt.claims_tier, '$.claims_tier', { unique: true })) {
      receipt.claims_tier.forEach((tier, index) => {
        if (typeof tier === 'string') {
          checkEnum(errors, tier, CLAIMS_TIERS, `$.claims_tier[${index}]`);
        }
      });
    }
  }

  if (Object.hasOwn(receipt, 'grade') && receipt.grade !== null) {
    if (checkType(errors, receipt.grade, 'string', '$.grade')) {
      checkEnum(errors, receipt.grade, GRADES, '$.grade');
    }
  }

  for (const field of ['disclosure_label', 'funding_source']) {
    if (Object.hasOwn(receipt, field)) {
      checkType(errors, receipt[field], 'string', `$.${field}`);
    }
  }

  if (
    Object.hasOwn(receipt, 'northset_role') &&
    checkType(errors, receipt.northset_role, 'string', '$.northset_role')
  ) {
    checkEnum(errors, receipt.northset_role, NORTHSET_ROLES, '$.northset_role');
  }

  if (Object.hasOwn(receipt, 'external_counterparty')) {
    checkNullableType(errors, receipt.external_counterparty, 'string', '$.external_counterparty');
  }

  if (
    Object.hasOwn(receipt, 'target_repo') &&
    checkType(errors, receipt.target_repo, 'string', '$.target_repo')
  ) {
    checkUri(errors, receipt.target_repo, '$.target_repo');
  }

  for (const field of ['issue_or_task', 'consent_artifact', 'attestation_uri']) {
    if (
      Object.hasOwn(receipt, field) &&
      checkNullableType(errors, receipt[field], 'string', `$.${field}`) &&
      receipt[field] !== null
    ) {
      checkUri(errors, receipt[field], `$.${field}`);
    }
  }

  if (Object.hasOwn(receipt, 'repo_policy_snapshot')) {
    validateRepoPolicySnapshot(errors, receipt.repo_policy_snapshot);
  }
  if (Object.hasOwn(receipt, 'worker_identity')) {
    validateWorkerIdentity(errors, receipt.worker_identity);
  }

  for (const field of ['base_commit', 'patch_commit']) {
    if (
      Object.hasOwn(receipt, field) &&
      checkNullableType(errors, receipt[field], 'string', `$.${field}`) &&
      receipt[field] !== null
    ) {
      checkPattern(errors, receipt[field], COMMIT_PATTERN, '40 hexadecimal characters', `$.${field}`);
    }
  }

  for (const field of ['patch_diff_hash', 'run_record_bundle_digest']) {
    if (
      Object.hasOwn(receipt, field) &&
      checkNullableType(errors, receipt[field], 'string', `$.${field}`) &&
      receipt[field] !== null
    ) {
      checkPattern(
        errors,
        receipt[field],
        SHA256_PATTERN,
        'sha256: followed by 64 hexadecimal characters',
        `$.${field}`,
      );
    }
  }

  if (Object.hasOwn(receipt, 'commands_declared')) {
    validateStringArray(errors, receipt.commands_declared, '$.commands_declared');
  }
  if (Object.hasOwn(receipt, 'environment')) {
    validateEnvironment(errors, receipt.environment);
  }
  if (Object.hasOwn(receipt, 'maintainer_outcome')) {
    validateMaintainerOutcome(errors, receipt.maintainer_outcome);
  }
  if (Object.hasOwn(receipt, 'payment')) {
    validatePayment(errors, receipt.payment);
  }
  if (Object.hasOwn(receipt, 'limitations')) {
    validateStringArray(errors, receipt.limitations, '$.limitations', { minItems: 1 });
  }

  return true;
}

function normalizeFreeText(value) {
  return value.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

function collectFreeText(receipt) {
  const entries = [];
  const add = (path, value) => {
    if (typeof value === 'string') entries.push({ path, value });
  };

  add('$.disclosure_label', receipt.disclosure_label);
  add('$.funding_source', receipt.funding_source);
  add('$.external_counterparty', receipt.external_counterparty);
  add('$.repo_policy_snapshot.ai_policy_summary', receipt.repo_policy_snapshot?.ai_policy_summary);
  add('$.worker_identity.runtime', receipt.worker_identity?.runtime);
  add('$.worker_identity.human_operator', receipt.worker_identity?.human_operator);
  add('$.environment.network_policy', receipt.environment?.network_policy);

  if (Array.isArray(receipt.commands_declared)) {
    receipt.commands_declared.forEach((value, index) => add(`$.commands_declared[${index}]`, value));
  }
  if (Array.isArray(receipt.limitations)) {
    receipt.limitations.forEach((value, index) => add(`$.limitations[${index}]`, value));
  }

  return entries;
}

function validatePolicy(receipt, errors) {
  if (
    ATTRIBUTED_OUTCOME_STATUSES.has(receipt.maintainer_outcome?.status) &&
    !isUri(receipt.maintainer_outcome?.link)
  ) {
    addError(
      errors,
      'OUTCOME_EVIDENCE_REQUIRED',
      '$.maintainer_outcome.link',
      'attributed maintainer outcomes require a non-null http(s) evidence URL',
    );
  }

  if (
    CONSENT_VARIANTS.has(receipt.variant) &&
    (typeof receipt.consent_artifact !== 'string' || !isUri(receipt.consent_artifact))
  ) {
    addError(
      errors,
      'CONSENT_REQUIRED',
      '$.consent_artifact',
      `variant ${receipt.variant} requires a non-null consent artifact URL`,
    );
  }

  if (receipt.payment?.merge_contingent !== false) {
    addError(
      errors,
      'MERGE_CONTINGENT_FORBIDDEN',
      '$.payment.merge_contingent',
      'must be false',
    );
  }

  if (
    receipt.payment?.maintainer_payment === 'post_decision_donation' &&
    receipt.maintainer_outcome?.status === 'pending'
  ) {
    addError(
      errors,
      'PAYMENT_TIMING',
      '$.payment.maintainer_payment',
      'post_decision_donation requires a maintainer decision; the outcome is still pending',
    );
  }

  // Tier ↔ variant matrix: R0 is the own-repo rehearsal tier; R1/R2 are external-mission
  // tiers. A tier may be claimed only where the law's table places it.
  if (Array.isArray(receipt.claims_tier)) {
    if (receipt.claims_tier.includes('R0') && receipt.variant !== 'own_repo_rehearsal') {
      addError(
        errors,
        'TIER_VARIANT',
        '$.claims_tier',
        'R0 is permitted only for own_repo_rehearsal receipts',
      );
    }
    for (const tier of ['R1', 'R2']) {
      if (receipt.claims_tier.includes(tier) && !EXTERNAL_VARIANTS.has(receipt.variant)) {
        addError(
          errors,
          'TIER_VARIANT',
          '$.claims_tier',
          `${tier} is permitted only for external (V, W, F) receipts`,
        );
      }
    }

    // Tier evidence gates: a tier is an ACHIEVED claim, so its evidence must be present.
    if (
      receipt.claims_tier.includes('R1') &&
      // == null: an absent optional field is as evidence-free as an explicit null.
      (receipt.attestation_uri == null ||
        receipt.run_record_bundle_digest == null ||
        receipt.environment == null)
    ) {
      addError(
        errors,
        'R1_EVIDENCE',
        '$.claims_tier',
        'R1 requires non-null attestation_uri, run_record_bundle_digest, and environment',
      );
    }
    if (
      receipt.claims_tier.includes('R2') &&
      !DECIDED_OUTCOME_STATUSES.has(receipt.maintainer_outcome?.status)
    ) {
      addError(
        errors,
        'R2_OUTCOME',
        '$.claims_tier',
        'R2 requires an external maintainer decision (merged, approved, rejected, or silent)',
      );
    }
    // A tier that asserts a run happened must NAME the code that ran, so the pipeline's code
    // binding can prove it. An R1/R2 receipt with a null base_commit binds to nothing.
    if (
      (receipt.claims_tier.includes('R1') || receipt.claims_tier.includes('R2')) &&
      (receipt.base_commit === null || receipt.base_commit === undefined)
    ) {
      addError(
        errors,
        'CODE_IDENTITY',
        '$.base_commit',
        'R1/R2 receipts require a non-null base_commit so the code that ran can be proven',
      );
    }
  }

  // An attestation URI must point at this repository's releases/attestations — any other
  // origin would render "Attested: Yes" on the public ledger for a URL our workflow never
  // signed.
  if (
    typeof receipt.attestation_uri === 'string' &&
    !receipt.attestation_uri.startsWith(ATTESTATION_URI_PREFIX)
  ) {
    addError(
      errors,
      'ATTESTATION_ORIGIN',
      '$.attestation_uri',
      `must start with ${ATTESTATION_URI_PREFIX}`,
    );
  }

  // Side alternation: Northset is never both sides of the same external mission, and an
  // external mission needs a real external counterparty; a rehearsal has none.
  if (receipt.northset_role === 'both_sides_disclosed' && EXTERNAL_VARIANTS.has(receipt.variant)) {
    addError(
      errors,
      'SIDE_ALTERNATION',
      '$.northset_role',
      'both_sides_disclosed is permitted only for own_repo_rehearsal receipts',
    );
  }
  if (EXTERNAL_VARIANTS.has(receipt.variant) && receipt.external_counterparty === null) {
    addError(
      errors,
      'EXTERNAL_COUNTERPARTY',
      '$.external_counterparty',
      `variant ${receipt.variant} requires a non-null external counterparty`,
    );
  }
  if (receipt.variant === 'own_repo_rehearsal' && receipt.external_counterparty != null) {
    addError(
      errors,
      'EXTERNAL_COUNTERPARTY',
      '$.external_counterparty',
      'own_repo_rehearsal receipts must have a null external counterparty',
    );
  }

  // M-E2a..c are reserved for Algora-board bounty missions, which are funder-side (F).
  if (/^M-E2[a-c]$/.test(receipt.mission_id) && receipt.variant !== 'F') {
    addError(
      errors,
      'E2_VARIANT',
      '$.mission_id',
      'M-E2 mission ids are reserved for variant F (funded bounty) receipts',
    );
  }

  if (
    receipt.variant === 'own_repo_rehearsal' &&
    (typeof receipt.disclosure_label !== 'string' || !receipt.disclosure_label.includes(REHEARSAL_DISCLOSURE))
  ) {
    addError(
      errors,
      'REHEARSAL_LABEL',
      '$.disclosure_label',
      `must contain the exact substring "${REHEARSAL_DISCLOSURE}"`,
    );
  }

  // author_contribution states plainly, on the record itself, that Northset ran its own
  // work — it is not the maintainer's verification. Enforced like the rehearsal label:
  // honesty as data, not a lawyer-reviewed disclaimer.
  if (receipt.variant === 'author_contribution') {
    if (
      typeof receipt.disclosure_label !== 'string' ||
      !receipt.disclosure_label.includes(CONTRIBUTOR_DISCLOSURE)
    ) {
      addError(
        errors,
        'CONTRIBUTOR_LABEL',
        '$.disclosure_label',
        `must contain the exact substring "${CONTRIBUTOR_DISCLOSURE}"`,
      );
    }
    // A real contribution names the upstream commit it is built on, so the code binding can
    // prove it. A null base_commit is not honest for an external contribution.
    if (receipt.base_commit === null || receipt.base_commit === undefined) {
      addError(
        errors,
        'CONTRIBUTION_BASE_COMMIT',
        '$.base_commit',
        'author_contribution requires a non-null base_commit (the upstream commit contributed against)',
      );
    }
    // Mechanical distinction from a consent-requiring verification (V/W/F): a contribution is
    // OUR patch, run by OUR worker runtime. Requiring the operator role + a declared patch hash
    // means a V/W/F mission cannot simply relabel itself author_contribution to dodge consent
    // without actually applying a patch we authored (which the pipeline then binds).
    if (receipt.northset_role !== 'worker_runtime_operator') {
      addError(
        errors,
        'CONTRIBUTION_ROLE',
        '$.northset_role',
        'author_contribution requires northset_role "worker_runtime_operator"',
      );
    }
    if (receipt.patch_diff_hash === null || receipt.patch_diff_hash === undefined) {
      addError(
        errors,
        'CONTRIBUTION_PATCH',
        '$.patch_diff_hash',
        'author_contribution requires a non-null patch_diff_hash (a contribution changes code)',
      );
    }
  }

  if (
    receipt.grade === 'B+' &&
    !['merged', 'approved'].includes(receipt.maintainer_outcome?.status)
  ) {
    addError(
      errors,
      'GRADE_OUTCOME_CONSISTENCY',
      '$.maintainer_outcome.status',
      'grade B+ requires a merged or approved maintainer outcome',
    );
  }
  if (
    receipt.grade === 'B1' &&
    !DECIDED_OUTCOME_STATUSES.has(receipt.maintainer_outcome?.status)
  ) {
    addError(
      errors,
      'GRADE_OUTCOME_CONSISTENCY',
      '$.maintainer_outcome.status',
      'grade B1 requires a maintainer decision; use a null grade while the outcome is pending',
    );
  }
  if (receipt.grade === 'B0' && receipt.variant !== 'own_repo_rehearsal') {
    addError(
      errors,
      'GRADE_OUTCOME_CONSISTENCY',
      '$.variant',
      'grade B0 is permitted only for own_repo_rehearsal receipts',
    );
  }
  // External grades assert an external mission: a rehearsal cannot earn B1/B+/A-/A.
  if (EXTERNAL_GRADES.has(receipt.grade) && !EXTERNAL_VARIANTS.has(receipt.variant)) {
    addError(
      errors,
      'GRADE_VARIANT',
      '$.grade',
      `grade ${receipt.grade} is permitted only for external (V, W, F) receipts`,
    );
  }

  if (Array.isArray(receipt.limitations)) {
    const missing = REQUIRED_LIMITATIONS.filter((limitation) => !receipt.limitations.includes(limitation));
    if (missing.length > 0) {
      addError(
        errors,
        'LIMITATIONS_BASELINE',
        '$.limitations',
        `must include exactly: ${missing.map((item) => `"${item}"`).join(' and ')}`,
      );
    }
  }

  const freeText = collectFreeText(receipt);
  for (const { path, value } of freeText) {
    const normalized = normalizeFreeText(value);
    for (const phrase of BANNED_PHRASES) {
      if (normalized.includes(phrase)) {
        addError(
          errors,
          'BANNED_PHRASES',
          path,
          `contains forbidden phrase "${phrase}"`,
        );
      }
    }
    // No claimable tier permits settlement language in v0 (R3 is not claimable), so
    // on-chain/settlement wording is rejected unconditionally.
    for (const phrase of TIER_LANGUAGE_PHRASES) {
      if (normalized.includes(phrase)) {
        addError(
          errors,
          'TIER_LANGUAGE',
          path,
          `contains "${phrase}", which no v0 claims tier permits`,
        );
      }
    }
  }
}

/**
 * Validate one parsed mission receipt against the v0 structure and policy rules.
 *
 * @param {unknown} receipt
 * @returns {{valid: boolean, errors: Array<{ruleId: string, path: string, message: string}>}}
 */
export function validateMission(receipt) {
  const errors = [];
  if (validateStructural(receipt, errors)) {
    validatePolicy(receipt, errors);
  }
  return { valid: errors.length === 0, errors };
}
