import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MISSION_ID_PATTERN = /^M-(?:\d{3,}|E2[a-c])$/;
const OID_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const POLICY_FIELDS = new Set([
  'schema_version',
  'canonical_receipt_base_url',
  'legacy_ledger_base_url',
  'current_block_schema_version',
  'historical_exempt_mission_ids',
  'factory_block_schema_versions',
  'northset_actor_logins',
]);
const DISCLOSURE_FIELDS = new Set([
  'schema_version',
  'required',
  'mode',
  'canonical_url',
  'verified_at',
]);
const DISCLOSURE_PUBLICATION_STATES = new Set(['open', 'closed_unmerged', 'merged']);
const RUN_REQUEST_URL = 'https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml';
const V1_MERGED_INVITATION = 'Maintainers can request a separate, private run for a PR already in their queue at oss@northset.ai.';
const V2_MERGED_INVITATION = `Maintainers: request a separate private run for any PR in your queue — open a run request: ${RUN_REQUEST_URL} or email oss@northset.ai.`;
const NO_CI_CHANGE = 'No workflow or CI files are modified in this change.';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countOccurrences(source, needle) {
  if (typeof source !== 'string' || needle.length === 0) return 0;
  return source.split(needle).length - 1;
}

function exactHttpsBaseUrl(value, label, requiredPathSuffix = '/') {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || !parsed.pathname.endsWith(requiredPathSuffix)
    || parsed.href !== value
  ) {
    throw new TypeError(`${label} must be an exact HTTPS URL ending in ${requiredPathSuffix}`);
  }
  return parsed;
}

function isoTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    throw new TypeError(`${label} must be an ISO-8601 UTC date-time`);
  }
  if (Number.isNaN(Date.parse(value))) throw new TypeError(`${label} must be a valid date-time`);
  return value;
}

function validateMissionId(missionId) {
  if (typeof missionId !== 'string' || !MISSION_ID_PATTERN.test(missionId)) {
    throw new TypeError('mission id must use the M-000, M-1000, or M-E2a form');
  }
  return missionId;
}

function validateFactoryBlockSchemaVersions(value) {
  if (!isObject(value)) throw new TypeError('factory_block_schema_versions must be an object');
  for (const [missionId, blockVersion] of Object.entries(value)) {
    validateMissionId(missionId);
    if (![1, 2].includes(blockVersion)) {
      throw new TypeError(`factory_block_schema_versions.${missionId} must equal 1 or 2`);
    }
  }
  return value;
}

function validateUniqueStringArray(value, label, pattern = null) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  if (value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new TypeError(`${label} must contain non-blank strings`);
  }
  if (new Set(value).size !== value.length) throw new TypeError(`${label} must contain unique values`);
  if (pattern !== null && value.some((item) => !pattern.test(item))) {
    throw new TypeError(`${label} contains an invalid value`);
  }
}

