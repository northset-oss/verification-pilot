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
  "profile": "node",
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
  "workspace_mode": "writable_copy",
  "workspace_write_allowlist": ["coverage"],
  "limits": {
    "cpus": 2,
    "memory_mb": 4096,
    "pids": 512,
    "wall_clock_seconds_per_command": 1800,
    "output_bytes_per_stream": 2000000,
    "workspace_file_count": 200000,
    "workspace_bytes": 2147483648
  }
}
```

`profile` is optional for backward compatibility and defaults to `node`. Supported public executor
profiles are `node` (project-local dependencies remain under the bind-mounted workspace) and
`python` (a workspace-local `.venv` is created during phase A). Unknown profiles fail closed. The
private Northset production lane enables a profile only after its executor behavior has a smoke
test; currently that lane is Node-only.

`workspace_mode` is optional and defaults to `readonly`, which bind-mounts the copied workspace
read-only during phase B. Checks that must emit artifacts can opt into `writable_copy` and name at
most 32 normalized relative paths in `workspace_write_allowlist`. Those paths are the only
untracked outputs allowed to differ after the declared checks; newly created symlinks and final
changes to tracked file bytes or modes always fail closed.

The executor validates the workspace manifest after every declared command, before starting the
next container. In `writable_copy`, only allowlisted artifacts may therefore cross from one command
to the next; a tracked change, mode change, unapproved path, or new symlink aborts the run before a
later command can consume and then hide it. This remains final-state evidence at each command
boundary: a command that restores bytes before it exits is not represented as a change.

The executor copies `repo_dir` to a temporary workspace before invoking Docker. If
`patch_file` is set, the host applies those exact hashed bytes with `git apply --index --binary`.
The original repository and patch paths are never mounted in a container. The executor records a
digest of every Git-tracked file after the patch, runs the networked install, then recomputes that
digest and fails before checks if install or lifecycle scripts changed tracked source. Dependencies
may be added only as untracked workspace content for the network-off check phase.

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
- the temporary workspace bind-mounted writable at `/workspace` during phase A, then read-only
  during phase B unless the configuration explicitly selects `writable_copy`
- the image entrypoint replaced by `/usr/bin/env -i`, so foreign commands start with only fixed
  `PATH`, `HOME`, `CI`, `COREPACK_HOME`, `NPM_CONFIG_CACHE`, `XDG_CACHE_HOME`, and
  `XDG_DATA_HOME` values (plus fixed profile values and non-secret variables synthesized by the
  shell itself), rather than image-declared or Docker-client proxy environment values

Before copying, the executor rejects a `repo_dir` symlink/non-directory and traverses the source
without following symlinks to enforce the configured byte and file-count caps. It rechecks the
copied tree immediately before Git inspection or Docker starts. The executor then monitors the
copied workspace every 250 ms during writable container phases and
rechecks it after each phase, without following symlinks. It stops the named container if the
workspace exceeds the configured byte or file-count cap (2 GiB and 200,000 entries by default).
The watchdog is not a filesystem quota, so a short burst can exceed a cap between samples before
the container is killed. Each phase run is terminated
after `wall_clock_seconds_per_command`; on timeout the executor force-stops the named container
with `docker kill` and sends the Docker client `SIGTERM`, followed by `SIGKILL` after a
ten-second grace period if needed. Phase-B timeout records use `"exit_code": null` with
`"timed_out": true`.

The output directory contains `run_record.json`, `stdout.txt`, and `stderr.txt`. Newly produced run
records use schema version 2 and add a strict `usage` object. `networked_setup_elapsed_ms` measures
the whole phase-A Docker interval; it is not relabeled as dependency-install time.
`dependency_install_ms`, CPU time, and peak RSS are `null` until directly measurable.
`declared_commands_ms` is the sum of the command durations already recorded below. Resource limits
remain enforcement configuration, not consumption measurements. Each stream
uses `=== cmd N: <cmd> ===` section headers. Per-command streams longer than
`output_bytes_per_stream` are cut at the byte limit and receive a `[TRUNCATED]` marker.
Output is intentionally not redacted; the bundle step owns redaction.

Before the patch touches the workspace, the executor records the starting code identity:
`source_commit` (via `git rev-parse HEAD` on the copied checkout — but **only when that checkout
is clean**: a dirty or untracked tree, a non-git tree, or a missing git binary all yield
`null`, because HEAD lies about a modified worktree), a `base_tree_digest` over the pre-patch
source (excluding `.git`; hashing symlink targets and mode bits), and `patch_sha256` of the
applied patch (hashed from the same bytes that are staged and applied — one read, no TOCTOU).
The `install_commands` are recorded too, because phase A runs them **with network** and they can
change the tree before the declared checks run — they are disclosed, not hidden setup. The
pipeline binds `source_commit`/`patch_sha256` against the receipt's declared
`base_commit`/`patch_diff_hash` (both directions: a declared value must match, and an applied
patch must be declared), so for a clean checkout a receipt cannot name a commit or patch it did
not execute. (A dirty tree yields no commit and is rejected; this catches accidental/naive
dirtiness, not a deliberately index-manipulated `.git`, which our own clean-clone flow does not
create — the trustless guarantee is the separate execution-in-the-signed-workflow build.)
`base_tree_digest` is the pre-patch base anchor for re-runs — it is *not* a digest of the final
executed state (the patch and the networked install both change the tree afterward; those are
execution, disclosed via `patch_sha256`, `install_commands`, and `network_policy`).
`pre_check_tree_digest`, `post_check_tree_digest`, and `check_tree_changed` additionally disclose
whether the declared check commands changed the workspace they received. New records also disclose
the workspace mode, normalized write allowlist, effective workspace caps, initial phase-B manifest
digest, and final changed tracked, untracked, and mode-change paths. This is final-state evidence: a
check that restores the original bytes before it exits is not represented as a final change.

Before phase A, the executor resolves the configured image with `docker image inspect`, pulling
it once and retrying when it is not present locally. Phase A and every phase-B check run by the
resolved immutable `sha256:...` image ID, never the mutable tag. The run record keeps the
configured string as `container_image_ref`, the repository content digest when available as
`container_image_digest`, and always records `container_image_id`, container OS, and architecture.
If the immutable identity cannot be resolved, execution fails closed before any containerized
command and no run record is written. The environment also reports the literal network policy
`phaseA:bridge,phaseB:none`.

The executor always attempts to remove phase containers and removes its temporary workspace
in a `finally` block.

## Isolation ceiling and foreign-run preconditions

The emitted container posture is hardened (non-root, all caps dropped, `no-new-privileges`,
read-only root, default seccomp, no Docker-socket mount), but unremapped stock Docker is **not an
accepted deployment for foreign PR code**. The retired
[`foreign-run-gate-checklist.md`](foreign-run-gate-checklist.md) records historical containment
considerations only and does not authorize outreach or execution. Any current execution authority
must come from current operator instructions and explicit verification-execution consent.

Phase A runs dependency install/lifecycle scripts with network access. IMDS, Docker TCP endpoints,
host/LAN services, and unrelated internal services must be unreachable; this exposure is a
blocking deployment precondition, not an accepted exfiltration residual. The Docker client process
inherits the operator environment, while `/usr/bin/env -i` prevents those values and image-defined
environment variables from reaching the foreign shell. The runner itself must still hold no host,
cloud, GitHub, signing, or model credentials.

After those controls are proved, two residuals remain explicit: no container or VM stack can prove
the absence of every kernel/runtime escape, and a `writable_copy` command can mutate, consume, and
restore a file before its command-boundary manifest is recorded. A run record attests what ran and
the observed final state; it never proves test honesty, code quality, or security (see the Claims
Boundary).
