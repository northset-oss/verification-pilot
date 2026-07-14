#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  auditAllDisclosures,
  createFetchRequest,
  syncMissionDisclosure,
  validateDisclosurePolicy,
} from '../lib/pr-receipt-disclosure.mjs';

function parseArgs(args) {
  const command = args[0];
  if (!['check', 'sync'].includes(command)) {
    throw new Error(
      'usage: pr-receipt-disclosure.mjs <check|sync> --policy <file> '
      + '(--missions-dir <dir> | --mission-dir <dir>) [--json] '
      + '[--apply --confirm-pr-url <url> --now <ISO-time>]',
    );
  }
  const options = { command, apply: false, json: false };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (['--policy', '--missions-dir', '--mission-dir', '--confirm-pr-url', '--now'].includes(arg)) {
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
    if (!options.missions_dir) throw new Error('--missions-dir is required for check');
    if (options.mission_dir || options.apply || options.confirm_pr_url || options.now) {
      throw new Error('check accepts --missions-dir, --policy, and --json only');
    }
  } else {
    if (!options.mission_dir) throw new Error('--mission-dir is required for sync');
    if (options.missions_dir) throw new Error('sync does not accept --missions-dir');
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
      ? await auditAllDisclosures({
        missionsDir: path.resolve(options.missions_dir),
        policy,
        request,
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
