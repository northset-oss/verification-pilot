function requiredCommands(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  return value;
}

export function assertProofOfPass(mission, runRecord) {
  const declared = requiredCommands(mission?.commands_declared, 'mission.json:commands_declared');
  const commands = requiredCommands(runRecord?.commands, 'bundle/run_record.json:commands');
  for (const [index, command] of commands.entries()) {
    const label = `bundle/run_record.json:commands[${index}]`;
    if (typeof command !== 'object' || command === null || Array.isArray(command)) {
      throw new TypeError(`RUN_RECORD_TYPE ${label}: must be an object`);
    }
    if (typeof command.cmd !== 'string' || command.cmd.length === 0) {
      throw new TypeError(`RUN_RECORD_TYPE ${label}.cmd: must be a non-blank string`);
    }
    if (command.exit_code !== null && !Number.isInteger(command.exit_code)) {
      throw new TypeError(`RUN_RECORD_TYPE ${label}.exit_code: must be an integer or null`);
    }
    if (command.timed_out !== undefined && typeof command.timed_out !== 'boolean') {
      throw new TypeError(`RUN_RECORD_TYPE ${label}.timed_out: must be a boolean when present`);
    }
    if ((command.exit_code === null) !== (command.timed_out === true)) {
      throw new TypeError(`RUN_RECORD_TIMEOUT_INVARIANT ${label}: exit_code must be null if and only if timed_out is true`);
    }
  }
  if (declared.length !== commands.length || declared.some((command, index) => command !== commands[index]?.cmd)) {
    throw new TypeError('mission.json:commands_declared must match bundle/run_record.json:commands one-to-one and byte-for-byte');
  }
  const failures = commands.filter((command) => command?.exit_code !== 0 || command?.timed_out === true);
  if (failures.length > 0) {
    const details = failures.map((command) => (
      `"${command?.cmd ?? '(missing command)'}" ${command?.timed_out === true ? 'timed out' : `exited ${command?.exit_code}`}`
    )).join('; ');
    throw new TypeError(`NOT_PROOF_OF_PASS: proof-of-pass requires every declared command to return exit 0 without timing out; ${details}`);
  }
  return { passedCommands: commands.length, declaredCommands: declared.length };
}
