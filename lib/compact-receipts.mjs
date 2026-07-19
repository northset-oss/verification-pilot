import {createHash} from 'node:crypto';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const MISSION_PATTERN = /^M-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OID_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DEFAULT_REPOSITORY_URL = 'https://github.com/northset-oss/verification-pilot';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!isObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function validMissionId(value) {
  if (typeof value !== 'string' || !MISSION_PATTERN.test(value)) throw new TypeError('invalid compact receipt mission_id');
  return value;
}

function validOid(value, label) {
  if (typeof value !== 'string' || !OID_PATTERN.test(value)) throw new TypeError(`${label} must be a full git OID`);
  return value;
}

function validDigest(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a sha256 digest`);
  return value;
}

function validateProof(proof, missionId, commitOid) {
  const required = [
    'schema_version', 'mission_id', 'task_id', 'repository', 'issue_number', 'candidate',
    'base_oid', 'patch_sha256', 'commit_oid', 'tested_tree_oid', 'checks', 'claim',
    'batch_approval_digest', 'environment', 'base_observation', 'patched_observation',
  ];
  if (!exactKeys(proof, required)) throw new TypeError(`${missionId} proof.json has an invalid shape`);
  if (proof.schema_version !== 1 || proof.mission_id !== missionId) throw new TypeError(`${missionId} proof identity is invalid`);
  validOid(proof.base_oid, `${missionId} base_oid`);
  validOid(proof.commit_oid, `${missionId} commit_oid`);
  validOid(proof.tested_tree_oid, `${missionId} tested_tree_oid`);
  if (proof.commit_oid !== commitOid) throw new TypeError(`${missionId} proof path does not match commit_oid`);
  validDigest(proof.patch_sha256, `${missionId} patch_sha256`);
  validDigest(proof.batch_approval_digest, `${missionId} batch_approval_digest`);
  if (!REPOSITORY_PATTERN.test(proof.repository)) throw new TypeError(`${missionId} repository is invalid`);
  if (!Number.isInteger(proof.issue_number) || proof.issue_number < 1) throw new TypeError(`${missionId} issue_number is invalid`);
  if (!Array.isArray(proof.checks) || proof.checks.length === 0 || proof.checks.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${missionId} checks must be a non-empty string array`);
  }
  if (!isObject(proof.claim) || typeof proof.claim.type !== 'string' || typeof proof.claim.statement !== 'string') {
    throw new TypeError(`${missionId} claim is invalid`);
  }
  if (!isObject(proof.environment) || !isObject(proof.base_observation) || !isObject(proof.patched_observation)) {
    throw new TypeError(`${missionId} recorded environment or observations are invalid`);
  }
  return proof;
}

function validatePointer(pointer, missionId) {
  const required = ['schema_version', 'mission_id', 'contribution_commit_oid', 'proof_sha256'];
  if (!exactKeys(pointer, required) || pointer.schema_version !== 1 || pointer.mission_id !== missionId) {
    throw new TypeError(`${missionId} current.json is invalid`);
  }
  validOid(pointer.contribution_commit_oid, `${missionId} current contribution_commit_oid`);
  validDigest(pointer.proof_sha256, `${missionId} current proof_sha256`);
  return pointer;
}

async function readJson(file, label) {
  let bytes;
  try { bytes = await readFile(file); }
  catch (error) { throw new TypeError(`${label} is unreadable: ${error.message}`); }
  try { return {bytes, value: JSON.parse(bytes.toString('utf8'))}; }
  catch { throw new TypeError(`${label} is not valid JSON`); }
}

async function currentPointer(missionDirectory, missionId) {
  try {
    const {value} = await readJson(path.join(missionDirectory, 'current.json'), `${missionId} current.json`);
    return validatePointer(value, missionId);
  } catch (error) {
    if (!/unreadable: ENOENT/.test(error.message)) throw error;
    const entries = (await readdir(missionDirectory, {withFileTypes: true}))
      .filter((entry) => entry.isDirectory() && OID_PATTERN.test(entry.name));
    if (entries.length !== 1) throw new TypeError(`${missionId} needs current.json when it has ${entries.length} proof directories`);
    const commitOid = entries[0].name;
    const {bytes} = await readJson(path.join(missionDirectory, commitOid, 'proof.json'), `${missionId} proof.json`);
    return {schema_version: 1, mission_id: missionId, contribution_commit_oid: commitOid, proof_sha256: digest(bytes)};
  }
}

function receiptJson(proof, proofSha256, rawProofUrl) {
  return {
    schema_version: 1,
    mission_id: proof.mission_id,
    receipt_class: 'compact_contributor_self_run',
    claim: proof.claim,
    target: {
      repository: proof.repository,
      issue_number: proof.issue_number,
      base_oid: proof.base_oid,
      contribution_commit_oid: proof.commit_oid,
      tested_tree_oid: proof.tested_tree_oid,
      patch_sha256: proof.patch_sha256,
    },
    checks: proof.checks,
    observations: {base: proof.base_observation, patched: proof.patched_observation},
    environment: proof.environment,
    approval: {batch_approval_digest: proof.batch_approval_digest},
    source: {proof_sha256: proofSha256, raw_proof_url: rawProofUrl},
    limitations: [
      'Contributor self-run; not maintainer verification.',
      'The receipt records the declared checks and observations. It does not prove code quality, security, full CI coverage, production readiness, or maintainer approval.',
    ],
  };
}

