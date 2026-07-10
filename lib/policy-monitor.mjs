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

  const diff = diffPolicyState(state.files, files);
  return {
    results: [...diff, ...warnings],
    nextState: { version: '0', files },
    changed: diff.some(({ status }) => CHANGE_STATUSES.has(status)),
  };
}