export function validateDisclosurePolicy(value) {
  if (!isObject(value)) throw new TypeError('PR disclosure policy must be an object');
  for (const field of POLICY_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`PR disclosure policy ${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!POLICY_FIELDS.has(field)) throw new TypeError(`PR disclosure policy ${field} is not allowed`);
  }
  if (value.schema_version !== 2) throw new TypeError('PR disclosure policy schema_version must equal 2');
  if (value.current_block_schema_version !== 2) {
    throw new TypeError('PR disclosure policy current_block_schema_version must equal 2');
  }
  const canonical = exactHttpsBaseUrl(
    value.canonical_receipt_base_url,
    'canonical_receipt_base_url',
    '/receipts/',
  );
  const legacy = exactHttpsBaseUrl(value.legacy_ledger_base_url, 'legacy_ledger_base_url');
  if (canonical.origin !== legacy.origin || !canonical.pathname.startsWith(legacy.pathname)) {
    throw new TypeError('canonical and legacy receipt URLs must share the configured ledger origin');
  }
  validateUniqueStringArray(
    value.historical_exempt_mission_ids,
    'historical_exempt_mission_ids',
    MISSION_ID_PATTERN,
  );
  validateFactoryBlockSchemaVersions(value.factory_block_schema_versions);
  validateUniqueStringArray(value.northset_actor_logins, 'northset_actor_logins');
  return value;
}

export function canonicalReceiptUrl(policy, missionId) {
  validateDisclosurePolicy(policy);
  validateMissionId(missionId);
  return `${policy.canonical_receipt_base_url}${missionId}/`;
}

function validateStoredDisclosure(value, { missionId, policy }) {
  if (!isObject(value)) throw new TypeError(`${missionId} publication pr_disclosure is required`);
  for (const field of DISCLOSURE_FIELDS) {
    if (!Object.hasOwn(value, field)) throw new TypeError(`${missionId} pr_disclosure.${field} is required`);
  }
  for (const field of Object.keys(value)) {
    if (!DISCLOSURE_FIELDS.has(field)) throw new TypeError(`${missionId} pr_disclosure.${field} is not allowed`);
  }
  if (![1, 2].includes(value.schema_version)) {
    throw new TypeError(`${missionId} pr_disclosure.schema_version must equal 1 or 2`);
  }
  if (value.required !== true) throw new TypeError(`${missionId} pr_disclosure.required must be true`);
  if (value.mode !== 'pr_body') throw new TypeError(`${missionId} pr_disclosure.mode must be pr_body`);
  const expected = canonicalReceiptUrl(policy, missionId);
  if (value.canonical_url !== expected) {
    throw new TypeError(`${missionId} pr_disclosure.canonical_url must equal ${expected}`);
  }
  isoTime(value.verified_at, `${missionId} pr_disclosure.verified_at`);
  return value;
}

function validateDisclosurePublicationState(publicationState) {
  if (!DISCLOSURE_PUBLICATION_STATES.has(publicationState)) {
    throw new TypeError('publicationState must be open, closed_unmerged, or merged');
  }
  return publicationState;
}

function renderCommand(command) {
  const rendered = Array.isArray(command)
    ? command.map((part) => String(part)).join(' ')
    : typeof command === 'string' ? command : '';
  const normalized = rendered.trim();
  if (normalized.length === 0) throw new TypeError('recorded verification command is required');
  return normalized.length > 80 ? "the repository's declared test command" : `\`${normalized}\``;
}

function recordedDisclosureFacts(mission, publication) {
  const command = Array.isArray(mission?.commands_declared) ? mission.commands_declared[0] : null;
  const headOid = mission?.patch_commit ?? publication?.pr_head_oid;
  return { command, headOid };
}

export function renderDisclosureBlock({
  missionId,
  receiptUrl,
  publicationState,
  blockVersion = 2,
  command = null,
  headOid = null,
  includeNoCiChange = false,
}) {
  validateMissionId(missionId);
  validateDisclosurePublicationState(publicationState);
  if (typeof receiptUrl !== 'string' || receiptUrl.length === 0) {
    throw new TypeError('receiptUrl is required');
  }
  if (![1, 2].includes(blockVersion)) throw new TypeError('blockVersion must equal 1 or 2');
  if (blockVersion === 1) {
    const disclosure = publicationState === 'merged'
      ? [
        'This record covers Northset’s own contribution; it is not maintainer verification.',
        V1_MERGED_INVITATION,
        'For repositories already onboarded with Northset, adding `northset-verify` to a PR requests a run on that PR.',
      ]
      : ['Contributor self-run; not maintainer verification.'];
    return [
      `<!-- northset-receipt:${missionId}:start -->`,
      '### Verification',
      '',
      `[Northset proof-of-pass receipt ${missionId}](${receiptUrl})  `,
      ...disclosure,
      `<!-- northset-receipt:${missionId}:end -->`,
    ].join('\n');
  }
  if (typeof headOid !== 'string' || !/^[0-9a-f]{40}$/i.test(headOid)) {
    throw new TypeError('recorded verification head OID must be a full commit OID');
  }
  const disclosure = publicationState === 'merged'
    ? [
      "This record covers Northset's own contribution; it is not maintainer verification.",
      V2_MERGED_INVITATION,
      'For repositories already onboarded with Northset, adding `northset-verify` to a PR requests a run on that PR.',
    ]
    : ['Self-run by the contributor, not maintainer verification.'];
  return [
    `<!-- northset-receipt:${missionId}:start -->`,
    '### Verification',
    '',
    `${renderCommand(command)} exited 0 on this exact head (\`${headOid.slice(0, 7)}\`) in a network-off container, before this PR was opened.`,
    ...(includeNoCiChange ? [NO_CI_CHANGE] : []),
    `Commands, environment, and hashes: [receipt ${missionId}](${receiptUrl}) — checkable in ~30 seconds without trusting us.`,
    ...disclosure,
    `<!-- northset-receipt:${missionId}:end -->`,
  ].join('\n');
}

export function upsertDisclosureBlock(body, options) {
  if (typeof body !== 'string') throw new TypeError('pull request body must be a string');
  const { missionId, receiptUrl, publicationState } = options;
  const block = renderDisclosureBlock({
    ...options,
    includeNoCiChange: options.includeNoCiChange ?? body.includes(NO_CI_CHANGE),
  });
  const markerPattern = /<!-- northset-receipt:(M-(?:\d{3,}|E2[a-c])):(start|end) -->/g;
  const markers = [...body.matchAll(markerPattern)];
  if (markers.some((match) => match[1] !== missionId)) {
    throw new Error('pull request body contains a Northset receipt marker for a different mission');
  }

  const start = `<!-- northset-receipt:${missionId}:start -->`;
  const end = `<!-- northset-receipt:${missionId}:end -->`;
  const startCount = countOccurrences(body, start);
  const endCount = countOccurrences(body, end);
  if (startCount > 1 || endCount > 1 || startCount !== endCount) {
    throw new Error('pull request body contains malformed or duplicate Northset receipt markers');
  }

  if (startCount === 1) {
    const startIndex = body.indexOf(start);
    const endIndex = body.indexOf(end, startIndex + start.length);
    if (endIndex < startIndex) throw new Error('pull request body receipt markers are out of order');
    const nextBody = `${body.slice(0, startIndex)}${block}${body.slice(endIndex + end.length)}`;
    return { body: nextBody, changed: nextBody !== body };
  }

  if (body.includes(receiptUrl)) {
    throw new Error('pull request body already contains the canonical receipt URL in an unmarked block');
  }
  const receipt = new URL(receiptUrl);
  const legacyUrl = `${receipt.origin}${receipt.pathname.replace(/receipts\/M-(?:\d{3,}|E2[a-c])\/$/, '')}#${missionId}`;
  if (body.includes(legacyUrl)) {
    throw new Error('pull request body contains a legacy receipt URL; migrate it manually before syncing');
  }

  const prefix = body.trimEnd();
  return {
    body: `${prefix}${prefix === '' ? '' : '\n\n---\n\n'}${block}\n`,
    changed: true,
  };
}

function exactPullRequest(publication) {
  if (!isObject(publication)) throw new TypeError('publication must be an object');
  if (!Number.isInteger(publication.pr_number) || publication.pr_number < 1) {
    throw new TypeError(`${publication.mission_id ?? 'publication'} pr_number is required`);
  }
  if (typeof publication.pr_url !== 'string') {
    throw new TypeError(`${publication.mission_id ?? 'publication'} pr_url is required`);
  }
  const parsed = new URL(publication.pr_url);
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/);
  if (
    parsed.origin !== 'https://github.com'
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.port !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
    || match === null
    || Number(match[3]) !== publication.pr_number
  ) {
    throw new TypeError(`${publication.mission_id ?? 'publication'} pr_url must be the exact GitHub PR URL`);
  }
  return {
    apiUrl: `https://api.github.com/repos/${match[1]}/${match[2]}/pulls/${match[3]}`,
    commentsUrl: `https://api.github.com/repos/${match[1]}/${match[2]}/issues/${match[3]}/comments?per_page=100`,
  };
}

