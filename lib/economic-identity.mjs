import {createHash} from 'node:crypto';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_ID = /^TASK-OSS-[0-9A-F]{16}$/;
const MISSION_ID = /^M-(?:[0-9]{3,}|E2[a-c])$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_CATEGORIES = new Set([
  'defect_fix', 'compatibility_fix', 'developer_tooling_fix',
  'documentation_fix', 'test_infrastructure_fix',
]);
const COST_CLASSES = new Set([
  'provider_billed', 'provider_metered', 'calculated_from_usage',
  'allocated_shared_cost', 'standard_labor_cost',
  'observed_quantity_unpriced', 'unavailable',
]);

function object(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exact(value, fields, label) {
  const extra = Object.keys(value).filter((key) => !fields.includes(key));
  const missing = fields.filter((key) => !Object.hasOwn(value, key));
  if (extra.length) throw new TypeError(`${label} contains unsupported field ${extra[0]}`);
  if (missing.length) throw new TypeError(`${label}.${missing[0]} is required`);
}

function string(value, label, {nullable = false, pattern = null} = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-blank string${nullable ? ' or null' : ''}`);
  if (pattern && !pattern.test(value)) throw new TypeError(`${label} has an invalid format`);
  return value;
}

function integer(value, label, {nullable = false, minimum = 0} = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}${nullable ? ' or null' : ''}`);
  return value;
}

function timestamp(value, label) {
  string(value, label);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${label} must be an ISO date-time`);
  return value;
}

function nullableDecimal(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new TypeError(`${label} must be a non-negative decimal string or null`);
  }
  return value;
}

function decimalParts(value) {
  const [whole, fraction = ''] = value.split('.');
  return {units: BigInt(`${whole}${fraction}`), scale: fraction.length};
}

function sameDecimal(leftUnits, leftScale, rightUnits, rightScale) {
  const scale = Math.max(leftScale, rightScale);
  return leftUnits * (10n ** BigInt(scale - leftScale)) === rightUnits * (10n ** BigInt(scale - rightScale));
}

function decimalSumEquals(expected, values) {
  const expectedParts = decimalParts(expected);
  const parsed = values.map(decimalParts);
  const scale = Math.max(expectedParts.scale, ...parsed.map((item) => item.scale), 0);
  const sum = parsed.reduce((total, item) => total + item.units * (10n ** BigInt(scale - item.scale)), 0n);
  return sameDecimal(expectedParts.units, expectedParts.scale, sum, scale);
}

function decimalProductEquals(amount, quantity, unitRate) {
  const amountParts = decimalParts(amount);
  const quantityParts = decimalParts(quantity);
  const rateParts = decimalParts(unitRate);
  return sameDecimal(
    amountParts.units,
    amountParts.scale,
    quantityParts.units * rateParts.units,
    quantityParts.scale + rateParts.scale,
  );
}

function nullableUsage(value, label) {
  return integer(value, label, {nullable: true});
}

function evidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${label} must be a non-empty array`);
  return value.map((entry, index) => {
    const item = object(entry, `${label}[${index}]`);
    exact(item, ['artifact', 'artifact_sha256', 'json_pointer'], `${label}[${index}]`);
    string(item.artifact, `${label}[${index}].artifact`);
    string(item.artifact_sha256, `${label}[${index}].artifact_sha256`, {pattern: DIGEST});
    if (typeof item.json_pointer !== 'string' || !item.json_pointer.startsWith('/')) {
      throw new TypeError(`${label}[${index}].json_pointer must be a JSON pointer`);
    }
    return item;
  });
}

function taskIdForIssueUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('economic.json.task.external_demand.issue_url must be a GitHub issue URL'); }
  const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.port ||
      url.username || url.password || url.search || url.hash || parts.length !== 4 ||
      parts[2] !== 'issues' || !/^[1-9][0-9]*$/.test(parts[3]) || !parts[0] || !parts[1]) {
    throw new TypeError('economic.json.task.external_demand.issue_url must be a clean GitHub issue URL');
  }
  const candidate = `${parts[0]}/${parts[1]}#${parts[3]}`.toLowerCase();
  const suffix = createHash('sha256').update(`northset-oss-task-v1\0${candidate}`).digest('hex').slice(0, 16).toUpperCase();
  return `TASK-OSS-${suffix}`;
}

