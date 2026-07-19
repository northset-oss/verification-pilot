import {createHash} from 'node:crypto';

const GITHUB_API = 'https://api.github.com';
const CHANGE_STATUSES = new Set(['changed', 'new', 'removed']);

function contentUrl(repo, path) {
  const encodedRepo = repo.split('/').map(encodeURIComponent).join('/');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_API}/repos/${encodedRepo}/contents/${encodedPath}`;
}

async function warningReason(response) {
  let message = response.statusText || 'request failed';

  try {
    const body = await response.json();
    if (typeof body?.message === 'string' && body.message.length > 0) {
      message = body.message;
    }
  } catch {
    // A non-JSON error body still has a useful HTTP status and status text.
  }

  if (response.status === 403) {
    return `HTTP 403 rate limit or access warning: ${message}`;
  }
  return `HTTP ${response.status}: ${message}`;
}

/**
 * Compare two maps of policy-file keys to Git blob SHAs.
 */
export function diffPolicyState(previousFiles, nextFiles) {
  const results = [];
  const keys = new Set([
    ...Object.keys(previousFiles),
    ...Object.keys(nextFiles),
  ]);

  for (const key of keys) {
    const hadPrevious = Object.hasOwn(previousFiles, key);
    const hasNext = Object.hasOwn(nextFiles, key);

    if (!hadPrevious) {
      results.push({ key, status: 'new', sha: nextFiles[key] });
    } else if (!hasNext) {
      results.push({ key, status: 'removed', previousSha: previousFiles[key] });
    } else if (previousFiles[key] === nextFiles[key]) {
      results.push({
        key,
        status: 'unchanged',
        previousSha: previousFiles[key],
        sha: nextFiles[key],
      });
    } else {
      results.push({
        key,
        status: 'changed',
        previousSha: previousFiles[key],
        sha: nextFiles[key],
      });
    }
  }

  return results;
}

/**
 * Fetch candidate policy files and compare their Git blob SHAs with a snapshot.
 */
export async function checkTargets({
  targets,
  state,
  fetchImpl = globalThis.fetch,
  token,
}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'northset-policy-monitor',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const requests = targets.flatMap(({ repo, paths }) =>
    paths.map(async (path) => {
      const key = `${repo}:${path}`;

      try {
        const response = await fetchImpl(contentUrl(repo, path), { headers });
        if (response.status === 404) return { key, kind: 'missing' };
        if (response.status !== 200) {
          return {
            key,
            kind: 'warning',
            reason: await warningReason(response),
          };
        }

        const body = await response.json();
        if (typeof body?.sha !== 'string' || body.sha.length === 0) {
          return {
            key,
            kind: 'warning',
            reason: 'HTTP 200 response did not contain a blob SHA',
          };
        }
        return { key, kind: 'file', sha: body.sha };
      } catch (error) {
        return {
          key,
          kind: 'warning',
          reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  );

  const observations = await Promise.all(requests);
  const files = {};
  const warnings = [];

  for (const observation of observations) {
    if (observation.kind === 'file') {
      files[observation.key] = observation.sha;
    } else if (observation.kind === 'warning') {
      warnings.push({
        key: observation.key,
        status: 'warning',
        reason: observation.reason,
      });
    }
  }

  // A warning means the file's current state is unknown, not that it is gone. Only a real
  // 404 may report "removed" — a tracked file keeps its previous SHA through transient
  // API failures so the weekly signal never cries removal on a GitHub hiccup.
  for (const warning of warnings) {
    if (Object.hasOwn(state.files, warning.key) && !Object.hasOwn(files, warning.key)) {
      files[warning.key] = state.files[warning.key];
    }
  }

  const diff = diffPolicyState(state.files, files);
  return {
    results: [...diff, ...warnings],
    nextState: { version: '0', files },
    changed: diff.some(({ status }) => CHANGE_STATUSES.has(status)),
  };
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * Snapshot policy documents that are not addressable as GitHub repository blobs.
 * These requests are deliberately unauthenticated so GitHub credentials never leave api.github.com.
 */
export async function checkDocumentTargets({
  documents,
  state = {documents: {}},
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
}) {
  const previous = state.documents ?? {};
  const results = [];
  const nextDocuments = {};
  const requested = new Set();

  for (const document of documents) {
    if (!document || typeof document.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(document.id) ||
        typeof document.url !== 'string') {
      throw new Error('document targets require a stable lowercase id and URL');
    }
    const parsed = new URL(document.url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'docs.github.com') {
      throw new Error(`document target ${document.id} must use https://docs.github.com`);
    }
    if (requested.has(document.id)) throw new Error(`duplicate document target id: ${document.id}`);
    requested.add(document.id);
    const fetchedAt = now().toISOString();
    try {
      const response = await fetchImpl(document.url, {
        // docs.github.com serves a stable Markdown representation for this media type. Hashing
        // rendered HTML would turn site-shell deployments into false policy-change alerts.
        headers: {Accept: 'text/markdown', 'User-Agent': 'northset-policy-monitor'},
      });
      if (response.status !== 200) {
        results.push({key: `document:${document.id}`, id: document.id, url: document.url,
          status: 'warning', disposition: 'warning', fetched_at: fetchedAt,
          reason: `HTTP ${response.status}: ${response.statusText || 'request failed'}`});
        if (previous[document.id]) nextDocuments[document.id] = previous[document.id];
        continue;
      }
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!/^text\/markdown(?:;|$)/i.test(contentType)) {
        results.push({key: `document:${document.id}`, id: document.id, url: document.url,
          status: 'warning', disposition: 'warning', fetched_at: fetchedAt,
          reason: `unexpected content type: ${contentType || 'missing'}`});
        if (previous[document.id]) nextDocuments[document.id] = previous[document.id];
        continue;
      }
      const bytes = response.arrayBuffer
        ? Buffer.from(await response.arrayBuffer())
        : Buffer.from(await response.text(), 'utf8');
      const digest = sha256(bytes);
      const previousDigest = previous[document.id]?.digest ?? null;
      const disposition = previousDigest === null ? 'new' : previousDigest === digest ? 'unchanged' : 'changed';
      const record = {url: document.url, fetched_at: fetchedAt, digest, previous_digest: previousDigest, disposition};
      nextDocuments[document.id] = record;
      results.push({key: `document:${document.id}`, id: document.id, ...record, status: disposition});
    } catch (error) {
      results.push({key: `document:${document.id}`, id: document.id, url: document.url,
        status: 'warning', disposition: 'warning', fetched_at: fetchedAt,
        reason: `request failed: ${error instanceof Error ? error.message : String(error)}`});
      if (previous[document.id]) nextDocuments[document.id] = previous[document.id];
    }
  }

  for (const [id, record] of Object.entries(previous)) {
    if (requested.has(id)) continue;
    results.push({key: `document:${id}`, id, url: record.url, status: 'removed', disposition: 'removed',
      fetched_at: now().toISOString(), digest: null, previous_digest: record.digest});
  }
  return {
    results,
    nextState: {documents: nextDocuments},
    changed: results.some(({status}) => CHANGE_STATUSES.has(status)),
  };
}
