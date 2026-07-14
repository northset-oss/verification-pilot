# Attestation — signing and verifying a run record

A run record bundle is signed with [GitHub artifact attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations)
(Sigstore, recorded in the public Rekor transparency log). The signature is **provenance**: it
proves the bundle came from this repository's `attest-bundle` workflow at a specific commit and
has not been altered since. It does **not** prove the checks passed, the code is safe, or the
work is good — see [Claims Boundary](../policies/claims_boundary.md).

## How a bundle gets signed

The `.github/workflows/attest-bundle.yml` workflow runs only after the named `ci` workflow
completed successfully for a push to `main`. CI validates the repository and packages the exact
handoff bytes. The signer never checks out or executes repository code. It:

1. downloads the artifact produced by that exact CI run and verifies its head SHA metadata,
2. handles an explicit no-op marker when no bundle changed,
3. validates the mission id and digest-qualified asset/tag names, and
4. attests and releases the exact CI-produced tarball with pinned actions.

Public-repository attestations are written to the public transparency log, so anyone can verify
them without any Northset infrastructure or trust.

## How to verify a run record yourself

Download the bundle tarball referenced by a ledger entry, then run:

```sh
gh attestation verify run-record-<MISSION>-<BUNDLE-DIGEST-PREFIX>.tar.gz \
  --repo northset-oss/verification-pilot \
  --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
```

- `--repo` scopes trust to this repository (not merely the org — `--owner` alone would trust any
  workflow under the organization).
- `--signer-workflow` further pins the attestation to the exact workflow that is allowed to sign
  a run record.

A successful verification tells you the tarball is authentic and came from that workflow at the
recorded commit. What the bundle *contains* — the declared commands, the run record, the
maintainer outcome — is then yours to read and judge, with the [Claims Boundary](../policies/claims_boundary.md)
stating exactly what each field does and does not establish.