function nextPage(headers) {
  const value = typeof headers?.get === 'function'
    ? headers.get('link')
    : headers?.link ?? headers?.Link ?? null;
  if (typeof value !== 'string') return null;
  const match = value.split(',').map((item) => item.trim()).find((item) => /rel="next"/.test(item));
  return match?.match(/^<([^>]+)>/)?.[1] ?? null;
}

async function requireResponse(request, url, options, label) {
  const response = await request(url, options);
  if (!isObject(response) || !Number.isInteger(response.status)) {
    throw new Error(`${label} returned an invalid response`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label} must return 200-class status; received ${response.status}`);
  }
  return response;
}

async function fetchComments({ request, url }) {
  const comments = [];
  const visited = new Set();
  const endpoint = new URL(url);
  let next = url;
  while (next !== null) {
    if (visited.has(next) || visited.size >= 20) throw new Error('GitHub comment pagination is invalid or excessive');
    const page = new URL(next);
    const allowedQuery = [...page.searchParams.keys()].every((key) => ['page', 'per_page'].includes(key));
    if (
      page.origin !== 'https://api.github.com'
      || page.pathname !== endpoint.pathname
      || !allowedQuery
    ) {
      throw new Error('comment pagination must stay on the original GitHub API endpoint');
    }
    visited.add(next);
    const response = await requireResponse(request, next, {}, 'GitHub PR comments API');
    if (!Array.isArray(response.json)) throw new Error('GitHub PR comments API must return an array');
    comments.push(...response.json);
    next = nextPage(response.headers);
  }
  return comments;
}

function actorReceiptCommentCount(comments, { policy, missionId, canonicalUrl }) {
  const actors = new Set(policy.northset_actor_logins.map((login) => login.toLowerCase()));
  const legacyUrl = `${policy.legacy_ledger_base_url}#${missionId}`;
  return comments.filter((comment) => {
    const login = comment?.user?.login;
    const body = comment?.body;
    return (
      typeof login === 'string'
      && actors.has(login.toLowerCase())
      && typeof body === 'string'
      && (body.includes(canonicalUrl) || body.includes(legacyUrl))
    );
  }).length;
}

async function auditRemote({
  mission,
  missionId,
  publication,
  policy,
  request,
  requireBodyLink = true,
  blockVersion,
  allowMergedOpenBlock = false,
}) {
  validateDisclosurePublicationState(publication.state);
  const canonicalUrl = canonicalReceiptUrl(policy, missionId);
  const receiptResponse = await requireResponse(request, canonicalUrl, {}, `${missionId} receipt endpoint`);
  if (receiptResponse.status !== 200) {
    throw new Error(`${missionId} receipt endpoint must return 200; received ${receiptResponse.status}`);
  }

  const { apiUrl, commentsUrl } = exactPullRequest(publication);
  const prResponse = await requireResponse(request, apiUrl, {}, `${missionId} GitHub PR API`);
  const pr = prResponse.json;
  if (
    !isObject(pr)
    || pr.number !== publication.pr_number
    || pr.html_url !== publication.pr_url
    || typeof pr.body !== 'string'
  ) {
    throw new Error(`${missionId} GitHub PR API response does not match publication.json`);
  }

  const bodyOccurrences = countOccurrences(pr.body, canonicalUrl);
  const legacyUrl = `${policy.legacy_ledger_base_url}#${missionId}`;
  const legacyOccurrences = countOccurrences(pr.body, legacyUrl);
  const ledgerLinkOccurrences = countOccurrences(pr.body, policy.legacy_ledger_base_url);
  const runRequestOccurrences = countOccurrences(pr.body, RUN_REQUEST_URL);
  const startMarker = `<!-- northset-receipt:${missionId}:start -->`;
  const endMarker = `<!-- northset-receipt:${missionId}:end -->`;
  if (requireBodyLink && bodyOccurrences !== 1) {
    throw new Error(`${missionId} canonical receipt URL must appear exactly once in the PR body; found ${bodyOccurrences}`);
  }
  if (bodyOccurrences > 1) {
    throw new Error(`${missionId} canonical receipt URL must appear at most once in the PR body; found ${bodyOccurrences}`);
  }
  if (legacyOccurrences !== 0) {
    throw new Error(`${missionId} PR body contains ${legacyOccurrences} legacy ledger receipt URL(s)`);
  }
  if (
    requireBodyLink
    && (countOccurrences(pr.body, startMarker) !== 1 || countOccurrences(pr.body, endMarker) !== 1)
  ) {
    throw new Error(`${missionId} PR body must contain exactly one marked receipt block`);
  }
  if (!requireBodyLink && ledgerLinkOccurrences > bodyOccurrences) {
    throw new Error(`${missionId} PR body contains an unexpected Northset ledger link`);
  }
  let disclosureStatus = 'verified';
  let matchedPublicationState = null;
  let includeNoCiChange = false;
  if (requireBodyLink) {
    const facts = recordedDisclosureFacts(mission, publication);
    const normalizedBody = pr.body.replace(/\r\n?/g, '\n');
    const variants = blockVersion === 2 ? [false, true] : [false];
    const acceptedStates = allowMergedOpenBlock && blockVersion === 2 && publication.state === 'merged'
      ? ['open', 'merged']
      : [publication.state];
    const matchingBlocks = acceptedStates.flatMap((publicationState) => variants.map((withNoCiChange) => ({
      publicationState,
      includeNoCiChange: withNoCiChange,
      block: renderDisclosureBlock({
        missionId,
        receiptUrl: canonicalUrl,
        publicationState,
        blockVersion,
        ...facts,
        includeNoCiChange: withNoCiChange,
      }),
    }))).filter(({ block }) => normalizedBody.includes(block));
    if (matchingBlocks.length !== 1) {
      throw new Error(`${missionId} ${publication.state} PR body must contain the expected state-specific marked block`);
    }
    [{ publicationState: matchedPublicationState, includeNoCiChange }] = matchingBlocks;
    disclosureStatus = publication.state === 'merged' && matchedPublicationState === 'open'
      ? 'merged_sync_pending'
      : 'verified';
    const expectedNorthsetUrls = blockVersion === 2 && matchedPublicationState === 'merged' ? 2 : 1;
    if (ledgerLinkOccurrences + runRequestOccurrences !== expectedNorthsetUrls) {
      throw new Error(`${missionId} PR body must contain exactly ${expectedNorthsetUrls} Northset URL(s); found ${ledgerLinkOccurrences + runRequestOccurrences}`);
    }
    const invitation = blockVersion === 2 ? V2_MERGED_INVITATION : V1_MERGED_INVITATION;
    const invitationOccurrences = countOccurrences(pr.body, invitation);
    const expectedInvitations = matchedPublicationState === 'merged' ? 1 : 0;
    if (invitationOccurrences !== expectedInvitations) {
      throw new Error(`${missionId} ${matchedPublicationState} PR body must contain ${expectedInvitations} merged-only invitation(s); found ${invitationOccurrences}`);
    }
  }

  const comments = await fetchComments({ request, url: commentsUrl });
  const actorCommentOccurrences = actorReceiptCommentCount(comments, {
    policy,
    missionId,
    canonicalUrl,
  });
  if (actorCommentOccurrences !== 0) {
    throw new Error(`${missionId} has ${actorCommentOccurrences} Northset-authored receipt link comment(s)`);
  }

  return {
    canonicalUrl,
    body: pr.body,
    bodyOccurrences,
    legacyOccurrences,
    actorCommentOccurrences,
    apiUrl,
    disclosureStatus,
    matchedPublicationState,
    includeNoCiChange,
  };
}

export async function auditMissionDisclosure({ mission, publication, policy, request }) {
  validateDisclosurePolicy(policy);
  if (!isObject(mission) || mission.variant !== 'author_contribution') {
    throw new TypeError('mission must be an author_contribution');
  }
  const missionId = validateMissionId(mission.mission_id);
  if (publication?.mission_id !== missionId) throw new TypeError(`${missionId} publication mission_id mismatch`);
  if (publication.state === 'prepared') {
    return { mission_id: missionId, status: 'prepared', canonical_url: canonicalReceiptUrl(policy, missionId) };
  }
  if (policy.historical_exempt_mission_ids.includes(missionId)) {
    return { mission_id: missionId, status: 'historical_exempt', canonical_url: canonicalReceiptUrl(policy, missionId) };
  }
  const storedDisclosure = validateStoredDisclosure(publication.pr_disclosure, { missionId, policy });
  const remote = await auditRemote({
    mission, missionId, publication, policy, request, blockVersion: storedDisclosure.schema_version,
  });
  return {
    mission_id: missionId,
    status: 'verified',
    canonical_url: remote.canonicalUrl,
    body_occurrences: remote.bodyOccurrences,
    legacy_occurrences: remote.legacyOccurrences,
    actor_comment_occurrences: remote.actorCommentOccurrences,
  };
}

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function factoryBlockVersion(policy, missionId) {
  return policy.factory_block_schema_versions[missionId] ?? policy.current_block_schema_version;
}

function factoryPublicationState(publication, missionId) {
  if (!isObject(publication) || ![1, 2].includes(publication.schema_version)) {
    throw new TypeError(`${missionId} factory publication schema_version must equal 1 or 2`);
  }
  if (publication.mission_id !== missionId) {
    throw new TypeError(`${missionId} factory publication mission_id mismatch`);
  }
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(publication.pr_state)) {
    throw new TypeError(`${missionId} factory publication pr_state is invalid`);
  }
  if (typeof publication.merged !== 'boolean' || publication.merged !== (publication.pr_state === 'MERGED')) {
    throw new TypeError(`${missionId} factory publication merged flag contradicts pr_state`);
  }
  if (publication.pr_state === 'MERGED') return 'merged';
  if (publication.pr_state === 'CLOSED') return 'closed_unmerged';
  return 'open';
}

