# Mission pipeline

The mission pipeline turns a prepared mission-input JSON file into a redacted run-record
bundle and refreshes the public mission index. It does not clone repositories, contact GitHub,
or attest the result.

## Consent gate

The pipeline fails closed before starting the executor. It first validates the full `mission`
receipt. Variants `V`, `W`, and `F` then require both an HTTP(S) `consent_artifact` in the
receipt and a readable, absolute `consent_file` path. The file is copied verbatim to
`consent.md`. An `own_repo_rehearsal` needs no consent file, but its disclosure label must
contain `Self-funded rehearsal. Not external validation.` There is no bypass flag.

If the gate or any later stage fails, the pipeline removes its staged mission. With `--force`,
an existing mission is saved and restored if replacement fails.

Before execution, the pipeline requires `mission.commands_declared` to exactly equal
`executor.commands`, including order. After execution, it checks the returned run record's
command list against the same declaration before creating or publishing the bundle. Either
mismatch fails closed: the pre-execution mismatch never invokes the executor, and neither
mismatch leaves a partial published mission directory.

## Input

The input JSON accepts exactly these top-level fields:

```json
{
  "mission": {},
  "repo_dir": "/absolute/path/to/repository",
  "patch_file": "/absolute/path/to/change.patch",
  "consent_file": "/absolute/path/to/consent.md",
  "issue_snapshot_file": "/absolute/path/to/issue_snapshot.json",
  "ci_links_file": "/absolute/path/to/ci_links.json",
  "executor": {
    "image": "node:20-bookworm",
    "install_commands": ["npm ci"],
    "commands": ["node --test"],
    "limits": {
      "cpus": 2,
      "memory_mb": 4096,
      "pids": 512,
      "wall_clock_seconds_per_command": 600,
      "output_bytes_per_stream": 2000000
    }
  }
}
```

`patch_file`, `consent_file`, `issue_snapshot_file`, and `ci_links_file` may be `null` when
their artifact is absent, subject to the consent rule above. The pipeline supplies `repo_dir`
and `patch_file` to the executor configuration. `executor.commands` must be an exact copy of
`mission.commands_declared`.

## CLI

```sh
node bin/run-mission.mjs mission-input.json \
  --missions-dir missions \
  --now 2026-07-09T12:00:00Z \
  --json
```

`--now` is optional. When supplied, the same timestamp is passed to the executor, bundle, and
ledger. `--force` replaces an existing mission directory only after a new bundle has been
assembled successfully. Without it, an existing `<missions-dir>/<mission_id>` fails with
`MISSION_EXISTS`.

On success the command reports the mission directory, bundle digest, number of ledger entries,
and `attestationPending: true`. The next step is to attest the bundle in the
`attest-bundle` workflow and verify it with:

```sh
gh attestation verify <bundle> --owner northset-oss
```
