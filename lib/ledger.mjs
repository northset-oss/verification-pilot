import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { validateMission } from './mission-validator.mjs';

const PROJECTION_FIELDS = [
  'mission_id',
  'variant',
  'claims_tier',
  'grade',
  'target_repo',
  'issue_or_task',
  'consent_artifact',
  'maintainer_outcome',
  'run_record_bundle_digest',
  'attestation_uri',
  'disclosure_label',
];

function compareMissionIds(left, right) {
  if (left.mission_id < right.mission_id) return -1;
  if (left.mission_id > right.mission_id) return 1;
  return 0;
}

function projectMission(receipt) {
  const entry = {};
  for (const field of PROJECTION_FIELDS) {
    if (field === 'maintainer_outcome') {
      entry.maintainer_outcome = {
        status: receipt.maintainer_outcome.status,
        link: receipt.maintainer_outcome.link,
      };
    } else if (Object.hasOwn(receipt, field)) {
      entry[field] = receipt[field];
    }
  }
  entry.attested = typeof receipt.attestation_uri === 'string';
  return entry;
}

function formatValidationErrors(errors) {
  return errors
    .map((error) => `${error.ruleId} ${error.path}: ${error.message}`)
    .join('; ')
    .replaceAll(/\s+/g, ' ');
}

async function writeOutput(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, 'utf8');
}

/**
 * Build and write a deterministic public ledger index.
 *
 * @param {{missionsDir: string, out: string, now?: string|null, onWarning?: (message: string) => void}} options
 * @returns {Promise<{included: number, skipped: number, index: object}>}
 */
export async function buildLedger({ missionsDir, out, now = null, onWarning = () => {} }) {
  const directoryEntries = await readdir(missionsDir, { withFileTypes: true });
  const missionFiles = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(missionsDir, entry.name, 'mission.json'))
    .sort();

  const missions = [];
  let skipped = 0;

  for (const missionFile of missionFiles) {
    let receipt;
    try {
      receipt = JSON.parse(await readFile(missionFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${error.message}`);
      continue;
    }

    const validation = validateMission(receipt);
    if (!validation.valid) {
      skipped += 1;
      onWarning(`skipping ${missionFile}: ${formatValidationErrors(validation.errors)}`);
      continue;
    }

    missions.push(projectMission(receipt));
  }

  missions.sort(compareMissionIds);
  const index = {
    version: '0',
    generated_at: now,
    missions,
  };
  await writeOutput(out, `${JSON.stringify(index, null, 2)}\n`);

  return { included: missions.length, skipped, index };
}

function serializeForInlineScript(value) {
  return JSON.stringify(value, null, 2)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function renderHtml(index) {
  const serializedIndex = serializeForInlineScript(index);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Northset OSS Run Records</title>
  <style>
    :root {
      color-scheme: light dark;
      --background: #ffffff;
      --foreground: #17202a;
      --muted: #56616d;
      --border: #c9d1d9;
      --surface: #f6f8fa;
      --link: #0757a6;
    }

    * {
      box-sizing: border-box;
    }

    html,
    body {
      max-width: 100%;
      overflow-x: hidden;
    }

    body {
      margin: 0;
      background: var(--background);
      color: var(--foreground);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
    }

    main {
      width: min(72rem, 100%);
      margin: 0 auto;
      padding: 2rem 1rem;
    }

    h1 {
      margin: 0 0 0.75rem;
      font-size: clamp(1.75rem, 5vw, 2.5rem);
      line-height: 1.15;
    }

    .lede {
      max-width: 70rem;
      margin: 0 0 1.5rem;
      color: var(--muted);
    }

    .table-wrap {
      max-width: 100%;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
    }

    table {
      width: 100%;
      min-width: 50rem;
      border-collapse: collapse;
      background: var(--background);
    }

    th,
    td {
      padding: 0.75rem;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }

    th {
      background: var(--surface);
      font-weight: 650;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    a {
      color: var(--link);
      overflow-wrap: anywhere;
    }

    code {
      display: inline-block;
      margin-top: 0.35rem;
      padding: 0.12rem 0.3rem;
      border-radius: 0.25rem;
      background: var(--surface);
      color: var(--foreground);
      white-space: nowrap;
    }

    footer {
      margin-top: 1.5rem;
      color: var(--muted);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --background: #101419;
        --foreground: #edf1f5;
        --muted: #b3bdc7;
        --border: #46515c;
        --surface: #1b2229;
        --link: #79b8ff;
      }
    }
  </style>
</head>
<body>
  <main>
    <h1>Northset OSS Run Records</h1>
    <p class="lede">A run record is evidence of declared execution metadata and artifacts. It is not proof of code quality, security, maintainer approval, or production readiness.</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Mission</th>
            <th scope="col">Repo</th>
            <th scope="col">Variant</th>
            <th scope="col">Tier</th>
            <th scope="col">Outcome</th>
            <th scope="col">Attested</th>
          </tr>
        </thead>
        <tbody id="ledger-rows"></tbody>
      </table>
    </div>
    <footer>Self-funded field-testing. The reported signal is the external maintainer decision, which Northset does not control.</footer>
  </main>
  <script type="application/json" id="ledger-data">${serializedIndex}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById('ledger-data').textContent);
      const rows = document.getElementById('ledger-rows');

      function textCell(value) {
        const cell = document.createElement('td');
        cell.textContent = value ?? '';
        return cell;
      }

      function link(value, label) {
        const anchor = document.createElement('a');
        anchor.setAttribute('href', value);
        anchor.textContent = label;
        return anchor;
      }

      for (const mission of data.missions) {
        const row = document.createElement('tr');
        row.append(textCell(mission.mission_id));

        const repo = document.createElement('td');
        repo.append(link(mission.target_repo, mission.target_repo));
        row.append(repo);

        row.append(textCell(mission.variant));
        row.append(textCell(Array.isArray(mission.claims_tier) ? mission.claims_tier.join(', ') : ''));

        const outcome = document.createElement('td');
        const status = mission.maintainer_outcome.status;
        if (mission.maintainer_outcome.link) {
          outcome.append(link(mission.maintainer_outcome.link, status));
        } else {
          outcome.textContent = status;
        }
        row.append(outcome);

        const attested = document.createElement('td');
        if (mission.attested) {
          attested.append(link(mission.attestation_uri, 'Yes'), document.createElement('br'));
          const hint = document.createElement('code');
          hint.textContent = 'gh attestation verify <bundle> --repo northset-oss/verification-pilot --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml';
          attested.append(hint);
        } else {
          attested.textContent = 'No';
        }
        row.append(attested);
        rows.append(row);
      }
    })();
  </script>
</body>
</html>
`;
}

/**
 * Render an index as a self-contained static HTML document.
 *
 * The optional now value is accepted by deterministic build invocations. The index's
 * generated_at remains the timestamp embedded in the rendered ledger data.
 *
 * @param {{indexPath: string, out: string, now?: string|null}} options
 * @returns {Promise<{missions: number}>}
 */
export async function renderLedger({ indexPath, out, now = null }) {
  if (now !== null && typeof now !== 'string') {
    throw new TypeError('now must be a string or null');
  }

  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  if (typeof index !== 'object' || index === null || !Array.isArray(index.missions)) {
    throw new TypeError('index must be an object with a missions array');
  }

  await writeOutput(out, renderHtml(index));
  return { missions: index.missions.length };
}
