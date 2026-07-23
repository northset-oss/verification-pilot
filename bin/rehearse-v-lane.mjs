#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildLedger, renderLedger } from '../lib/ledger.mjs';
import { runPipeline } from '../lib/pipeline.mjs';

const execFile = promisify(execFileCallback);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const missionsDir = path.join(repositoryRoot, 'missions');
const missionDir = path.join(missionsDir, 'M-004');
const imageReference = process.env.NORTHSET_REHEARSAL_IMAGE ?? 'node:20-bookworm';

async function run(command, arguments_, options = {}) {
  return execFile(command, arguments_, { maxBuffer: 1024 * 1024, ...options });
}

async function imageDigest() {
  const inspect = async () => run('docker', [
    'image', 'inspect', imageReference, '--format', '{{json .RepoDigests}}',
  ]);
  let result;
  try {
    result = await inspect();
  } catch {
    await run('docker', ['pull', imageReference]);
    result = await inspect();
  }
  const digests = JSON.parse(result.stdout.trim());
  const digest = Array.isArray(digests)
    ? digests.find((value) => typeof value === 'string' && /@sha256:[0-9a-f]{64}$/i.test(value))
    : null;
  if (digest === null || digest === undefined) {
    throw new Error(`Docker did not report an immutable repository digest for ${imageReference}`);
  }
  return digest;
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'northset-v-rehearsal-'));
  const checkout = path.join(temporaryRoot, 'checkout');
  const missionBackup = path.join(temporaryRoot, 'M-004');
  const indexBackup = path.join(temporaryRoot, 'index.json');
  let backupReady = false;
  let completed = false;
  try {
    await cp(missionDir, missionBackup, { recursive: true });
    await cp(path.join(missionsDir, 'index.json'), indexBackup);
    backupReady = true;
    const mission = JSON.parse(await readFile(path.join(missionDir, 'mission.json'), 'utf8'));
    const digest = await imageDigest();
    const preparedMission = {
      ...mission,
      worker_identity: {
        runtime: 'northset-oss production Docker executor v1',
        human_operator: 'Northset',
      },
      environment: {
        container_image_digest: digest,
        network_policy: 'phaseA:bridge,phaseB:none',
      },
      run_record_bundle_digest: null,
      attestation_uri: null,
      limitations: [
        'REHEARSAL — NOT EXTERNAL VALIDATION.',
        "Self-authorized on Northset's own repository; not a real external maintainer request or external maintainer verification.",
        'Executed through the production Docker executor path. This local rehearsal does not establish that the foreign-code deployment preconditions are satisfied on a production host.',
        'The recorded patch stands in for a small Northset-authored pull request change; no pull request was opened.',
        'Does not prove code quality',
        'Does not prove security',
      ],
    };

    await run('git', ['clone', '--quiet', '--no-checkout', repositoryRoot, checkout]);
    await run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', preparedMission.base_commit]);

    const result = await runPipeline({
      mission: preparedMission,
      repo_dir: checkout,
      patch_file: path.join(missionDir, 'patch.diff'),
      consent_file: path.join(missionDir, 'consent.json'),
      issue_snapshot_file: null,
      ci_links_file: null,
      executor: {
        profile: 'node',
        image: digest,
        install_commands: [],
        commands: [...preparedMission.commands_declared],
        limits: {
          cpus: 1,
          memory_mb: 1024,
          pids: 128,
          wall_clock_seconds_per_command: 120,
          output_bytes_per_stream: 1024 * 1024,
        },
        workspace_mode: 'readonly',
        workspace_write_allowlist: [],
      },
    }, {
      missionsDir,
      force: true,
      onWarning: (message) => process.stderr.write(`warning: ${message}\n`),
    });

    const publication = {
      schema_version: 1,
      mission_id: 'M-004',
      state: 'prepared',
      pr_number: null,
      pr_url: null,
      pr_head_oid: null,
      base_branch: null,
      head_drift: false,
      ci_state: null,
      merge_commit_oid: null,
      review_decision: null,
      decision_url: null,
      opened_at: null,
      closed_at: null,
      updated_at: null,
      observed_at: null,
      correction_note: 'The original consent scope described this as an unpublished sample. It is now publicly visible as the sample receipt. This correction does not alter the immutable run evidence; no external maintainer requested the run, no pull request was opened, and no attestation was issued.',
      scope_note: "Self-authorized V-lane rehearsal on Northset's own repository, executed through the production Docker executor path; not a real external maintainer request. No pull request was opened. The prepared rehearsal receipt is publicly visible as the sample receipt, unsigned and unattested; publication is not external validation.",
      attestation_uri: null,
      bundle_digest: result.bundleDigest,
      release_asset_sha256: null,
      attestation_verified_at: null,
    };
    await writeFile(
      path.join(missionDir, 'publication.json'),
      `${JSON.stringify(publication, null, 2)}\n`,
    );

    const generatedAt = new Date().toISOString();
    await buildLedger({
      missionsDir,
      out: path.join(missionsDir, 'index.json'),
      now: generatedAt,
    });
    await renderLedger({
      indexPath: path.join(missionsDir, 'index.json'),
      out: path.join(repositoryRoot, 'site', 'index.html'),
      now: generatedAt,
    });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      mission_id: 'M-004',
      image: digest,
      bundle_digest: result.bundleDigest,
      publication_state: 'prepared',
      public_receipt_already_visible: true,
      remote_publication_performed: false,
      attested: false,
    }, null, 2)}\n`);
    completed = true;
  } finally {
    if (!completed && backupReady) {
      await rm(missionDir, { recursive: true, force: true });
      await cp(missionBackup, missionDir, { recursive: true });
      await cp(indexBackup, path.join(missionsDir, 'index.json'));
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`rehearse-v-lane: ${error.message}\n`);
  process.exitCode = 1;
});