function validateCostLine(line, index) {
  const label = `economic.json.costs.lines[${index}]`;
  object(line, label);
  exact(line, [
    'component', 'measurement_class', 'quantity', 'unit', 'unit_rate', 'amount',
    'currency', 'source_refs', 'rate_card_digest', 'allocation_method', 'finality', 'visibility',
  ], label);
  string(line.component, `${label}.component`);
  string(line.measurement_class, `${label}.measurement_class`);
  if (line.measurement_class === 'estimated') throw new TypeError(`${label}.measurement_class estimated is forbidden in a factual receipt`);
  if (!COST_CLASSES.has(line.measurement_class)) throw new TypeError(`${label}.measurement_class is unsupported`);
  nullableDecimal(line.quantity, `${label}.quantity`);
  string(line.unit, `${label}.unit`);
  nullableDecimal(line.unit_rate, `${label}.unit_rate`);
  nullableDecimal(line.amount, `${label}.amount`);
  string(line.currency, `${label}.currency`, {nullable: true});
  const refs = evidenceRefs(line.source_refs, `${label}.source_refs`);
  string(line.rate_card_digest, `${label}.rate_card_digest`, {nullable: true, pattern: DIGEST});
  string(line.allocation_method, `${label}.allocation_method`, {nullable: true});
  if (!['provisional', 'final'].includes(line.finality)) throw new TypeError(`${label}.finality is invalid`);
  if (!['public', 'internal', 'confidential_finance'].includes(line.visibility)) throw new TypeError(`${label}.visibility is invalid`);
  if (line.visibility !== 'public') throw new TypeError(`${label}.visibility must be public in a public receipt cost line`);
  if (line.measurement_class === 'provider_billed' && !refs.some((ref) => /(?:provider|billing|invoice)/i.test(ref.artifact))) {
    throw new TypeError(`${label} provider_billed requires provider billing evidence`);
  }
  if (line.measurement_class === 'provider_billed' && (line.amount === null || line.currency === null)) {
    throw new TypeError(`${label} provider_billed requires an amount and currency`);
  }
  if (line.measurement_class === 'calculated_from_usage' && (
    line.quantity === null || line.unit_rate === null || line.amount === null || line.currency === null || line.rate_card_digest === null
  )) throw new TypeError(`${label} calculated_from_usage requires quantity, unit rate, amount, currency, and rate-card digest`);
  if (line.measurement_class === 'calculated_from_usage' &&
      !decimalProductEquals(line.amount, line.quantity, line.unit_rate)) {
    throw new TypeError(`${label} calculated amount must equal quantity multiplied by unit rate`);
  }
  if (line.measurement_class === 'allocated_shared_cost' &&
      (line.allocation_method === null || line.amount === null || line.currency === null)) {
    throw new TypeError(`${label} allocated_shared_cost requires an allocation method, amount, and currency`);
  }
  if (line.measurement_class === 'standard_labor_cost' && (
    line.quantity === null || line.unit_rate === null || line.amount === null || line.currency === null || line.rate_card_digest === null
  )) {
    throw new TypeError(`${label} standard_labor_cost requires quantity, unit rate, amount, currency, and rate-card digest`);
  }
  if (line.measurement_class === 'standard_labor_cost' &&
      !decimalProductEquals(line.amount, line.quantity, line.unit_rate)) {
    throw new TypeError(`${label} standard labor amount must equal quantity multiplied by unit rate`);
  }
  if (['observed_quantity_unpriced', 'unavailable'].includes(line.measurement_class) &&
      (line.unit_rate !== null || line.amount !== null)) {
    throw new TypeError(`${label} unpriced or unavailable evidence cannot report a price or amount`);
  }
  return line;
}

