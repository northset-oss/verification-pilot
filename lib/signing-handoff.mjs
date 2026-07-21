import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {createGzip, gunzipSync} from 'node:zlib';

export const MAX_SIGNING_MISSIONS = 50;

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MISSION_ID_PATTERN = /^M-(?:\d{3,}|E2[a-c])$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FIXED_TAR_MTIME_SECONDS = 1_577_836_800;
const PROCESS_OUTPUT_LIMIT = 32 * 1024 * 1024;
const ARCHIVE_SIZE_MARGIN = 1024 * 1024;
const ZERO_BLOCK = Buffer.alloc(512);
const VERIFIER_FILES = [
  'bin/signing-handoff.mjs',
  'lib/signing-handoff.mjs',
];

export class SigningHandoffError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningHandoffError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(value, keys) {
  if (!isObject(value)) return false;
  return JSON.stringify(Object.keys(value).sort(compareText)) === JSON.stringify([...keys].sort(compareText));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function readJson(file, label) {
  let source;
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('path is not a regular file');
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new SigningHandoffError(`cannot read ${label} at ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new SigningHandoffError(`invalid JSON in ${label}: ${error.message}`);
  }
}

function validateRevision(value, label) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    throw new SigningHandoffError(`invalid ${label} SHA`);
  }
}

function run(command, args, {cwd} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      reject(new SigningHandoffError(`cannot start ${command}: ${error.message}`));
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.on('error', (error) => fail(new SigningHandoffError(`cannot start ${command}: ${error.message}`)));
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > PROCESS_OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        fail(new SigningHandoffError(`${command} output exceeded the local safety limit`));
      } else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > PROCESS_OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        fail(new SigningHandoffError(`${command} output exceeded the local safety limit`));
      } else stderr.push(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (code === 0) resolve(result);
      else {
        const detail = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim();
        reject(new SigningHandoffError(`${command} failed${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

async function resolveCommit(repoDir, revision, label) {
  validateRevision(revision, label);
  let result;
  try {
    result = await run('git', ['rev-parse', '--verify', `${revision}^{commit}`], {cwd: repoDir});
  } catch (error) {
    throw new SigningHandoffError(`invalid ${label} SHA: ${error.message}`);
  }
  const resolved = result.stdout.toString('utf8').trim().toLowerCase();
  if (resolved !== revision) throw new SigningHandoffError(`invalid ${label} SHA: revision did not resolve exactly`);
  return resolved;
}

/**
 * Resolve the exact push range and return its unique changed bundle identities.
 */
export async function discoverChangedMissions({repoDir, beforeSha, headSha, requireCheckedOutHead = true}) {
  const repository = await realpath(repoDir).catch((error) => {
    throw new SigningHandoffError(`cannot resolve repository directory: ${error.message}`);
  });
  const stats = await lstat(repository);
  if (!stats.isDirectory()) throw new SigningHandoffError('repository path must be a directory');

  const before = await resolveCommit(repository, beforeSha, 'before');
  const head = await resolveCommit(repository, headSha, 'head');
  if (requireCheckedOutHead) {
    const currentHead = (await run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {cwd: repository}))
      .stdout.toString('utf8').trim().toLowerCase();
    if (currentHead !== head) throw new SigningHandoffError('head SHA does not match the checked-out repository');
  }

  let changed;
  try {
    changed = await run('git', [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-renames',
      '--name-only',
      '--diff-filter=ACDMRTUXB',
      '-z',
      `${before}..${head}`,
      '--',
      ':(glob)missions/*/bundle/**',
    ], {cwd: repository});
  } catch (error) {
    throw new SigningHandoffError(`cannot discover changed mission bundles: ${error.message}`);
  }
  const source = changed.stdout.toString('utf8');
  if (source.includes('\uFFFD')) throw new SigningHandoffError('changed bundle path is not valid UTF-8');

  const identities = new Set();
  for (const changedPath of source.split('\0').filter(Boolean)) {
    const components = changedPath.split('/');
    if (components.length < 4 || components[0] !== 'missions' || components[2] !== 'bundle') {
      throw new SigningHandoffError(`invalid changed bundle path: ${changedPath}`);
    }
    const missionId = components[1];
    if (!MISSION_ID_PATTERN.test(missionId)) {
      throw new SigningHandoffError(`invalid changed mission identity: ${missionId}`);
    }
    identities.add(missionId);
  }

  const missions = [...identities].sort(compareText);
  if (missions.length > MAX_SIGNING_MISSIONS) {
    throw new SigningHandoffError(`a signing handoff supports at most ${MAX_SIGNING_MISSIONS} changed missions`);
  }
  return {repository, beforeSha: before, headSha: head, missions};
}

async function walkRegularTree(directory, prefix = '') {
  const entries = [];
  const names = await readdir(directory, {withFileTypes: true});
  names.sort((left, right) => compareText(left.name, right.name));
  for (const name of names) {
    const relativePath = prefix ? `${prefix}/${name.name}` : name.name;
    const absolutePath = path.join(directory, name.name);
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) throw new SigningHandoffError(`symbolic links are not allowed in a signing handoff: ${relativePath}`);
    if (stats.isDirectory()) {
      entries.push({kind: 'directory', path: relativePath, absolutePath, mode: stats.mode});
      entries.push(...await walkRegularTree(absolutePath, relativePath));
    } else if (stats.isFile()) {
      entries.push({kind: 'file', path: relativePath, absolutePath, mode: stats.mode, size: stats.size});
    } else {
      throw new SigningHandoffError(`only regular files and directories are allowed: ${relativePath}`);
    }
  }
  return entries;
}

function safeManifestPath(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value !== 'bundle.manifest.json'
    && safeBundlePath(value)
  );
}

function safeBundlePath(value) {
  return (
    typeof value === 'string'
    && value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && path.posix.normalize(value) === value
    && value.split('/').every((component) => component !== '' && component !== '.' && component !== '..')
  );
}

function validateMissionJson(value, missionId, label) {
  if (!isObject(value) || value.mission_id !== missionId || !MISSION_ID_PATTERN.test(value.mission_id)) {
    throw new SigningHandoffError(`invalid mission identity in ${label} for ${missionId}`);
  }
}

function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
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
    month >= 1
    && month <= 12
    && day >= 1
    && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 60
    && offsetHour <= 23
    && offsetMinute <= 59
  );
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new SigningHandoffError(`invalid JSON in ${label}: ${error.message}`);
  }
}