async function factoryDisclosureRecord({ factoryReceiptsDir, entryName, policy }) {
  const missionId = validateMissionId(entryName);
  const missionDir = path.join(factoryReceiptsDir, missionId);
  const current = await readJson(path.join(missionDir, 'current.json'), `${missionId}/current.json`);
  if (
    !isObject(current)
    || current.schema_version !== 1
    || current.mission_id !== missionId
    || typeof current.contribution_commit_oid !== 'string'
    || !OID_PATTERN.test(current.contribution_commit_oid)
    || typeof current.proof_sha256 !== 'string'
    || !SHA256_PATTERN.test(current.proof_sha256)
  ) {
    throw new TypeError(`${missionId} current.json is invalid`);
  }

  const selectedDir = path.join(missionDir, current.contribution_commit_oid);
  const proofFile = path.join(selectedDir, 'proof.json');
  let proofBytes;
  try {
    proofBytes = await readFile(proofFile);
  } catch (error) {
    throw new Error(`${missionId}/proof.json: ${error.message}`);
  }
  const actualProofSha256 = sha256(proofBytes);
  if (actualProofSha256 !== current.proof_sha256) {
    throw new Error(
      `${missionId} current.json proof_sha256 mismatch: expected ${current.proof_sha256}, received ${actualProofSha256}`,
    );
  }

  const proof = parseJsonBytes(proofBytes, `${missionId}/proof.json`);
  if (
    !isObject(proof)
    || ![1, 2].includes(proof.schema_version)
    || proof.mission_id !== missionId
    || proof.commit_oid !== current.contribution_commit_oid
  ) {
    throw new TypeError(`${missionId} selected factory proof identity is invalid`);
  }
  const publication = await readJson(
    path.join(selectedDir, 'publication.json'),
    `${missionId}/publication.json`,
  );
  const publicationState = factoryPublicationState(publication, missionId);
  if (publication.contribution_commit_oid !== current.contribution_commit_oid) {
    throw new TypeError(`${missionId} factory publication contribution_commit_oid mismatch`);
  }
  const canonicalUrl = canonicalReceiptUrl(policy, missionId);
  if (publication.receipt_url !== canonicalUrl) {
    throw new TypeError(`${missionId} factory publication receipt_url must equal ${canonicalUrl}`);
  }

  const blockVersion = factoryBlockVersion(policy, missionId);
  if (blockVersion === 2 && proof.schema_version !== 2) {
    throw new TypeError(`${missionId} block v2 requires a factory proof with schema_version 2`);
  }
  return {
    missionId,
    current,
    proof,
    publication,
    publicationState,
    blockVersion,
  };
}