export function validateEconomicIdentity(value, {mission, runRecord} = {}) {
  const record = object(value, 'economic.json');
  exact(record, [
    'schema_version', 'task', 'funding', 'attempt_lineage', 'usage', 'work_scope',
    'costs', 'completeness', 'provenance',
  ], 'economic.json');
  if (record.schema_version !== 1) throw new TypeError('economic.json.schema_version must equal 1');

  const task = object(record.task, 'economic.json.task');
  exact(task, ['task_id', 'attempt_id', 'attempt_sequence', 'work_category', 'external_demand'], 'economic.json.task');
  string(task.task_id, 'economic.json.task.task_id', {pattern: TASK_ID});
  string(task.attempt_id, 'economic.json.task.attempt_id', {pattern: MISSION_ID});
  integer(task.attempt_sequence, 'economic.json.task.attempt_sequence', {minimum: 1});
  if (!WORK_CATEGORIES.has(task.work_category)) throw new TypeError('economic.json.task.work_category is unsupported');
  const demand = object(task.external_demand, 'economic.json.task.external_demand');
  exact(demand, ['source', 'issue_url', 'acceptance_contract_digest', 'invitation_type', 'invitation_url'], 'economic.json.task.external_demand');
  if (demand.source !== 'public_github_issue') throw new TypeError('economic.json.task.external_demand.source must equal public_github_issue');
  string(demand.issue_url, 'economic.json.task.external_demand.issue_url');
  if (task.task_id !== taskIdForIssueUrl(demand.issue_url)) {
    throw new TypeError('economic.json.task.task_id must match the deterministic identity of the GitHub issue');
  }
  string(demand.acceptance_contract_digest, 'economic.json.task.external_demand.acceptance_contract_digest', {pattern: DIGEST});
  if (!['label', 'assignment', 'maintainer_comment', 'repository_policy'].includes(demand.invitation_type)) {
    throw new TypeError('economic.json.task.external_demand.invitation_type is unsupported');
  }
  string(demand.invitation_url, 'economic.json.task.external_demand.invitation_url');

  const funding = object(record.funding, 'economic.json.funding');
  exact(funding, ['program', 'initiative', 'budget_id', 'financial_cap', 'currency'], 'economic.json.funding');
  string(funding.program, 'economic.json.funding.program');
  string(funding.initiative, 'economic.json.funding.initiative');
  string(funding.budget_id, 'economic.json.funding.budget_id', {nullable: true});
  nullableDecimal(funding.financial_cap, 'economic.json.funding.financial_cap');
  string(funding.currency, 'economic.json.funding.currency', {nullable: true});
  if ((funding.financial_cap === null) !== (funding.currency === null)) {
    throw new TypeError('economic.json.funding financial_cap and currency must be present together');
  }

  const lineage = object(record.attempt_lineage, 'economic.json.attempt_lineage');
  exact(lineage, ['attempts_total', 'successful_attempt_id', 'attempts'], 'economic.json.attempt_lineage');
  integer(lineage.attempts_total, 'economic.json.attempt_lineage.attempts_total', {minimum: 1});
  string(lineage.successful_attempt_id, 'economic.json.attempt_lineage.successful_attempt_id', {pattern: MISSION_ID});
  if (!Array.isArray(lineage.attempts) || lineage.attempts.length !== lineage.attempts_total) {
    throw new TypeError('economic.json.attempt_lineage.attempts must match attempts_total');
  }
  const sequences = new Set();
  for (const [index, attempt] of lineage.attempts.entries()) {
    const label = `economic.json.attempt_lineage.attempts[${index}]`;
    object(attempt, label);
    exact(attempt, ['attempt_id', 'attempt_sequence', 'state', 'terminal_reason_class'], label);
    string(attempt.attempt_id, `${label}.attempt_id`, {pattern: MISSION_ID});
    integer(attempt.attempt_sequence, `${label}.attempt_sequence`, {minimum: 1});
    string(attempt.state, `${label}.state`);
    string(attempt.terminal_reason_class, `${label}.terminal_reason_class`, {nullable: true});
    if (sequences.has(attempt.attempt_sequence)) throw new TypeError('economic.json attempt sequences must be unique');
    sequences.add(attempt.attempt_sequence);
  }
  if (!lineage.attempts.some((attempt) => attempt.attempt_id === task.attempt_id && attempt.attempt_sequence === task.attempt_sequence)) {
    throw new TypeError('economic.json current task attempt must be present in attempt_lineage');
  }
  const orderedSequences = [...sequences].sort((left, right) => left - right);
  if (orderedSequences.some((sequence, index) => sequence !== index + 1) ||
      task.attempt_sequence !== lineage.attempts_total) {
    throw new TypeError('economic.json attempt lineage must contain one contiguous attempt sequence through attempts_total');
  }

  const usage = object(record.usage, 'economic.json.usage');
  exact(usage, ['discovery', 'qualification', 'authoring', 'preparation', 'verification', 'resource_envelope'], 'economic.json.usage');
  const discovery = object(usage.discovery, 'economic.json.usage.discovery');
  exact(discovery, ['finder_run_id', 'candidate_rank', 'elapsed_ms'], 'economic.json.usage.discovery');
  string(discovery.finder_run_id, 'economic.json.usage.discovery.finder_run_id', {nullable: true, pattern: UUID});
  integer(discovery.candidate_rank, 'economic.json.usage.discovery.candidate_rank', {nullable: true, minimum: 1});
  nullableUsage(discovery.elapsed_ms, 'economic.json.usage.discovery.elapsed_ms');
  for (const stageName of ['qualification', 'authoring']) {
    const stage = object(usage[stageName], `economic.json.usage.${stageName}`);
    const common = ['requested_model', 'actual_model', 'reasoning_effort', 'service_tier', 'duration_ms', 'model_requests', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens'];
    const fields = stageName === 'authoring' ? [...common, 'bootstrap_duration_ms', 'bootstrap_retry_count'] : ['review_id', ...common];
    exact(stage, fields, `economic.json.usage.${stageName}`);
    if (stageName === 'qualification') string(stage.review_id, 'economic.json.usage.qualification.review_id', {pattern: DIGEST});
    for (const field of ['requested_model', 'reasoning_effort', 'service_tier']) string(stage[field], `economic.json.usage.${stageName}.${field}`);
    string(stage.actual_model, `economic.json.usage.${stageName}.actual_model`, {nullable: true});
    for (const field of ['duration_ms', 'model_requests', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens']) {
      nullableUsage(stage[field], `economic.json.usage.${stageName}.${field}`);
    }
    if (stageName === 'authoring') {
      nullableUsage(stage.bootstrap_duration_ms, 'economic.json.usage.authoring.bootstrap_duration_ms');
      integer(stage.bootstrap_retry_count, 'economic.json.usage.authoring.bootstrap_retry_count');
    }
  }
  const preparation = object(usage.preparation, 'economic.json.usage.preparation');
  exact(preparation, ['total_duration_ms', 'stages'], 'economic.json.usage.preparation');
  integer(preparation.total_duration_ms, 'economic.json.usage.preparation.total_duration_ms');
  if (!Array.isArray(preparation.stages)) throw new TypeError('economic.json.usage.preparation.stages must be an array');
  for (const [index, stage] of preparation.stages.entries()) {
    object(stage, `economic.json.usage.preparation.stages[${index}]`);
    exact(stage, ['stage', 'duration_ms'], `economic.json.usage.preparation.stages[${index}]`);
    string(stage.stage, `economic.json.usage.preparation.stages[${index}].stage`);
    integer(stage.duration_ms, `economic.json.usage.preparation.stages[${index}].duration_ms`);
  }
  if (preparation.stages.reduce((total, stage) => total + stage.duration_ms, 0) !== preparation.total_duration_ms) {
    throw new TypeError('economic.json.usage.preparation.total_duration_ms must equal the recorded stage durations');
  }
  const verification = object(usage.verification, 'economic.json.usage.verification');
  exact(verification, ['executor_elapsed_ms', 'networked_setup_elapsed_ms', 'dependency_install_ms', 'declared_commands_ms', 'unclassified_executor_ms', 'cpu_ms', 'peak_rss_bytes', 'measurement_status'], 'economic.json.usage.verification');
  for (const field of ['executor_elapsed_ms', 'networked_setup_elapsed_ms', 'dependency_install_ms', 'declared_commands_ms', 'unclassified_executor_ms', 'cpu_ms', 'peak_rss_bytes']) {
    nullableUsage(verification[field], `economic.json.usage.verification.${field}`);
  }
  if (!['complete', 'partial'].includes(verification.measurement_status)) throw new TypeError('economic.json.usage.verification.measurement_status is invalid');
  if (verification.measurement_status === 'complete' && [
    verification.executor_elapsed_ms,
    verification.networked_setup_elapsed_ms,
    verification.dependency_install_ms,
    verification.declared_commands_ms,
    verification.unclassified_executor_ms,
    verification.cpu_ms,
    verification.peak_rss_bytes,
  ].some((value) => value === null)) {
    throw new TypeError('economic.json.usage.verification.measurement_status complete requires all verification measurements');
  }
  const envelope = object(usage.resource_envelope, 'economic.json.usage.resource_envelope');
  exact(envelope, ['cpus', 'memory_mb', 'pids', 'wall_clock_seconds_per_command', 'output_bytes_per_stream'], 'economic.json.usage.resource_envelope');
  for (const field of Object.keys(envelope)) integer(envelope[field], `economic.json.usage.resource_envelope.${field}`, {minimum: 1});

  const work = object(record.work_scope, 'economic.json.work_scope');
  exact(work, ['files_changed', 'changed_lines', 'production_files', 'test_files', 'checks_declared', 'checks_not_run'], 'economic.json.work_scope');
  for (const field of ['files_changed', 'changed_lines', 'production_files', 'test_files', 'checks_declared']) integer(work[field], `economic.json.work_scope.${field}`);
  if (!Array.isArray(work.checks_not_run) || work.checks_not_run.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('economic.json.work_scope.checks_not_run must be an array of non-blank strings');
  }

  const costs = object(record.costs, 'economic.json.costs');
  exact(costs, ['status', 'currency', 'lines', 'known_direct_cost', 'allocated_shared_cost', 'human_standard_cost', 'total_economic_cost', 'missing_components'], 'economic.json.costs');
  if (!['partial', 'complete'].includes(costs.status)) throw new TypeError('economic.json.costs.status is invalid');
  string(costs.currency, 'economic.json.costs.currency', {nullable: true});
  if (!Array.isArray(costs.lines)) throw new TypeError('economic.json.costs.lines must be an array');
  const costLines = costs.lines.map(validateCostLine);
  for (const field of ['known_direct_cost', 'allocated_shared_cost', 'human_standard_cost', 'total_economic_cost']) nullableDecimal(costs[field], `economic.json.costs.${field}`);
  if (!Array.isArray(costs.missing_components) || costs.missing_components.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('economic.json.costs.missing_components must be an array of non-blank strings');
  }
  if (costs.missing_components.length > 0 && costs.total_economic_cost !== null) {
    throw new TypeError('economic.json.costs.total_economic_cost must be null while components are missing');
  }
  if (costs.status === 'complete' && costs.missing_components.length > 0) {
    throw new TypeError('economic.json.costs.status cannot be complete while components are missing');
  }
  if ([costs.known_direct_cost, costs.allocated_shared_cost, costs.human_standard_cost, costs.total_economic_cost]
    .some((value) => value !== null) && costs.currency === null) {
    throw new TypeError('economic.json.costs.currency is required when a cost amount is reported');
  }
  for (const line of costLines) {
    if (line.amount !== null && line.currency !== costs.currency) {
      throw new TypeError(`economic.json cost line currency for ${line.component} must match costs.currency`);
    }
  }
  const priced = {
    known_direct_cost: costLines.filter((line) => line.amount !== null && !['allocated_shared_cost', 'standard_labor_cost'].includes(line.measurement_class)),
    allocated_shared_cost: costLines.filter((line) => line.amount !== null && line.measurement_class === 'allocated_shared_cost'),
    human_standard_cost: costLines.filter((line) => line.amount !== null && line.measurement_class === 'standard_labor_cost'),
  };
  for (const [field, lines] of Object.entries(priced)) {
    if (lines.length > 0 && costs[field] === null) {
      throw new TypeError(`economic.json.costs.${field} is required when its priced cost lines are present`);
    }
    if (costs[field] !== null && !decimalSumEquals(costs[field], lines.map((line) => line.amount))) {
      throw new TypeError(`economic.json.costs.${field} must equal the sum of its priced cost lines`);
    }
  }
  if (costs.total_economic_cost !== null) {
    const subtotals = [costs.known_direct_cost, costs.allocated_shared_cost, costs.human_standard_cost];
    if (subtotals.some((value) => value === null)) {
      throw new TypeError('economic.json.costs.total_economic_cost requires every cost subtotal');
    }
    if (!decimalSumEquals(costs.total_economic_cost, subtotals)) {
      throw new TypeError('economic.json.costs.total_economic_cost must equal the sum of its cost subtotals');
    }
  }
  if (costs.status === 'complete' && [
    costs.known_direct_cost, costs.allocated_shared_cost, costs.human_standard_cost, costs.total_economic_cost,
  ].some((value) => value === null)) {
    throw new TypeError('economic.json.costs.status complete requires every subtotal and total_economic_cost');
  }

  const completeness = object(record.completeness, 'economic.json.completeness');
  exact(completeness, ['task_identity', 'technical_execution', 'attempt_lineage', 'usage', 'cost', 'external_outcome', 'business_value'], 'economic.json.completeness');
  for (const [field, entry] of Object.entries(completeness)) string(entry, `economic.json.completeness.${field}`);
  const provenance = object(record.provenance, 'economic.json.provenance');
  exact(provenance, ['spec_sha256', 'qualification_evidence_sha256', 'issue_snapshot_sha256'], 'economic.json.provenance');
  for (const [field, digest] of Object.entries(provenance)) string(digest, `economic.json.provenance.${field}`, {pattern: DIGEST});

  if (mission) {
    if (task.attempt_id !== mission.mission_id || lineage.successful_attempt_id !== mission.mission_id) {
      throw new TypeError('economic.json attempt identity must match mission.json');
    }
    if (demand.issue_url !== mission.issue_or_task) throw new TypeError('economic.json issue URL must match mission.json');
    if (funding.program !== mission.funding_source) throw new TypeError('economic.json funding program must match mission.json');
    if (work.checks_declared !== mission.commands_declared.length) throw new TypeError('economic.json checks_declared must match mission.json');
    const maintainerLine = costs.lines.find((line) => line.component === 'maintainer_payment');
    if (mission.payment?.maintainer_payment !== 'none' || mission.payment?.merge_contingent !== false ||
        maintainerLine?.measurement_class !== 'observed_quantity_unpriced' || maintainerLine.quantity !== '0' ||
        maintainerLine.amount !== null) {
      throw new TypeError('economic.json maintainer payment evidence must match mission.json external transfer facts');
    }
  }
  if (runRecord) {
    const elapsed = Date.parse(runRecord.finished_at) - Date.parse(runRecord.started_at);
    const declaredMs = runRecord.commands.reduce((sum, command) => sum + command.duration_ms, 0);
    if (verification.executor_elapsed_ms !== elapsed || verification.declared_commands_ms !== declaredMs ||
        verification.networked_setup_elapsed_ms !== (runRecord.usage?.networked_setup_elapsed_ms ?? null) ||
        verification.dependency_install_ms !== (runRecord.usage?.dependency_install_ms ?? null) ||
        verification.cpu_ms !== (runRecord.usage?.cpu_ms ?? null) ||
        verification.peak_rss_bytes !== (runRecord.usage?.peak_rss_bytes ?? null)) {
      throw new TypeError('economic.json verification usage must match bundle/run_record.json');
    }
    const expectedUnclassified = Math.max(0, elapsed - declaredMs - (verification.networked_setup_elapsed_ms ?? 0));
    if (verification.unclassified_executor_ms !== expectedUnclassified) {
      throw new TypeError('economic.json unclassified executor time must reconcile with observed durations');
    }
  }
  return record;
}

export function validateApprovalRecord(value, {mission, economic} = {}) {
  const record = object(value, 'approval.json');
  exact(record, [
    'schema_version', 'mission_id', 'task_id', 'attempt_id', 'approved_manifest_digest',
    'approved_by', 'approved_at', 'funding_program', 'initiative', 'budget_id',
    'financial_cap', 'operational_caps',
  ], 'approval.json');
  if (record.schema_version !== 1) throw new TypeError('approval.json.schema_version must equal 1');
  string(record.mission_id, 'approval.json.mission_id', {pattern: MISSION_ID});
  string(record.task_id, 'approval.json.task_id', {pattern: TASK_ID});
  string(record.attempt_id, 'approval.json.attempt_id', {pattern: MISSION_ID});
  string(record.approved_manifest_digest, 'approval.json.approved_manifest_digest', {pattern: DIGEST});
  string(record.approved_by, 'approval.json.approved_by');
  timestamp(record.approved_at, 'approval.json.approved_at');
  string(record.funding_program, 'approval.json.funding_program');
  string(record.initiative, 'approval.json.initiative');
  string(record.budget_id, 'approval.json.budget_id', {nullable: true});
  nullableDecimal(record.financial_cap, 'approval.json.financial_cap');
  const caps = object(record.operational_caps, 'approval.json.operational_caps');
  exact(caps, ['finder_wall_seconds', 'qualification_wall_seconds', 'prepare_wall_seconds', 'ship_wall_seconds', 'maximum_attempts'], 'approval.json.operational_caps');
  for (const field of ['finder_wall_seconds', 'qualification_wall_seconds', 'prepare_wall_seconds', 'ship_wall_seconds']) integer(caps[field], `approval.json.operational_caps.${field}`, {minimum: 1});
  integer(caps.maximum_attempts, 'approval.json.operational_caps.maximum_attempts', {nullable: true, minimum: 1});
  if (mission && (record.mission_id !== mission.mission_id || record.attempt_id !== mission.mission_id)) {
    throw new TypeError('approval.json attempt identity must match mission.json');
  }
  if (economic && (
    record.task_id !== economic.task.task_id || record.funding_program !== economic.funding.program
    || record.initiative !== economic.funding.initiative || record.budget_id !== economic.funding.budget_id
    || record.financial_cap !== economic.funding.financial_cap
  )) throw new TypeError('approval.json must match economic.json task and funding identity');
  return record;
}

export function finalizeEconomicIdentity(input, runRecord) {
  const elapsed = Math.max(0, Date.parse(runRecord.finished_at) - Date.parse(runRecord.started_at));
  const declaredMs = runRecord.commands.reduce((sum, command) => sum + command.duration_ms, 0);
  const networkedSetupMs = runRecord.usage?.networked_setup_elapsed_ms ?? null;
  const installMs = runRecord.usage?.dependency_install_ms ?? null;
  const verification = {
    executor_elapsed_ms: elapsed,
    networked_setup_elapsed_ms: networkedSetupMs,
    dependency_install_ms: installMs,
    declared_commands_ms: declaredMs,
    unclassified_executor_ms: Math.max(0, elapsed - declaredMs - (networkedSetupMs ?? 0)),
    cpu_ms: runRecord.usage?.cpu_ms ?? null,
    peak_rss_bytes: runRecord.usage?.peak_rss_bytes ?? null,
    measurement_status: [networkedSetupMs, installMs, runRecord.usage?.cpu_ms, runRecord.usage?.peak_rss_bytes]
      .every((value) => value != null) ? 'complete' : 'partial',
  };
  return {
    ...input,
    usage: {...input.usage, verification},
  };
}

export function projectEconomicIdentity(economic, approval, publication, mission) {
  const opened = publication?.opened_at ? Date.parse(publication.opened_at) : null;
  const closed = publication?.closed_at ? Date.parse(publication.closed_at) : null;
  return {
    scope: 'end_to_end_task',
    task: economic.task,
    funding: economic.funding,
    external_transfers: {...mission.payment},
    authorization: {
      approved_manifest_digest: approval.approved_manifest_digest,
      approved_by: approval.approved_by,
      approved_at: approval.approved_at,
      operational_caps: approval.operational_caps,
    },
    attempt_lineage: economic.attempt_lineage,
    usage: economic.usage,
    work_scope: economic.work_scope,
    costs: economic.costs,
    outcome: {
      technical_checks_passed: true,
      pr_opened: publication?.pr_url != null,
      ci_state: publication?.ci_state ?? null,
      merged: publication?.state === 'merged',
      accepted_as_submitted: publication?.state === 'merged' ? publication.head_drift === false : null,
      time_to_close_ms: opened !== null && closed !== null ? Math.max(0, closed - opened) : null,
      released: null,
      deployed: null,
      business_result_observed: null,
    },
    completeness: {
      ...economic.completeness,
      external_outcome: ['merged', 'closed_unmerged'].includes(publication?.state) ? 'complete' : 'partial',
    },
    provenance: economic.provenance,
  };
}