async function readGitBlob(repository, objectId, label) {
  try {
    return (await run('git', ['cat-file', 'blob', objectId], {cwd: repository})).stdout;
  } catch (error) {
    throw new SigningHandoffError(`cannot read ${label} from the head Git tree: ${error.message}`);
  }
}

async function loadHeadBundle(repository, headSha, missionId) {
  const missionPath = `missions/${missionId}/mission.json`;
  const bundlePrefix = `missions/${missionId}/bundle/`;
  let listing;
  try {
    listing = await run('git', [
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      headSha,
      '--',
      missionPath,
      `missions/${missionId}/bundle`,
    ], {cwd: repository});
  } catch (error) {
    throw new SigningHandoffError(`cannot inspect the head Git tree for ${missionId}: ${error.message}`);
  }
  const source = listing.stdout.toString('utf8');
  if (source.includes('\uFFFD')) throw new SigningHandoffError(`Git tree paths are not valid UTF-8 for ${missionId}`);

  let outerMissionRecord = null;
  const fileRecords = [];
  const seen = new Set();
  for (const record of source.split('\0').filter(Boolean)) {
    const match = record.match(/^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/);
    if (!match) throw new SigningHandoffError(`invalid Git tree record for ${missionId}`);
    const [, gitMode, objectType, objectId, gitPath] = match;
    if (objectType !== 'blob' || !['100644', '100755'].includes(gitMode)) {
      throw new SigningHandoffError(`only regular Git blobs are allowed for ${missionId}: ${gitPath}`);
    }
    if (gitPath === missionPath) {
      if (outerMissionRecord !== null) throw new SigningHandoffError(`duplicate mission.json in the head Git tree for ${missionId}`);
      outerMissionRecord = {objectId};
      continue;
    }
    if (!gitPath.startsWith(bundlePrefix)) throw new SigningHandoffError(`unexpected Git tree path for ${missionId}: ${gitPath}`);
    const relativePath = gitPath.slice(bundlePrefix.length);
    if (!safeBundlePath(relativePath) || seen.has(relativePath)) {
      throw new SigningHandoffError(`unsafe or duplicate bundle path in the head Git tree for ${missionId}: ${relativePath}`);
    }
    seen.add(relativePath);
    fileRecords.push({
      kind: 'file',
      path: relativePath,
      mode: gitMode === '100755' ? 0o755 : 0o644,
      objectId,
    });
  }
  if (outerMissionRecord === null) throw new SigningHandoffError(`missing mission directory for ${missionId}`);
  if (fileRecords.length === 0) throw new SigningHandoffError(`missing bundle directory for ${missionId}`);

  const outerMissionBytes = await readGitBlob(repository, outerMissionRecord.objectId, `${missionId} mission.json`);
  for (const file of fileRecords) {
    file.bytes = await readGitBlob(repository, file.objectId, `${missionId} bundle/${file.path}`);
    file.size = file.bytes.byteLength;
    file.expectedSha256 = sha256(file.bytes);
    delete file.objectId;
  }

  const directoryPaths = new Set();
  for (const file of fileRecords) {
    const components = file.path.split('/');
    for (let index = 1; index < components.length; index += 1) {
      directoryPaths.add(components.slice(0, index).join('/'));
    }
  }
  const entries = [
    ...[...directoryPaths].map((directoryPath) => ({kind: 'directory', path: directoryPath, mode: 0o755})),
    ...fileRecords,
  ].sort((left, right) => compareText(left.path, right.path));
  const bundleDigest = validateBundleEntries({missionId, outerMissionBytes, entries});
  return {missionId, outerMissionBytes, bundleDigest, entries};
}

