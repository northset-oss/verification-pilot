# Mission pipeline

The mission pipeline turns a prepared mission-input JSON file into a redacted run-record
bundle and refreshes the public mission index. It does not clone repositories, contact GitHub,
or attest the result.

## Consent gate

The pipeline fails closed before starting the executor. It first validates the full `mission`
receipt. Variants `V`, `W`, and `F` then require both an HTTP(S) `consent_artifact` in the
receipt and a readable, absolute `consent_file` path. The file must be a strict
`schema/public-consent.schema.json` receipt bound to the same mission, variant, and public
consent URL and set `publication_consent` to `true`; its canonical JSON is stored as
`consent.json`. An `own_repo_rehearsal` needs no consent file, but its disclosure label must
contain `Self-funded rehearsal. Not external validation.` There is no bypass flag.

If the gate or any later stage fails, the pipeline removes its staged mission. With `--force`,
an existing mission is saved and restored if replacement fails.

Before execution, the pipeline requires `mission.commands_declared` to exactly equal
`executor.commands`, including order. After execution, it checks the returned run record's
command list against the same declaration before creating or publishing the bundle. Either
mismatch fails closed: the pre-execution mismatch never invokes the executor, and neither
mismatch leaves a partial published mission directory.

When `economic` is present, its static task, funding, lineage, usage, scope, cost, completeness,
and provenance facts are also validated before execution. After execution, the pipeline replaces
only the verification placeholder with run-derived measurements, validates it again against the
actual run record, and writes it as `economic.json` before bundle creation.

## Input

The input JSON accepts exactly these top-level fields:

```json
{
  "mission": {},
  "repo_dir": "/absolute/path/to/repository",
  "patch_file": "/absolute/path/to/change.patch",
  "consent_file": "/absolute/path/to/consent.json",
  "issue_snapshot_file": "/absolute/path/to/issue_snapshot.json",
  "ci_links_file": "/absolute/path/to/ci_links.json",
  "economic": {},
  "executor": {
    "image": "node:20-bookworm",
    "install_commands": ["npm ci"],
    "commands": ["node --test"],
    "workspace_mode": "writable_copy",
    "workspace_write_allowlist": ["coverage"],
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
`mission.commands_declared`. Workspace mode defaults to `readonly`; use `writable_copy` with a
bounded `workspace_write_allowlist` only when declared checks must emit artifacts. When the
mission declares `workspace_mode`, it must match the executor's effective mode before execution.
`economic` is
optional for legacy inputs; when present it must follow
the source form documented in [economic-identity.md](economic-identity.md).

## CLI

```sh
node bin/run-mission.mjs mission-input.json \
  --missions-dir missions \
  --site site/index.html \
  --now 2026-07-09T12:00:00Z \
  --json
```

`--site` is optional and renders the public ledger page from the refreshed index in the same
run. The page is staged next to its target and both artifacts are moved into place only after
both have been produced, so a render failure rolls the whole mission back and the committed
`missions/index.json` and `site/index.html` never disagree. (CI independently re-renders the
page from the index and fails on any drift.) A tested failure-injection seam after the index
rename proves that the previous mission, index, and complete site tree are restored together.

`--now` is optional. When supplied, the same timestamp is passed to the executor, bundle, and
ledger. `--force` replaces an existing mission directory only after a new bundle has been
assembled successfully. Without it, an existing `<missions-dir>/<mission_id>` fails with
`MISSION_EXISTS`.

Every public pipeline run fails closed unless every declared command exited `0` without timing
out. `--require-success` remains accepted for command-line compatibility, but success is no
longer optional: a failed or timed-out execution cannot reach the public receipt, bundle, ledger,
or attestation path. A failed execution requires a separate run-record-only path; this repository
does not currently publish one.

## Receipt quality for public missions

`--now` exists for deterministic tests. A mission intended for the public ledger should carry
real evidence values instead of placeholders:

- run without `--now` so `started_at`/`finished_at` are the actual execution times;
- set `base_commit` to the actual 40-hex commit the workspace copy was checked out at — the
  Claims Boundary promises "on this declared code", so a published receipt should pin it;
- set `patch_commit`/`patch_diff_hash` whenever a patch was applied.

On success the command reports the mission directory, bundle digest, number of ledger entries,
and `attestationPending: true`. Signing happens separately, in GitHub Actions. A successful
`ci` run on the exact main-branch commit validates and packages the bundle; the
`.github/workflows/attest-bundle.yml` workflow downloads that CI artifact without checking out
or executing repository code, then attests the exact bytes. The pipeline itself never contacts
GitHub or signs. Once that workflow has run, anyone can verify the
bundle's provenance:

```sh
gh attestation verify run-record-<MISSION>.tar.gz \
  --repo northset-oss/verification-pilot \
  --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
```

See [attestation.md](./attestation.md) for what the signature does and does not prove.