function renderReceipt(receipt, canonicalUrl) {
  const checks = receipt.checks.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('');
  const target = receipt.target;
  const issueUrl = `https://github.com/${target.repository}/issues/${target.issue_number}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(receipt.mission_id)} proof-of-pass receipt</title>
<style>body{max-width:58rem;margin:3rem auto;padding:0 1.25rem;background:#14221e;color:#eef5f1;font:16px/1.55 system-ui,sans-serif}a{color:#9fe3bd}code{overflow-wrap:anywhere;color:#c8f2dc}section{padding:1rem 0;border-top:1px solid #41564d}.label{color:#9dafA7;text-transform:uppercase;letter-spacing:.08em;font-size:.75rem}.warning{padding:.8rem;border-left:4px solid #d8a94d;background:#2c2b21}dt{color:#9dafA7}dd{margin:0 0 .8rem}</style></head>
<body><p class="label">Northset public receipt ledger</p><h1>${escapeHtml(receipt.mission_id)} proof-of-pass receipt</h1>
<p class="warning">Contributor self-run. Not maintainer verification.</p>
<section><h2>Contribution identity</h2><dl><dt>Repository</dt><dd><a href="https://github.com/${escapeHtml(target.repository)}">${escapeHtml(target.repository)}</a></dd><dt>Issue</dt><dd><a href="${escapeHtml(issueUrl)}">#${target.issue_number}</a></dd><dt>Base commit</dt><dd><code>${target.base_oid}</code></dd><dt>Contribution commit</dt><dd><code>${target.contribution_commit_oid}</code></dd><dt>Tested tree</dt><dd><code>${target.tested_tree_oid}</code></dd><dt>Patch SHA-256</dt><dd><code>${target.patch_sha256}</code></dd></dl></section>
<section><h2>Recorded checks</h2><ul>${checks}</ul></section>
<section><h2>Claim</h2><p>${escapeHtml(receipt.claim.statement)}</p></section>
<section><h2>Provenance and limitations</h2><p>Proof SHA-256: <code>${receipt.source.proof_sha256}</code></p><p><a href="${escapeHtml(receipt.source.raw_proof_url)}">Inspect the immutable raw proof</a> · <a href="${escapeHtml(canonicalUrl)}receipt.json">Machine-readable receipt</a></p><ul>${receipt.limitations.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>
</body></html>\n`;
}

export async function renderCompactReceipts({receiptsDir, siteDir, repositoryUrl = DEFAULT_REPOSITORY_URL} = {}) {
  if (typeof receiptsDir !== 'string' || typeof siteDir !== 'string') throw new TypeError('receiptsDir and siteDir are required');
  const missionEntries = (await readdir(receiptsDir, {withFileTypes: true}))
    .filter((entry) => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name));
  const index = [];
  for (const entry of missionEntries) {
    const missionId = validMissionId(entry.name);
    const missionDirectory = path.join(receiptsDir, missionId);
    const pointer = await currentPointer(missionDirectory, missionId);
    const commitOid = pointer.contribution_commit_oid;
    const proofFile = path.join(missionDirectory, commitOid, 'proof.json');
    const {bytes, value} = await readJson(proofFile, `${missionId} proof.json`);
    if (digest(bytes) !== pointer.proof_sha256) throw new TypeError(`${missionId} current proof digest does not match proof.json`);
    const proof = validateProof(value, missionId, commitOid);
    const rawProofUrl = `${repositoryUrl}/blob/receipts/receipts/${missionId}/${commitOid}/proof.json`;
    const canonicalUrl = `https://northset-oss.github.io/verification-pilot/receipts/${missionId}/`;
    const receipt = receiptJson(proof, pointer.proof_sha256, rawProofUrl);
    const outputDirectory = path.join(siteDir, 'receipts', missionId);
    await mkdir(outputDirectory, {recursive: true});
    await writeFile(path.join(outputDirectory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await writeFile(path.join(outputDirectory, 'index.html'), renderReceipt(receipt, canonicalUrl), 'utf8');
    index.push({mission_id: missionId, canonical_url: canonicalUrl, proof_sha256: pointer.proof_sha256,
      contribution_commit_oid: commitOid});
  }
  await mkdir(path.join(siteDir, 'receipts'), {recursive: true});
  await writeFile(path.join(siteDir, 'receipts', 'compact-index.json'),
    `${JSON.stringify({schema_version: 1, receipts: index}, null, 2)}\n`, 'utf8');
  return index;
}