function validateBundleEntries({missionId, outerMissionBytes, entries}) {
  const outerMission = parseJsonBytes(outerMissionBytes, `${missionId} mission.json`);
  const files = entries
    .filter((entry) => entry.kind === 'file')
    .sort((left, right) => compareText(left.path, right.path));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const bundledMissionEntry = fileByPath.get('mission.json');
  const manifestEntry = fileByPath.get('bundle.manifest.json');
  if (bundledMissionEntry === undefined) throw new SigningHandoffError(`missing bundled mission.json for ${missionId}`);
  if (manifestEntry === undefined) throw new SigningHandoffError(`missing bundle.manifest.json for ${missionId}`);
  const bundledMission = parseJsonBytes(bundledMissionEntry.bytes, `${missionId} bundled mission.json`);
  const manifest = parseJsonBytes(manifestEntry.bytes, `${missionId} bundle.manifest.json`);
  validateMissionJson(outerMission, missionId, 'mission.json');
  validateMissionJson(bundledMission, missionId, 'bundle/mission.json');

  if (
    !isObject(manifest)
    || manifest.version !== '0'
    || !isIsoDateTime(manifest.created_at)
    || !Array.isArray(manifest.files)
  ) {
    throw new SigningHandoffError(`invalid bundle.manifest.json for ${missionId}`);
  }
  if (typeof manifest.bundle_digest !== 'string' || !PREFIXED_SHA256_PATTERN.test(manifest.bundle_digest)) {
    throw new SigningHandoffError(`invalid bundle digest for ${missionId}`);
  }

  const expectedFiles = new Map();
  let previousPath = null;
  for (const file of manifest.files) {
    if (
      !exactKeys(file, ['path', 'sha256', 'bytes'])
      || !safeManifestPath(file.path)
      || !SHA256_PATTERN.test(file.sha256)
      || !Number.isInteger(file.bytes)
      || file.bytes < 0
      || expectedFiles.has(file.path)
      || (previousPath !== null && compareText(previousPath, file.path) >= 0)
    ) {
      throw new SigningHandoffError(`invalid bundle.manifest.json for ${missionId}`);
    }
    expectedFiles.set(file.path, file);
    previousPath = file.path;
  }

  const actualFiles = files.filter((entry) => entry.path !== 'bundle.manifest.json');
  if (actualFiles.length !== expectedFiles.size) {
    throw new SigningHandoffError(`bundle file set does not match bundle.manifest.json for ${missionId}`);
  }
  const digest = createHash('sha256');
  for (const file of actualFiles) {
    const expected = expectedFiles.get(file.path);
    if (expected === undefined) {
      throw new SigningHandoffError(`bundle file set does not match bundle.manifest.json for ${missionId}`);
    }
    const fileSha256 = sha256(file.bytes);
    if (file.bytes.byteLength !== expected.bytes || fileSha256 !== expected.sha256) {
      throw new SigningHandoffError(`bundle file does not match bundle.manifest.json for ${missionId}: ${file.path}`);
    }
    file.expectedSha256 = fileSha256;
    digest.update(`${file.path}\0${fileSha256}\n`);
  }
  const actualDigest = `sha256:${digest.digest('hex')}`;
  if (actualDigest !== manifest.bundle_digest) throw new SigningHandoffError(`invalid bundle digest for ${missionId}`);
  manifestEntry.expectedSha256 = sha256(manifestEntry.bytes);
  return actualDigest;
}