export async function auditAllDisclosures({ missionsDir, policy, request }) {
  validateDisclosurePolicy(policy);
  const entries = await readdir(missionsDir, { withFileTypes: true });
  const reports = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const missionFile = path.join(missionsDir, entry.name, 'mission.json');
    const publicationFile = path.join(missionsDir, entry.name, 'publication.json');
    const mission = await readJson(missionFile, `${entry.name}/mission.json`);
    if (mission.variant !== 'author_contribution') continue;
    const publication = await readJson(publicationFile, `${entry.name}/publication.json`);
    reports.push(await auditMissionDisclosure({ mission, publication, policy, request }));
  }
  return {
    checked: reports.filter(({ status }) => status === 'verified').length,
    historical_exempt: reports.filter(({ status }) => status === 'historical_exempt').length,
    prepared: reports.filter(({ status }) => status === 'prepared').length,
    reports,
  };
}

export async function auditAllFactoryDisclosures({ factoryReceiptsDir, policy, request }) {
  validateDisclosurePolicy(policy);
  const entries = await readdir(factoryReceiptsDir, { withFileTypes: true });
  const reports = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!entry.name.startsWith('M-')) continue;
    const record = await factoryDisclosureRecord({
      factoryReceiptsDir,
      entryName: entry.name,
      policy,
    });
    const { report } = await auditFactoryDisclosureRecord({ record, policy, request });
    reports.push(report);
  }
  return {
    lane: 'factory_receipts',
    checked: reports.filter(({ status }) => status === 'verified').length,
    merged_sync_pending: reports.filter(({ status }) => status === 'merged_sync_pending').length,
    block_v1: reports.filter(({ block_schema_version: version }) => version === 1).length,
    block_v2: reports.filter(({ block_schema_version: version }) => version === 2).length,
    reports,
  };
}

