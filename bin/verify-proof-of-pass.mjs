#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { assertProofOfPass } from '../lib/proof-of-pass.mjs';

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const missionDirectory = process.argv[2];
  if (!missionDirectory) {
    process.stderr.write('usage: verify-proof-of-pass.mjs <mission-dir>\n');
    process.exit(2);
  }
  const mission = await readJson(path.join(missionDirectory, 'mission.json'));
  const runRecord = await readJson(path.join(missionDirectory, 'bundle', 'run_record.json'));
  const result = assertProofOfPass(mission, runRecord);
  const noun = result.declaredCommands === 1 ? 'command' : 'commands';
  process.stdout.write(`OK ${mission.mission_id}: PASS — ${result.passedCommands}/${result.declaredCommands} declared ${noun}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