function writeText(target, offset, length, value, label) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new SigningHandoffError(`${label} is too long for the deterministic tar format`);
  bytes.copy(target, offset);
}

function writeOctal(target, offset, length, value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new SigningHandoffError(`invalid ${label} for tar entry`);
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new SigningHandoffError(`${label} is too large for the deterministic tar format`);
  writeText(target, offset, length, `${octal.padStart(length - 1, '0')}\0`, label);
}

function splitTarPath(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) return {name: archivePath, prefix: ''};
  for (let index = archivePath.length - 2; index > 0; index -= 1) {
    if (archivePath[index] !== '/') continue;
    const prefix = archivePath.slice(0, index);
    const name = archivePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return {name, prefix};
  }
  throw new SigningHandoffError(`bundle path is too long for the deterministic tar format: ${archivePath}`);
}

function tarHeader(archivePath, {directory, size = 0, executable = false}) {
  const header = Buffer.alloc(512);
  const {name, prefix} = splitTarPath(archivePath);
  writeText(header, 0, 100, name, 'tar path');
  writeOctal(header, 100, 8, directory || executable ? 0o755 : 0o644, 'tar mode');
  writeOctal(header, 108, 8, 0, 'tar uid');
  writeOctal(header, 116, 8, 0, 'tar gid');
  writeOctal(header, 124, 12, directory ? 0 : size, 'tar size');
  writeOctal(header, 136, 12, FIXED_TAR_MTIME_SECONDS, 'tar mtime');
  header.fill(0x20, 148, 156);
  header[156] = directory ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
  writeText(header, 257, 6, 'ustar\0', 'tar magic');
  writeText(header, 263, 2, '00', 'tar version');
  if (prefix) writeText(header, 345, 155, prefix, 'tar path prefix');
  const checksum = header.reduce((total, byte) => total + byte, 0);
  const checksumText = checksum.toString(8);
  if (checksumText.length > 6) throw new SigningHandoffError('tar checksum is too large');
  writeText(header, 148, 6, checksumText.padStart(6, '0'), 'tar checksum');
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function* tarChunks(bundle) {
  yield tarHeader('bundle/', {directory: true});
  for (const entry of bundle.entries) {
    const archivePath = `bundle/${entry.path}${entry.kind === 'directory' ? '/' : ''}`;
    if (entry.kind === 'directory') {
      yield tarHeader(archivePath, {directory: true});
      continue;
    }

    yield tarHeader(archivePath, {
      directory: false,
      size: entry.size,
      executable: (entry.mode & 0o111) !== 0,
    });
    if (entry.bytes.byteLength !== entry.size || sha256(entry.bytes) !== entry.expectedSha256) {
      throw new SigningHandoffError(`invalid head Git tree bytes while packaging: ${bundle.missionId}/${entry.path}`);
    }
    yield entry.bytes;
    const padding = (512 - (entry.size % 512)) % 512;
    if (padding !== 0) yield Buffer.alloc(padding);
  }
  yield ZERO_BLOCK;
  yield ZERO_BLOCK;
}

async function createTarball(bundle, outputFile) {
  try {
    await pipeline(
      Readable.from(tarChunks(bundle)),
      createGzip({level: 9, mtime: 0}),
      createWriteStream(outputFile, {flags: 'wx', mode: 0o600}),
    );
  } catch (error) {
    await rm(outputFile, {force: true});
    if (error instanceof SigningHandoffError) throw error;
    throw new SigningHandoffError(`cannot create deterministic tarball for ${bundle.missionId}: ${error.message}`);
  }
}

function expectedTarByteLength(bundle) {
  let total = 512 + 1024;
  for (const entry of bundle.entries) {
    total += 512;
    if (entry.kind === 'file') total += entry.size + ((512 - (entry.size % 512)) % 512);
  }
  return total;
}

function readTarText(header, offset, length, label) {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  const value = bytes.toString('utf8');
  if (value.includes('\uFFFD')) throw new SigningHandoffError(`archive ${label} is not valid UTF-8`);
  return value;
}

function readTarOctal(header, offset, length, label) {
  const value = header.subarray(offset, offset + length).toString('ascii');
  if (!/^[0-7]+\0$/.test(value)) throw new SigningHandoffError(`archive has an invalid ${label}`);
  const result = Number.parseInt(value.slice(0, -1), 8);
  if (!Number.isSafeInteger(result)) throw new SigningHandoffError(`archive has an invalid ${label}`);
  return result;
}

function parseTarArchive(tarBytes, missionId) {
  if (tarBytes.byteLength % 512 !== 0) throw new SigningHandoffError(`archive size is invalid for ${missionId}`);
  const entries = [];
  const seen = new Set();
  const directories = new Set();
  let previousPath = null;
  let offset = 0;
  let memberIndex = 0;
  let ended = false;

  while (offset < tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (header.byteLength !== 512) throw new SigningHandoffError(`archive header is truncated for ${missionId}`);
    if (header.equals(ZERO_BLOCK)) {
      const secondTrailer = tarBytes.subarray(offset + 512, offset + 1024);
      if (
        memberIndex === 0
        || secondTrailer.byteLength !== 512
        || !secondTrailer.equals(ZERO_BLOCK)
        || offset + 1024 !== tarBytes.byteLength
      ) {
        throw new SigningHandoffError(`archive trailer is invalid for ${missionId}`);
      }
      offset += 1024;
      ended = true;
      break;
    }

    const name = readTarText(header, 0, 100, 'path');
    const prefix = readTarText(header, 345, 155, 'path prefix');
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const mode = readTarOctal(header, 100, 8, 'mode');
    const size = readTarOctal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156]);
    const directory = type === '5';
    if (!directory && type !== '0') throw new SigningHandoffError(`archive member type is unsafe for ${missionId}: ${archivePath}`);
    if (directory && (size !== 0 || mode !== 0o755 || !archivePath.endsWith('/'))) {
      throw new SigningHandoffError(`archive directory member is invalid for ${missionId}: ${archivePath}`);
    }
    if (!directory && (![0o644, 0o755].includes(mode) || archivePath.endsWith('/'))) {
      throw new SigningHandoffError(`archive file member is invalid for ${missionId}: ${archivePath}`);
    }
    const canonicalHeader = tarHeader(archivePath, {
      directory,
      size,
      executable: mode === 0o755,
    });
    if (!header.equals(canonicalHeader)) {
      throw new SigningHandoffError(`archive header is not canonical for ${missionId}: ${archivePath}`);
    }

    offset += 512;
    if (memberIndex === 0) {
      if (!directory || archivePath !== 'bundle/') {
        throw new SigningHandoffError(`archive root is invalid for ${missionId}`);
      }
      memberIndex += 1;
      continue;
    }
    if (!archivePath.startsWith('bundle/')) {
      throw new SigningHandoffError(`archive member is outside bundle/ for ${missionId}: ${archivePath}`);
    }
    const relativePath = archivePath.slice('bundle/'.length, directory ? -1 : undefined);
    if (!safeBundlePath(relativePath) || seen.has(relativePath)) {
      throw new SigningHandoffError(`archive member is unsafe or duplicated for ${missionId}: ${archivePath}`);
    }
    if (previousPath !== null && compareText(previousPath, relativePath) >= 0) {
      throw new SigningHandoffError(`archive members are not deterministically sorted for ${missionId}`);
    }
    const components = relativePath.split('/');
    for (let index = 1; index < components.length; index += 1) {
      const parent = components.slice(0, index).join('/');
      if (!directories.has(parent)) {
        throw new SigningHandoffError(`archive member has a missing parent directory for ${missionId}: ${archivePath}`);
      }
    }

    let bytes;
    if (directory) {
      bytes = undefined;
      directories.add(relativePath);
    } else {
      if (offset + size > tarBytes.byteLength) {
        throw new SigningHandoffError(`archive member is truncated for ${missionId}: ${archivePath}`);
      }
      bytes = Buffer.from(tarBytes.subarray(offset, offset + size));
      offset += size;
      const padding = (512 - (size % 512)) % 512;
      const paddingBytes = tarBytes.subarray(offset, offset + padding);
      if (paddingBytes.byteLength !== padding || paddingBytes.some((byte) => byte !== 0)) {
        throw new SigningHandoffError(`archive member padding is invalid for ${missionId}: ${archivePath}`);
      }
      offset += padding;
    }
    seen.add(relativePath);
    previousPath = relativePath;
    entries.push({kind: directory ? 'directory' : 'file', path: relativePath, mode, size, bytes});
    memberIndex += 1;
  }
  if (!ended || offset !== tarBytes.byteLength) throw new SigningHandoffError(`archive trailer is missing for ${missionId}`);
  return entries;
}

