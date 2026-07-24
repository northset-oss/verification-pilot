# Northset OSS Run Records

This repository contains the dependency-free Node.js tooling and immutable evidence used to
produce scoped run records for the Northset OSS mission.

A run record states only which declared commands returned exit 0 on named code in a named
environment. It is not a code-quality, security, maintainer-approval, merge, or product
recommendation.

## Public projection policy

The public ledger is a consent-gated technical projection:

- contribution invitation;
- verification execution consent;
- receipt publication consent; and
- marketing reference consent

are four independent scopes. Missing receipt-publication consent fails closed: the named record
remains internal and no receipt page, homepage listing, repository aggregate, or machine-readable
public receipt is emitted. Marketing reference consent never follows from technical publication
consent.

Legacy mission and bundle bytes remain immutable. The only consent-free correction projection is
the fixed M-012 incident record. Its `correction_only` page is available only at the direct
unlisted URL and cannot be reused for another mission.

The renderer intentionally omits mutable pull-request, review, and CI status from immutable
receipt pages. Public artifacts are produced only through the deterministic renderer and checked
by `bin/publication-policy.mjs`.

## Run it yourself

Prerequisites are Node.js 20 or newer and Docker for real execution.

```sh
node --test
```

To produce a local run record:

```sh
node bin/run-mission.mjs <mission-input.json> --missions-dir missions
```

The mission input, executor settings, and local-only options are documented in
[the pipeline guide](docs/pipeline.md). The pipeline does not publish remote state.

Build and render the deterministic ledger:

```sh
node bin/ledger.mjs build \
  --missions-dir missions \
  --out missions/index.json \
  --now 2026-07-24T00:22:16Z

node bin/ledger.mjs render \
  --index missions/index.json \
  --out site/index.html \
  --now 2026-07-24T00:22:16Z

node bin/publication-policy.mjs validate \
  --site site \
  --index missions/index.json
```

The Pages workflow renders into a fresh temporary directory, binds every output byte to the
selected `main` and `receipts` source revisions in `deployment-manifest.json`, uploads that exact
directory, and verifies the deployed bytes against the manifest.

## Main components

| Piece | Purpose |
| --- | --- |
| `schema/` | Mission, run-record, publication, receipt, economic, approval, and independent consent-scope schemas |
| `lib/executor.mjs` | Two-phase Docker execution with declared network policy |
| `lib/bundle.mjs` | Redacted immutable run-record bundle and digest manifest |
| `lib/pipeline.mjs` | Local consent gate, execution, bundle, and ledger build |
| `lib/ledger.mjs` | Deterministic internal index and consent-gated public renderer |
| `lib/publication-policy.mjs` | Fail-closed listing, rendered-output validation, and source/deployment parity |
| `lib/factory-receipts.mjs` | Receipts-branch proof validation and projection |

Factory proof schema v3 carries the same complete `consent_scopes` v2 object used by the ledger.
Older factory proof versions remain private. The merge path does not infer or broaden consent.

## Claims and operation

- [Claims Boundary](policies/claims_boundary.md)
- [Maintainer Respect Policy](policies/maintainer_respect_policy.md)
- [Public ledger](docs/ledger.md)
- [Independent consent scopes](docs/run-request-intake.md)
- [Executor](docs/executor.md)
- [Bundle format](docs/bundle.md)
- [Attestation](docs/attestation.md)

The tooling and formats are licensed under [Apache-2.0](LICENSE).