async function auditFactoryDisclosureRecord({ record, policy, request }) {
  const command = record.proof?.patched_observation?.command;
  const remote = await auditRemote({
    mission: {
      commands_declared: [command],
      patch_commit: record.proof.commit_oid,
    },
    missionId: record.missionId,
    publication: {
      mission_id: record.missionId,
      state: record.publicationState,
      pr_number: record.publication.pr_number,
      pr_url: record.publication.pr_url,
    },
    policy,
    request,
    blockVersion: record.blockVersion,
    allowMergedOpenBlock: true,
  });
  return {
    remote,
    report: {
      mission_id: record.missionId,
      status: remote.disclosureStatus,
      block_schema_version: record.blockVersion,
      canonical_url: remote.canonicalUrl,
      body_occurrences: remote.bodyOccurrences,
      legacy_occurrences: remote.legacyOccurrences,
      actor_comment_occurrences: remote.actorCommentOccurrences,
      proof_sha256: record.current.proof_sha256,
    },
  };
}

export async function syncFactoryDisclosure({
  factoryReceiptsDir,
  missionId,
  policy,
  request,
  apply = false,
  confirmPrUrl = null,
}) {
  validateDisclosurePolicy(policy);
  const record = await factoryDisclosureRecord({
    factoryReceiptsDir,
    entryName: validateMissionId(missionId),
    policy,
  });
  if (record.publicationState !== 'merged') {
    throw new Error(`${record.missionId} factory synchronizer requires publication pr_state MERGED`);
  }
  if (record.blockVersion !== 2) {
    throw new Error(`${record.missionId} factory synchronizer requires block schema version 2`);
  }
  if (apply && confirmPrUrl !== record.publication.pr_url) {
    throw new Error(`confirm PR URL (--confirm-pr-url) must exactly match ${record.publication.pr_url}`);
  }

  const { report, remote } = await auditFactoryDisclosureRecord({ record, policy, request });
  if (!apply) return { ...report, changed: false };
  if (report.status !== 'merged_sync_pending' || remote.matchedPublicationState !== 'open') {
    throw new Error(`${record.missionId} factory sync requires the exact open-state marked block`);
  }

  const command = record.proof?.patched_observation?.command;
  const updated = upsertDisclosureBlock(remote.body, {
    missionId: record.missionId,
    receiptUrl: remote.canonicalUrl,
    publicationState: 'merged',
    blockVersion: 2,
    command,
    headOid: record.proof.commit_oid,
    includeNoCiChange: remote.includeNoCiChange,
  });
  if (!updated.changed) {
    throw new Error(`${record.missionId} factory merged disclosure replacement made no change`);
  }
  const response = await requireResponse(
    request,
    remote.apiUrl,
    { method: 'PATCH', body: { body: updated.body } },
    `${record.missionId} GitHub PR update`,
  );
  if (!isObject(response.json) || response.json.body !== updated.body) {
    throw new Error(`${record.missionId} GitHub PR update did not return the requested body`);
  }

  const confirmed = await auditFactoryDisclosureRecord({ record, policy, request });
  if (confirmed.report.status !== 'verified' || confirmed.remote.body !== updated.body) {
    throw new Error(`${record.missionId} factory merged disclosure readback did not match the requested body`);
  }
  return { ...confirmed.report, changed: true };
}