function assertArchiveMatchesHead(actualEntries, expectedBundle) {
  if (actualEntries.length !== expectedBundle.entries.length) {
    throw new SigningHandoffError(`archive member set does not match the head Git tree for ${expectedBundle.missionId}`);
  }
  for (let index = 0; index < actualEntries.length; index += 1) {
    const actual = actualEntries[index];
    const expected = expectedBundle.entries[index];
    if (
      actual.kind !== expected.kind
      || actual.path !== expected.path
      || actual.mode !== expected.mode
      || (actual.kind === 'file'
        && (actual.size !== expected.size || !actual.bytes.equals(expected.bytes)))
    ) {
      throw new SigningHandoffError(`archive does not match the head Git tree for ${expectedBundle.missionId}: ${actual.path}`);
    }
  }
}

async function verifyMissionArchive({handoffDir, mission, expectedBundle}) {
  const archivePath = path.join(handoffDir, mission.asset_name);
  const expectedLength = expectedTarByteLength(expectedBundle);
  const stats = await lstat(archivePath).catch(() => null);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > expectedLength + ARCHIVE_SIZE_MARGIN) {
    throw new SigningHandoffError(`archive file is invalid for ${mission.mission_id}`);
  }
  const archiveBytes = await readFile(archivePath);
  if (`sha256:${sha256(archiveBytes)}` !== mission.tarball_sha256) {
    throw new SigningHandoffError(`tarball SHA-256 mismatch for ${mission.mission_id}`);
  }
  let tarBytes;
  try {
    tarBytes = gunzipSync(archiveBytes, {maxOutputLength: expectedLength});
  } catch (error) {
    throw new SigningHandoffError(`cannot inspect archive for ${mission.mission_id}: ${error.message}`);
  }
  if (tarBytes.byteLength !== expectedLength) {
    throw new SigningHandoffError(`archive size does not match the head Git tree for ${mission.mission_id}`);
  }
  const entries = parseTarArchive(tarBytes, mission.mission_id);
  const archiveDigest = validateBundleEntries({
    missionId: mission.mission_id,
    outerMissionBytes: expectedBundle.outerMissionBytes,
    entries,
  });
  if (archiveDigest !== mission.bundle_digest) {
    throw new SigningHandoffError(`archive bundle digest does not match metadata for ${mission.mission_id}`);
  }
  assertArchiveMatchesHead(entries, expectedBundle);
}

