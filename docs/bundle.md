# Run-record bundles

Create a deterministic bundle from a mission directory and three caller-captured inputs:

```sh
node bin/bundle.mjs create <mission-dir> \
  --stdout <stdout-file> \
  --stderr <stderr-file> \
  --run-record <run-record-file> \
  --created-at <ISO-8601-date-time>
```

The mission must pass the existing mission validator. Variants `V`, `W`, and `F` also
require a schema-valid `<mission-dir>/consent.json` public consent receipt with explicit
`publication_consent: true`; an own-repository rehearsal does not include that
file. The command replaces `<mission-dir>/bundle`, prints its `sha256:` bundle digest,
and never reads the network or environment variables. Pass `--json` for structured
output.

The input run record has this shape and rejects other top-level keys:

```json
{
  "started_at": "2026-07-08T10:00:00Z",
  "finished_at": "2026-07-08T10:00:01Z",
  "environment": {
    "container_image_digest": null,
    "network_policy": "Network disabled"
  },
  "commands": [
    { "cmd": "node --test", "exit_code": 0, "duration_ms": 1000, "timed_out": false }
  ],
  "notes": null
}
```

`exit_code` is an integer for a completed command. A timed-out command instead has
`"exit_code": null` and `"timed_out": true`; these two values are required together.
`timed_out` is optional for completed commands and, when present, must be `false`.

String values in that record and both captured streams are redacted. The output run
record gains a `redactions` object whose counts cover all three artifacts. Redaction
kinds are `authorization`, `aws_access_key`, `bearer`, `email`, `env`, `github_token`,
`hex_private_key`, `jwt`, `path`, `private_key`, `url_query`, and `url_userinfo`.
Northset email addresses are retained, while user names in `/Users/<name>/` and
`/home/<name>/` paths become `[user]`.

The bundle contains the validated mission, derived command/base/outcome/tier files,
the redacted run outputs, any supported optional source files, and
`bundle.manifest.json`. Manifest entries are path-sorted, exclude the manifest itself,
and record the SHA-256 and byte length of every other bundle file. `created_at` comes
only from the required flag. When the mission pipeline supplies `economic.json`, it is validated
and included as another signed bundle member; a later `approval.json` is deliberately outside this
prepared bundle because approval happens after these exact bytes exist.

Verify an existing bundle with:

```sh
node bin/bundle.mjs verify <mission-dir>
```

Success prints `OK <bundle_digest>`. Verification rejects non-regular members (including
symlinks), hash/size drift, missing or extra files, invalid mission/run-record structure, and
semantic contradictions among the mission, declared/executed commands, base commit, patch,
claims tier, maintainer outcome, consent receipt, and optional economic identity. Legacy run records
without `schema_version` and schema-version-1 records remain readable; newly executed records use
`schema_version: 2`. `--json` is
available for verification as well.
