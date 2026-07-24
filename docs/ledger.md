# Public mission ledger

The ledger has two stages:

1. `build` validates every committed mission and produces an internal deterministic index.
2. `render` applies publication policy and emits only authorized public artifacts.

```sh
node bin/ledger.mjs build \
  --missions-dir missions \
  --out missions/index.json \
  --now 2026-07-24T00:22:16Z

node bin/ledger.mjs render \
  --index missions/index.json \
  --out site/index.html \
  --now 2026-07-24T00:22:16Z
```

The internal index retains normalized technical evidence for local validation. It is not itself
the public ledger. The public renderer reads the four independent consent scopes and fails closed:

- `listed` requires explicit `receipt_publication_consent`;
- `private_internal` emits no named public artifact; and
- `correction_only` is reserved for M-012 and emits its direct, unlisted incident correction page
  and sparse JSON record.

The normal public output contains `index.html`, `ledger.json`, public schemas,
`receipts/<MISSION>/index.html`, `receipts/<MISSION>/receipt.json`, and deterministic OG sources
only for explicitly listed technical records. Repository aggregate pages are not generated.
Mutable pull-request, review, CI, and outcome observations are not projected into immutable
receipt pages or their JSON summaries.

The builder still verifies exact mission/bundle parity, declared-command parity, proof-of-pass
evidence, patch and bundle digests, attestation identity, economic identity where present, and
the mutable publication envelope. Correcting publication state does not alter immutable mission,
bundle, patch, or run-record bytes.

Publication schema v1 remains valid for existing records. Schema v2 adds an explicit listing and
a correction record containing the correction identity, time, reason, source, superseded claims,
and prior/replacement rendered hashes.

Factory proof schema v3 adds the exact ledger `consent_scopes` v2 object to the structured proof.
Older factory proof versions remain `private_internal`; consent is never inferred from a PR,
proof, publication observation, or attestation.

After rendering:

```sh
node bin/publication-policy.mjs validate --site site --index missions/index.json
```

The validator rejects unconsented listings, marketing references without independent consent,
acquisition links, repository aggregates, mutable status fields, CI-agreement claims, and the
known stale M-012 incident facts.

The deployment workflow renders into a fresh directory and writes
`deployment-manifest.json`. The manifest binds each output path, byte count, and SHA-256 to the
exact ledger and receipts source revisions plus the merged index digest. The workflow verifies
the local manifest before upload and every deployed byte after Pages returns its URL.