async function copyVerifier(outDir) {
  const verifierDirectory = path.join(outDir, 'verifier');
  await Promise.all([
    mkdir(path.join(verifierDirectory, 'bin'), {recursive: true}),
    mkdir(path.join(verifierDirectory, 'lib'), {recursive: true}),
  ]);
  const verifier = {};
  for (const relativePath of VERIFIER_FILES) {
    const source = path.join(PROJECT_ROOT, ...relativePath.split('/'));
    const destination = path.join(verifierDirectory, ...relativePath.split('/'));
    await copyFile(source, destination);
    verifier[relativePath] = `sha256:${await sha256File(destination)}`;
  }
  return verifier;
}

/**
 * Build the complete CI-to-signer handoff for the exact before..head range.
 */
export async function createSigningHandoff({repoDir, beforeSha, headSha, outDir}) {
  if (typeof repoDir !== 'string' || repoDir.length === 0) throw new SigningHandoffError('repository directory is required');
  if (typeof outDir !== 'string' || outDir.length === 0) throw new SigningHandoffError('output directory is required');
  const discovered = await discoverChangedMissions({repoDir, beforeSha, headSha});
  const requestedOutput = path.resolve(outDir);
  const outputParent = await realpath(path.dirname(requestedOutput)).catch((error) => {
    throw new SigningHandoffError(`cannot resolve output parent directory: ${error.message}`);
  });
  const outputDirectory = path.join(outputParent, path.basename(requestedOutput));
  if (outputDirectory === discovered.repository || outputDirectory.startsWith(`${discovered.repository}${path.sep}`)) {
    throw new SigningHandoffError('output directory must be outside the source repository');
  }

  const bundles = [];
  for (const missionId of discovered.missions) {
    bundles.push(await loadHeadBundle(discovered.repository, discovered.headSha, missionId));
  }

  await mkdir(outputDirectory);
  try {
    const verifier = await copyVerifier(outputDirectory);
    const missions = [];
    for (const bundle of bundles) {
      const digestHex = bundle.bundleDigest.slice('sha256:'.length);
      const prefix = digestHex.slice(0, 12);
      const assetName = `run-record-${bundle.missionId}-${prefix}.tar.gz`;
      const releaseTag = `run-record-${bundle.missionId}-${prefix}`;
      const outputFile = path.join(outputDirectory, assetName);
      await createTarball(bundle, outputFile);
      missions.push({
        mission_id: bundle.missionId,
        bundle_digest: bundle.bundleDigest,
        asset_name: assetName,
        release_tag: releaseTag,
        tarball_sha256: `sha256:${await sha256File(outputFile)}`,
      });
    }

    const metadata = {
      schema_version: 3,
      no_op: missions.length === 0,
      before_sha: discovered.beforeSha,
      head_sha: discovered.headSha,
      verifier,
      missions,
    };
    await writeFile(path.join(outputDirectory, 'metadata.json'), json(metadata), {flag: 'wx', mode: 0o600});
    return await verifySigningHandoff({
      handoffDir: outputDirectory,
      repoDir: discovered.repository,
      expectedBeforeSha: discovered.beforeSha,
      expectedHeadSha: discovered.headSha,
    });
  } catch (error) {
    await rm(outputDirectory, {recursive: true, force: true});
    throw error;
  }
}

