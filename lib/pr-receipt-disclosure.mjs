import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MISSION_ID_PATTERN = /^M-(?:\d{3}|E2[a-c])$/;
const POLICY_FIELDS = new Set([
  'schema_version',
  'canonical_receipt_base_url',
  'legacy_ledger_base_url',
  'historical_exempt_mission_ids',
  'northset_actor_logins',
]);
const DISCLOSURE_FIELDS = new Set([
  'schema_version',
  'required',
  'mode',
  'canonical_url',
  'verified_at',
]);

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
    throw new TypeError('mission id must use the M-000 or M-E2a form');
  }
  return missionId;
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
  if (value.schema_version !== 1) throw new TypeError('PR disclosure policy schema_version must equal 1');
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
  if (value.schema_version !== 1) throw new TypeError(`${missionId} pr_disclosure.schema_version must equal 1`);
  if (value.required !== true) throw new TypeError(`${missionId} pr_disclosure.required must be true`);
  if (value.mode !== 'pr_body') throw new TypeError(`${missionId} pr_disclosure.mode must be pr_body`);
  const expected = canonicalReceiptUrl(policy, missionId);
  if (value.canonical_url !== expected) {
    throw new TypeError(`${missionId} pr_disclosure.canonical_url must equal ${expected}`);
  }
  isoTime(value.verified_at, `${missionId} pr_disclosure.verified_at`);
  return value;
}

export function renderDisclosureBlock({ missionId, receiptUrl }) {
  validateMissionId(missionId);
  if (typeof receiptUrl !== 'string' || receiptUrl.length === 0) {
    throw new TypeError('receiptUrl is required');
  }
  return [
    `<!-- northset-receipt:${missionId}:start -->`,
    '### Verification',
    '',
    `[Northset proof-of-pass receipt ${missionId}](${receiptUrl})  `,
    'Contributor self-run; not maintainer verification.',
    `<!-- northset-receipt:${missionId}:end -->`,
  ].join('\n');
}

export function upsertDisclosureBlock(body, { missionId, receiptUrl }) {
  if (typeof body !== 'string') throw new TypeError('pull request body must be a string');
  const block = renderDisclosureBlock({ missionId, receiptUrl });
  const markerPattern = /<!-- northset-receipt:(M-(?:\d{3}|E2[a-c])):(start|end) -->/g;
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
  const legacyUrl = `${receipt.origin}${receipt.pathname.replace(/receipts\/M-(?:\d{3}|E2[a-c])\/$/, '')}#${missionId}`;
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

async function auditRemote({ missionId, publication, policy, request, requireBodyLink = true }) {
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
    (requireBodyLink && ledgerLinkOccurrences !== 1)
    || (!requireBodyLink && ledgerLinkOccurrences > bodyOccurrences)
  ) {
    throw new Error(`${missionId} PR body must contain only one Northset ledger link; found ${ledgerLinkOccurrences}`);
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
  validateStoredDisclosure(publication.pr_disclosure, { missionId, policy });
  const remote = await auditRemote({ missionId, publication, policy, request });
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
    missionId,
    publication,
    policy,
    request,
    requireBodyLink: false,
  });
  const updated = upsertDisclosureBlock(preflight.body, {
    missionId,
    receiptUrl: preflight.canonicalUrl,
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
      schema_version: 1,
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
