# Foreign PR production runner

Foreign pull-request code may run only through `bin/foreign-runner.mjs`. The command creates a
fresh Docker Sandbox micro-VM for one job, runs the production containment battery on that same
VM and Docker daemon, and removes the VM in a host-side `finally` block. It does not push, comment,
publish, or contact a maintainer.

The approved pilot profile is intentionally narrow:

- `sbx` 0.35.0 or newer, with the global network policy initialized to `deny-all`;
- an empty `sbx` secret store;
- the Node executor profile and the pinned image
  `node@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5`;
- phase-A egress only to `registry.npmjs.org`; phase B remains `--network=none`;
- a daemon-owned tmpfs executor workspace capped at 1 GiB and 32,768 inodes;
- an exact detached source commit cloned from a read-only input mount, then owned by root with
  every write bit removed before executor preflight;
- the default read-only phase-B workspace. `writable_copy` is refused.

## Infrastructure gate

Run this before authorizing foreign-PR offers after a runner, Docker, network-policy, image, or
host change:

```sh
node bin/foreign-runner.mjs gate --json
```

`INFRASTRUCTURE_GO` means the sacrificial job passed all runtime probes with zero skips and the
external reaper removed the disposable VM after an executor-shaped child was killed with
`SIGKILL`. It authorizes the team to make an accurate, consent-first offer. It is not permission to
execute a specific PR.

## Candidate-bound run

After the maintainer explicitly consents to one PR, hydrate its public repository locally and
prepare the normal executor config. The config must name the pinned image above, use the `node`
profile, and use the read-only workspace mode. Then run:

```sh
node bin/foreign-runner.mjs run <executor-config.json> \
  --source-commit <exact-40-hex-base-commit> \
  --out <new-empty-output-directory> \
  --json
```

The runner clones that exact commit inside the micro-VM, copies the approved patch as immutable
input, repeats the quota and zero-skip production battery, rechecks the final policy and runtime,
and only then calls the existing executor. It copies out only `run_record.json`, `stdout.txt`, and
`stderr.txt`, then destroys the VM. A failure at any point is a no-go and produces no public action.

The output remains private by default. Publishing a receipt, pushing code, opening or modifying a
PR, and posting a comment remain separate human-authorized actions.

## Host setup

The runner fails closed unless all three checks already pass:

```sh
sbx version
sbx secret ls
sbx policy check network example.com
```

The expected state is `sbx` 0.35.0 or newer, `No secrets found`, and `Denied`. Initialize a new
host once with `sbx policy init deny-all`. Do not substitute Docker Desktop's ordinary daemon or
the older `docker sandbox` plugin: neither is the production target named by this runbook.

## Authorization boundary

- No human approval is needed for the local infrastructure gate or local preparation.
- A maintainer's explicit per-PR consent is required before the candidate-bound run.
- The run itself does not authorize publication or any GitHub mutation.
- A separate content-bound human approval is required for any later public action.