export async function syncMissionDisclosure({
  missionDir,
  policy,
  request,
  apply = false,
  confirmPrUrl = null,
  now = new Date().toISOString(),
}) {
  validateDisclosurePolicy(policy);
  const mission = await readJson(path.join(missionDir, 'mission.json'), 'mission.json');
  const publicationFile = path.join(missionDir, 'publication.json');
  const publication = await readJson(publicationFile, 'publication.json');
  const missionId = validateMissionId(mission.mission_id);
  if (mission.variant !== 'author_contribution') throw new Error(`${missionId} is not an author_contribution`);
  if (policy.historical_exempt_mission_ids.includes(missionId)) {
    throw new Error(`${missionId} is historically exempt and cannot be rewritten by the synchronizer`);
  }
  if (!apply) {
    if (!isObject(publication.pr_disclosure)) {
      throw new Error(`${missionId} read-only check failed: missing publication pr_disclosure`);
    }
    return auditMissionDisclosure({ mission, publication, policy, request });
  }
  if (confirmPrUrl !== publication.pr_url) {
    throw new Error(`confirm PR URL (--confirm-pr-url) must exactly match ${publication.pr_url}`);
  }
  isoTime(now, '--now');

  const preflight = await auditRemote({
    mission,
    missionId,
    publication,
    policy,
    request,
    requireBodyLink: false,
    blockVersion: policy.current_block_schema_version,
  });
  const facts = recordedDisclosureFacts(mission, publication);
  const updated = upsertDisclosureBlock(preflight.body, {
    missionId,
    receiptUrl: preflight.canonicalUrl,
    publicationState: publication.state,
    blockVersion: policy.current_block_schema_version,
    ...facts,
  });
  if (updated.changed) {
    const response = await requireResponse(
      request,
      preflight.apiUrl,
      { method: 'PATCH', body: { body: updated.body } },
      `${missionId} GitHub PR update`,
    );
    if (!isObject(response.json) || response.json.body !== updated.body) {
      throw new Error(`${missionId} GitHub PR update did not return the requested body`);
    }
  }

  const nextPublication = {
    ...publication,
    pr_disclosure: {
      schema_version: policy.current_block_schema_version,
      required: true,
      mode: 'pr_body',
      canonical_url: preflight.canonicalUrl,
      verified_at: now,
    },
  };
  const report = await auditMissionDisclosure({
    mission,
    publication: nextPublication,
    policy,
    request,
  });
  await writeFile(publicationFile, `${JSON.stringify(nextPublication, null, 2)}\n`, 'utf8');
  return { ...report, changed: updated.changed };
}

