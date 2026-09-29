# Northset OSS Run Records (pilot ended)

> **This pilot ended on July 28, 2026.** Northset no longer takes run requests, opens pull requests under this program, or publishes new receipts. This repository and the [public ledger](https://northset-oss.github.io/verification-pilot/) stay online, unchanged, as a record of what was published. To have an entry removed, email oss@northset.ai.

From July 10 to July 28, 2026, Northset used this pilot to run the declared checks on its own open-source pull requests and on rehearsals in this repository, and published a record of each run, most of them signed. Every record is labeled for what it is: a rehearsal, or a contributor's check of its own change. None is a maintainer's verification. What a record does and does not establish is set out in the [Claims Boundary](policies/claims_boundary.md).

Thank you to the maintainers who reviewed our pull requests.

## Run it yourself

The whole pipeline is in this repo — Apache-2.0, with no package dependencies (pure Node.js and
its built-in test runner). Running the tests needs only Node; producing a real run record also
needs Docker, since the sandbox is a container.

**Prerequisites:** Node.js ≥ 20 (and Docker to produce a record).

```sh
node --test          # run the test suite — Node only, no Docker
```

To produce a run record, `bin/run-mission.mjs` takes a *mission-input* JSON file and runs the
consent gate → sandbox → bundle → ledger pipeline:

```sh
node bin/run-mission.mjs <mission-input.json> --missions-dir missions
```

The mission-input is a wrapper — a mission receipt plus the repository path and executor config;
its full shape and every flag (including the optional `--site`, which re-renders the ledger page)
are documented in [docs/pipeline.md](docs/pipeline.md). [`examples/`](examples/) holds sample
`mission.json` receipts — the inner object that wrapper carries — and each piece of the pipeline
has its own page under [`docs/`](docs/) (the table below). Signing happens separately, in GitHub
Actions — the pipeline itself never contacts GitHub.

A fresh execution rejects any pre-existing attestation and writes the new mission envelope with
`run_record_bundle_digest` and `attestation_uri` set to `null`. Those fields remain pending until
the new bundle is signed and its publication metadata is recorded.

## Proof-of-Pass Receipts

Public records appear at **<https://northset-oss.github.io/verification-pilot/>**. Verification work
for a maintainer is consent-first; contributor self-run records cover only Northset's own submitted
changes and do not represent maintainer approval. Immutable run bundles are kept separate from the
mutable `publication.json` envelope that tracks a PR's live status. The first entry is our own-repo
rehearsal ([`missions/M-001`](missions/M-001)), labeled as exactly that.

The ledger is an index of printable, permanent Proof-of-Pass Receipts. Each receipt shows the
verbatim declared commands and exit statuses from its committed run record, the recorded code and
environment, the source limitations, bundle provenance, and (separately) any linked live upstream
outcome. A pass is scoped to those declared commands; it is not a statement that the code is good,
secure, fully tested, maintainer-approved, or production-ready.

New contributor receipts also carry a factual **economic identity** in the same canonical receipt:
the issue-level task and complete attempt lineage, observed stage effort, measured executor usage,
enforced resource caps, verified change scope, explicit human approval, and public cost evidence
when it actually exists. Unknown model usage, compute, human effort, rates, or costs remain visibly
unknown; estimates and value/ROI claims are not accepted. A recorded zero maintainer payment means
only that no external maintainer payment occurred, never that the work cost zero. See
[Economic identity in Proof-of-Pass receipts](docs/economic-identity.md).

Northset-authored contributions are private-record by default. A normal upstream PR body does
not contain a mission ID, receipt or ledger link, product claim, trust claim, or call to action.
Historical public receipts remain available as records of their original publication; new public
receipt publication requires separate explicit consent.

## Our promises

- [Claims Boundary](policies/claims_boundary.md) — exactly what a run record does and does not establish.
- [Maintainer Respect Policy](policies/maintainer_respect_policy.md) — how we behave in and around your project.
- [Payment Policy](policies/payment_policy.md) — when, how, and — most importantly — what payment is never tied to.

## About this repository

This repo holds the open tooling behind the run records, with no runtime dependencies (pure
Node.js + the built-in test runner):

| Piece | What it does | Docs |
| --- | --- | --- |
| `schema/` + `bin/validate-mission.mjs` | Versioned mission, publication, ledger, public receipt, economic identity, approval, consent, and run-record schemas plus policy validation | [docs/schema.md](docs/schema.md) |
| `lib/executor.mjs` + `bin/execute.mjs` | The two-phase, network-isolated Docker sandbox that runs declared checks | [docs/executor.md](docs/executor.md) |
| `lib/bundle.mjs` + `bin/bundle.mjs` | Assembles the redacted run-record bundle and its digest manifest | [docs/bundle.md](docs/bundle.md) |
| `lib/pipeline.mjs` + `bin/run-mission.mjs` | Consent gate → sandbox → bundle → ledger, binding the record to what actually ran | [docs/pipeline.md](docs/pipeline.md) |
| `lib/ledger.mjs` + `bin/ledger.mjs` | Builds the public mission ledger and its static page | [docs/ledger.md](docs/ledger.md) |
| `lib/economic-identity.mjs` | Validates, finalizes, and projects factual task economics | [docs/economic-identity.md](docs/economic-identity.md) |
| `lib/signing-handoff.mjs` + `bin/signing-handoff.mjs` | Packages zero-to-50 HEAD-tree bundles and independently verifies their range, archive contents, and exact bytes while retaining one artifact per receipt | [docs/attestation.md](docs/attestation.md) |
| `.github/workflows/attest-bundle.yml` | Attests exact per-mission bundles together, then publishes each under its receipt-specific release | [docs/attestation.md](docs/attestation.md) |

Run the test suite with `node --test`.

Everything here — the tooling, the `mission.json` receipt format, and the bundle layout — is
licensed under [Apache-2.0](LICENSE), so you can adopt, implement, or fork the format without
asking us.
