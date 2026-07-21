#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditAllDisclosures,
  auditAllFactoryDisclosures,
  createFetchRequest,
  syncFactoryDisclosure,
  syncMissionDisclosure,
  validateDisclosurePolicy,
} from '../lib/pr-receipt-disclosure.mjs';

function parseArgs(args) {
  const command = args[0];
  if (!['check', 'sync'].includes(command)) {
    throw new Error(
      'usage: pr-receipt-disclosure.mjs <check|sync> --policy <file> '
      + '(--missions-dir <dir> | --factory-receipts-dir <dir> | --mission-dir <dir>) [--json] '
      + '[--mission <M-XXX>] [--apply --confirm-pr-url <url> --now <ISO-time>]',
    );
  }
  const options = { command, apply: false, json: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (['--policy', '--missions-dir', '--factory-receipts-dir', '--mission-dir', '--mission', '--confirm-pr-url', '--now'].includes(arg)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2).replaceAll('-', '_')] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.policy) throw new Error('--policy is required');
  if (command === 'check') {
    const auditDirectories = [options.missions_dir, options.factory_receipts_dir].filter(Boolean);
    if (auditDirectories.length !== 1) {
      throw new Error('check requires exactly one of --missions-dir or --factory-receipts-dir');
    }
    if (options.mission_dir || options.mission || options.apply || options.confirm_pr_url || options.now) {
      throw new Error('check accepts one audit directory, --policy, and --json only');
    }
  } else {
    const missionsMode = Boolean(options.mission_dir);
    const factoryMode = Boolean(options.factory_receipts_dir || options.mission);
    if (missionsMode === factoryMode) {
      throw new Error('sync requires --mission-dir or both --factory-receipts-dir and --mission');
    }
    if (factoryMode && (!options.factory_receipts_dir || !options.mission)) {
      throw new Error('factory sync requires both --factory-receipts-dir and --mission');
    }
    if (options.missions_dir) {
      throw new Error('sync does not accept --missions-dir');
    }
    if (missionsMode && options.mission) {
      throw new Error('missions sync does not accept --mission');
    }
    if (factoryMode && options.now) {
      throw new Error('factory sync does not accept --now because it writes no receipt state');
    }
    if (!options.apply && (options.confirm_pr_url || options.now)) {
      throw new Error('--confirm-pr-url and --now require --apply');
    }
    if (options.apply && !options.confirm_pr_url) {
      throw new Error('--apply requires --confirm-pr-url');
    }
  }
  return options;
}

async function readPolicy(file) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read policy ${file}: ${error.message}`);
  }
  return validateDisclosurePolicy(value);
}

function localGhToken() {
  const result = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function formatReport(report) {
  if (report.lane === 'factory_receipts') {
    return `Factory PR receipt disclosure: ${report.checked} verified, ${report.merged_sync_pending} merged sync pending, ${report.block_v1} block v1, ${report.block_v2} block v2`;
  }
  if (Object.hasOwn(report, 'checked')) {
    return `PR receipt disclosure: ${report.checked} verified, ${report.historical_exempt} historical exempt, ${report.prepared} prepared`;
  }
  return `PR receipt disclosure: ${report.mission_id} ${report.status}${report.changed === undefined ? '' : `, changed=${report.changed}`}`;
}

export async function runPrReceiptDisclosureCli({
  args = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const options = parseArgs(args);
    const policy = await readPolicy(path.resolve(options.policy));
    let token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
    if (options.command === 'sync' && options.apply && !token) token = localGhToken();
    if (options.command === 'sync' && options.apply && !token) {
      throw new Error('--apply requires GITHUB_TOKEN, GH_TOKEN, or an authenticated gh session');
    }
    const request = createFetchRequest({ fetchImpl, token });
    const report = options.command === 'check'
      ? options.factory_receipts_dir
        ? await auditAllFactoryDisclosures({
          factoryReceiptsDir: path.resolve(options.factory_receipts_dir),
          policy,
          request,
        })
        : await auditAllDisclosures({
          missionsDir: path.resolve(options.missions_dir),
          policy,
          request,
        })
      : options.factory_receipts_dir
        ? await syncFactoryDisclosure({
          factoryReceiptsDir: path.resolve(options.factory_receipts_dir),
          missionId: options.mission,
          policy,
          request,
          apply: options.apply,
          confirmPrUrl: options.confirm_pr_url ?? null,
        })
        : await syncMissionDisclosure({
          missionDir: path.resolve(options.mission_dir),
          policy,
          request,
          apply: options.apply,
          confirmPrUrl: options.confirm_pr_url ?? null,
          now: options.now,
        });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`pr-receipt-disclosure: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function isDirectInvocation() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectInvocation()) process.exitCode = await runPrReceiptDisclosureCli();