function validateMetadataMission(mission, seen, previousMissionId) {
  if (!exactKeys(mission, ['mission_id', 'bundle_digest', 'asset_name', 'release_tag', 'tarball_sha256'])) {
    throw new SigningHandoffError('invalid mission metadata structure');
  }
  if (!MISSION_ID_PATTERN.test(mission.mission_id)) throw new SigningHandoffError('invalid mission identity in metadata');
  if (seen.has(mission.mission_id)) throw new SigningHandoffError(`duplicate mission identity in metadata: ${mission.mission_id}`);
  if (previousMissionId !== null && compareText(previousMissionId, mission.mission_id) >= 0) {
    throw new SigningHandoffError('mission metadata is not deterministically sorted');
  }
  if (!PREFIXED_SHA256_PATTERN.test(mission.bundle_digest)) throw new SigningHandoffError('invalid bundle digest in metadata');
  const prefix = mission.bundle_digest.slice('sha256:'.length, 'sha256:'.length + 12);
  const expectedAsset = `run-record-${mission.mission_id}-${prefix}.tar.gz`;
  const expectedTag = `run-record-${mission.mission_id}-${prefix}`;
  if (mission.asset_name !== expectedAsset) throw new SigningHandoffError(`asset name is not digest-bound for ${mission.mission_id}`);
  if (mission.release_tag !== expectedTag) throw new SigningHandoffError(`release tag is not digest-bound for ${mission.mission_id}`);
  if (!PREFIXED_SHA256_PATTERN.test(mission.tarball_sha256)) throw new SigningHandoffError(`invalid tarball SHA-256 for ${mission.mission_id}`);
  seen.add(mission.mission_id);
}

function equalSets(actual, expected) {
  if (actual.size !== expected.size) return false;
  for (const item of actual) if (!expected.has(item)) return false;
  return true;
}

/**
 * Verify the trusted range, strict metadata, exact artifact set, and every subject byte.
 */
