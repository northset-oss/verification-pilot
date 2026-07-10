# Two-phase Docker executor

Run a command declaration against an untrusted repository copy:

```sh
node bin/execute.mjs run config.json --out run-output
```

Pass `--now <ISO-8601-date-time>` to make both run-record timestamps deterministic,
and pass `--json` for machine-readable CLI output.

The config file rejects unknown top-level keys and has this shape:

```json
{
  "image": "node:20-bookworm",
  "repo_dir": "/absolute/path/to/checkout",
  "patch_file": null,
  "install_commands": [
    "corepack enable",
    "pnpm install --frozen-lockfile"
  ],
  "commands": [
    "pnpm test"
  ],
  "limits": {
    "cpus": 2,
    "memory_mb": 4096,
    "pids": 512,
    "wall_clock_seconds_per_command": 1800,
    "output_bytes_per_stream": 2000000
  }
}
```

The executor copies `repo_dir` to a temporary workspace before invoking Docker. If
`patch_file` is set, it is copied into that workspace and applied there with `git apply`.
The original repository and patch paths are never mounted in a container.

Phase A uses Docker's default bridge network to run the install commands. Because both
phases share the copied `/workspace` bind mount, project-local dependencies written there
remain available after phase A exits. Phase B starts one ephemeral container from the
configured image for each declared command, in order, with `--network=none`. A nonzero exit
does not stop later commands.

Every phase-A and phase-B container uses the following posture:

- user `1000:1000`
- all capabilities dropped and `no-new-privileges`
- configured CPU, memory, and PID limits
- a read-only root filesystem and a writable `/tmp` tmpfs capped at 512 MiB
- only the temporary workspace bind-mounted writable at `/workspace`
- only fixed `PATH`, `HOME`, and `CI` container environment values

The executor measures the copied workspace after phase A and after each phase-B command,
without following symlinks, and stops if its files exceed 2 GiB. Each phase run is terminated
after `wall_clock_seconds_per_command`; on timeout the executor force-stops the named container
with `docker kill` and sends the Docker client `SIGTERM`, followed by `SIGKILL` after a
ten-second grace period if needed. Phase-B timeout records use `"exit_code": null` with
`"timed_out": true`.

The output directory contains `run_record.json`, `stdout.txt`, and `stderr.txt`. Each stream
uses `=== cmd N: <cmd> ===` section headers. Per-command streams longer than
`output_bytes_per_stream` are cut at the byte limit and receive a `[TRUNCATED]` marker.
Output is intentionally not redacted; the bundle step owns redaction.

After phase A makes the configured image available, the executor resolves it with
`docker image inspect` before starting phase B. The run record keeps the exact configured
string as `container_image_ref` and records the first repository content digest as
`container_image_digest`. For a locally built image with no repository digest, it records the
image's `sha256:...` ID instead. If neither value can be resolved, execution fails closed and
no run record is written. The environment also reports the literal network policy
`phaseA:bridge,phaseB:none`.

The executor always attempts to remove phase containers and removes its temporary workspace
in a `finally` block.

## Isolation ceiling and accepted residuals

This is a hardened stock-Docker sandbox (non-root, all caps dropped, `no-new-privileges`,
read-only root, default seccomp, no Docker socket), adequate for semi-trusted, maintainer-
consented code on known repositories. It is **not** a guarantee against an attacker running a
kernel local-privilege-escalation exploit; it uses no user-namespace remap, gVisor, or Kata.
Two reviews found no host-escape path in the container posture. Known, accepted residuals for
the pilot: phase A runs install/lifecycle scripts **with network** (inherent to dependency
fetch — the accepted exfiltration surface; the container carries no secrets and only the public
repo copy); the Docker **client** process inherits the operator's host environment (operator-
controlled — run it in a clean shell without `DOCKER_HOST`/secret env); and sequential phase-B
commands share one workspace, so a run record attests only *what ran*, never test honesty or
code quality (see the Claims Boundary).
