# Attestation — signing and verifying a run record

A run record bundle is signed with [GitHub artifact attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations)
(Sigstore, recorded in the public Rekor transparency log). The signature is **provenance**: it
proves the bundle came from this repository's `attest-bundle` workflow at a specific commit and
has not been altered since. It does **not** prove the checks passed, the code is safe, or the
work is good — see [Claims Boundary](../policies/claims_boundary.md).

## How a bundle gets signed

The `.github/workflows/attest-bundle.yml` workflow runs only after the named `ci` workflow
completed successfully for a push to `main`. CI validates the repository and packages the exact
handoff bytes. One handoff contains zero to 50 changed missions, with one independently named
tarball per mission. The signer does not check out a mutable worktree. It:

1. resolves the before/head range from the exact successful run's platform artifact name and
   downloads only that matching artifact,
2. fetches those Git objects into a bare repository and independently derives the exact changed
   mission set,
3. checks the embedded verifier against SHA-256 values pinned in the workflow before running it,
4. verifies both range SHAs, the exact metadata/artifact/mission sets, and every digest-qualified
   asset and tag,
5. safely inspects each archive, checks its mission identity, manifest, file hashes and recomputed
   bundle digest, and compares every archived path, mode and byte with the resolved head Git tree,
6. exits on the explicit no-op metadata when no bundle changed,
7. attests every tarball in one pinned action invocation, and
8. publishes each unchanged tarball under its metadata-bound mission release tag.

CI builds each archive directly from the resolved head Git tree, so ignored files and mutable
working-tree or index-hidden bytes cannot enter a head-bound handoff. The metadata and tarballs
are deterministic for a fixed source snapshot. A one-mission push is a
one-item batch with the same `run-record-M-XXX-<digest-prefix>.tar.gz` asset and
`run-record-M-XXX-<digest-prefix>` release conventions. Existing releases are not renamed.

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
