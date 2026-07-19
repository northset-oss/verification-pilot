#!/usr/bin/env node

import {appendFile} from 'node:fs/promises';

import {
  createSigningHandoff,
  SigningHandoffError,
  verifySigningHandoff,
} from '../lib/signing-handoff.mjs';

function usage() {
  return [
    'Usage:',
    '  signing-handoff.mjs create --repo DIR --before SHA --head SHA --out DIR',
    '  signing-handoff.mjs verify --handoff DIR --repo DIR --expected-before SHA --expected-head SHA [--github-output FILE]',
  ].join('\n');
}

function parseFlags(args, allowed) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--')) {
      throw new SigningHandoffError(`invalid CLI arguments\n${usage()}`);
    }
    if (Object.hasOwn(values, flag)) throw new SigningHandoffError(`duplicate CLI flag: ${flag}`);
    values[flag] = value;
  }
  return values;
}

function requireFlags(values, required) {
  for (const flag of required) {
    if (!Object.hasOwn(values, flag)) throw new SigningHandoffError(`missing required CLI flag: ${flag}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === 'create') {
    const values = parseFlags(args, new Set(['--repo', '--before', '--head', '--out']));
    requireFlags(values, ['--repo', '--before', '--head', '--out']);
    const metadata = await createSigningHandoff({
      repoDir: values['--repo'],
      beforeSha: values['--before'],
      headSha: values['--head'],
      outDir: values['--out'],
    });
    process.stdout.write(`${JSON.stringify({no_op: metadata.no_op, mission_count: metadata.missions.length})}\n`);
    return;
  }
  if (command === 'verify') {
    const values = parseFlags(args, new Set([
      '--handoff',
      '--repo',
      '--expected-before',
      '--expected-head',
      '--github-output',
    ]));
    requireFlags(values, ['--handoff', '--repo', '--expected-before', '--expected-head']);
    const metadata = await verifySigningHandoff({
      handoffDir: values['--handoff'],
      repoDir: values['--repo'],
      expectedBeforeSha: values['--expected-before'],
      expectedHeadSha: values['--expected-head'],
    });
    if (values['--github-output'] !== undefined) {
      await appendFile(
        values['--github-output'],
        `no_op=${metadata.no_op}\nmission_count=${metadata.missions.length}\n`,
      );
    }
    process.stdout.write(`${JSON.stringify({no_op: metadata.no_op, mission_count: metadata.missions.length})}\n`);
    return;
  }
  throw new SigningHandoffError(`unknown command: ${command ?? ''}\n${usage()}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`signing-handoff: ${message}\n`);
  process.exitCode = 1;
});