async function githubGraphqlGetFallback({ fetchImpl, token, url }) {
  if (!token) return null;
  const parsed = new URL(url);
  if (parsed.origin !== 'https://api.github.com') return null;
  const pullMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
  const commentsMatch = parsed.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/);
  const match = pullMatch ?? commentsMatch;
  if (!match) return null;

  const variables = {
    owner: decodeURIComponent(match[1]),
    name: decodeURIComponent(match[2]),
    number: Number(match[3]),
  };
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'northset-pr-receipt-disclosure',
  };
  const queryGraphql = async (query, queryVariables) => {
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers,
      redirect: 'follow',
      body: JSON.stringify({ query, variables: queryVariables }),
    });
    if (response.status < 200 || response.status >= 300) return null;
    let payload;
    try {
      payload = await response.json();
    } catch {
      return null;
    }
    if (!isObject(payload) || (Array.isArray(payload.errors) && payload.errors.length > 0)) return null;
    return { payload, headers: response.headers };
  };

  if (pullMatch) {
    const result = await queryGraphql(
      'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url body}}}',
      variables,
    );
    const pull = result?.payload?.data?.repository?.pullRequest;
    if (!isObject(pull)) return null;
    return {
      status: 200,
      json: { number: pull.number, html_url: pull.url, body: pull.body },
      headers: result.headers,
    };
  }

  const comments = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await queryGraphql(
      'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){nodes{body author{login}} pageInfo{hasNextPage endCursor}}}}}',
      { ...variables, cursor },
    );
    const connection = result?.payload?.data?.repository?.pullRequest?.comments;
    if (!isObject(connection) || !Array.isArray(connection.nodes) || !isObject(connection.pageInfo)) return null;
    comments.push(...connection.nodes.map((comment) => ({
      body: comment?.body,
      user: isObject(comment?.author) ? { login: comment.author.login } : null,
    })));
    if (connection.pageInfo.hasNextPage !== true) {
      return { status: 200, json: comments, headers: result.headers };
    }
    if (typeof connection.pageInfo.endCursor !== 'string' || connection.pageInfo.endCursor === '') return null;
    cursor = connection.pageInfo.endCursor;
  }
  return null;
}

export function createFetchRequest({ fetchImpl = globalThis.fetch, token = null } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  return async (url, { method = 'GET', body = undefined } = {}) => {
    const origin = new URL(url).origin;
    if (method !== 'GET' && origin !== 'https://api.github.com') {
      throw new Error('write requests are restricted to the GitHub API origin');
    }
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'northset-pr-receipt-disclosure',
    };
    if (token && origin === 'https://api.github.com') headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetchImpl(url, {
      method,
      headers,
      redirect: 'follow',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (method === 'GET' && response.status === 503) {
      const fallback = await githubGraphqlGetFallback({ fetchImpl, token, url });
      if (fallback !== null) return fallback;
    }
    let json = null;
    const contentType = response.headers.get('content-type') ?? '';
    if (/\bjson\b/i.test(contentType)) {
      try {
        json = await response.json();
      } catch {
        json = null;
      }
    }
    return { status: response.status, json, headers: response.headers };
  };
}