export async function verifySigningHandoff({handoffDir, repoDir, expectedBeforeSha, expectedHeadSha}) {
  if (typeof handoffDir !== 'string' || handoffDir.length === 0) throw new SigningHandoffError('handoff directory is required');
  if (typeof repoDir !== 'string' || repoDir.length === 0) throw new SigningHandoffError('repository directory is required');
  validateRevision(expectedBeforeSha, 'expected before');
  validateRevision(expectedHeadSha, 'expected head');
  const handoffStats = await lstat(handoffDir).catch(() => null);
  if (!handoffStats?.isDirectory() || handoffStats.isSymbolicLink()) {
    throw new SigningHandoffError('handoff path must be a real directory');
  }
  const metadata = await readJson(path.join(handoffDir, 'metadata.json'), 'handoff metadata');
  if (!exactKeys(metadata, ['schema_version', 'no_op', 'before_sha', 'head_sha', 'verifier', 'missions'])) {
    throw new SigningHandoffError('invalid handoff metadata structure');
  }
  if (metadata.schema_version !== 3) throw new SigningHandoffError('unsupported handoff metadata schema');
  if (typeof metadata.no_op !== 'boolean') throw new SigningHandoffError('handoff no_op must be boolean');
  if (!SHA_PATTERN.test(metadata.before_sha)) throw new SigningHandoffError('invalid before SHA in handoff metadata');
  if (!SHA_PATTERN.test(metadata.head_sha)) throw new SigningHandoffError('invalid head SHA in handoff metadata');
  if (metadata.before_sha !== expectedBeforeSha) {
    throw new SigningHandoffError('handoff before SHA does not match the expected before SHA');
  }
  if (metadata.head_sha !== expectedHeadSha) throw new SigningHandoffError('handoff head SHA does not match the expected head SHA');
  const discovered = await discoverChangedMissions({
    repoDir,
    beforeSha: expectedBeforeSha,
    headSha: expectedHeadSha,
    requireCheckedOutHead: false,
  });
  if (!exactKeys(metadata.verifier, VERIFIER_FILES)) throw new SigningHandoffError('invalid verifier metadata structure');
  for (const relativePath of VERIFIER_FILES) {
    if (!PREFIXED_SHA256_PATTERN.test(metadata.verifier[relativePath])) {
      throw new SigningHandoffError(`invalid verifier SHA-256 for ${relativePath}`);
    }
  }
  if (!Array.isArray(metadata.missions)) throw new SigningHandoffError('handoff missions must be an array');
  if (metadata.missions.length > MAX_SIGNING_MISSIONS) {
    throw new SigningHandoffError(`a signing handoff supports at most ${MAX_SIGNING_MISSIONS} changed missions`);
  }
  if (metadata.no_op !== (metadata.missions.length === 0)) {
    throw new SigningHandoffError('handoff no_op does not match its mission set');
  }

  const seen = new Set();
  let previousMissionId = null;
  for (const mission of metadata.missions) {
    validateMetadataMission(mission, seen, previousMissionId);
    previousMissionId = mission.mission_id;
  }
  if (
    metadata.missions.length !== discovered.missions.length
    || metadata.missions.some((mission, index) => mission.mission_id !== discovered.missions[index])
  ) {
    throw new SigningHandoffError('handoff changed mission set does not match the trusted Git range');
  }

  const entries = await walkRegularTree(handoffDir);
  const actualFiles = new Set(entries.filter(({kind}) => kind === 'file').map(({path: entryPath}) => entryPath));
  const actualDirectories = new Set(entries.filter(({kind}) => kind === 'directory').map(({path: entryPath}) => entryPath));
  const expectedFiles = new Set([
    'metadata.json',
    ...VERIFIER_FILES.map((relativePath) => `verifier/${relativePath}`),
    ...metadata.missions.map(({asset_name: assetName}) => assetName),
  ]);
  const expectedDirectories = new Set(['verifier', 'verifier/bin', 'verifier/lib']);
  if (!equalSets(actualFiles, expectedFiles) || !equalSets(actualDirectories, expectedDirectories)) {
    throw new SigningHandoffError('handoff artifact set does not exactly match metadata');
  }

  for (const relativePath of VERIFIER_FILES) {
    const actual = `sha256:${await sha256File(path.join(handoffDir, 'verifier', ...relativePath.split('/')))}`;
    if (actual !== metadata.verifier[relativePath]) throw new SigningHandoffError(`verifier SHA-256 mismatch for ${relativePath}`);
  }
  for (const mission of metadata.missions) {
    const expectedBundle = await loadHeadBundle(discovered.repository, discovered.headSha, mission.mission_id);
    if (expectedBundle.bundleDigest !== mission.bundle_digest) {
      throw new SigningHandoffError(`metadata bundle digest does not match the head Git tree for ${mission.mission_id}`);
    }
    await verifyMissionArchive({handoffDir, mission, expectedBundle});
  }
  return metadata;
}
