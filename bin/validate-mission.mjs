#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { validateMission } from '../lib/mission-validator.mjs';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const files = args.filter((arg) => arg !== '--json');

function cliError(file, ruleId, message) {
  return { file, valid: false, errors: [{ ruleId, path: '$', message }] };
}

async function validateFile(file) {
  let source;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    return cliError(file, 'CLI_READ', `cannot read file: ${error.message}`);
  }

  let receipt;
  try {
    receipt = JSON.parse(source);
  } catch (error) {
    return cliError(file, 'JSON_PARSE', `invalid JSON: ${error.message}`);
  }

  const result = validateMission(receipt);
  return { file, ...result };
}

let results;
if (files.length === 0) {
  results = [cliError('<cli>', 'CLI_USAGE', 'usage: validate-mission.mjs [--json] <file> [<file> ...]')];
} else {
  results = await Promise.all(files.map(validateFile));
}

const valid = results.every((result) => result.valid);

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({ valid, files: results }, null, 2)}\n`);
} else {
  for (const result of results) {
    for (const error of result.errors) {
      const location = error.path === '$' ? '' : `${error.path}: `;
      process.stderr.write(`${result.file}: ${error.ruleId}: ${location}${error.message}\n`);
    }
  }
}

process.exitCode = valid ? 0 : 1;
