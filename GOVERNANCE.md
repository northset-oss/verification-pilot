# Governance

Northset maintains this evidence format as an open, reviewable record. Repository changes use pull requests and must pass the complete `ci` workflow before they can be signed or published.

## Evidence boundaries

Files already committed under `missions/M-*/bundle/` and their matching signed release assets are immutable evidence. Corrections do not rewrite those bytes. A correction is recorded in the mission's `publication.json` and appears separately on the public receipt.

Publication envelopes are mutable observation records. They may be refreshed when an upstream pull request changes, but must retain `observed_at`, use full commit identifiers, and never imply that later upstream code was executed by the signed receipt.

Format changes require tests, synchronized JSON schemas, regenerated projections, and owner review. Signing and Pages deployment are downstream of a successful CI run for the exact main-branch commit.

## Decision making

Maintainers decide changes through repository review. Security reports follow [SECURITY.md](SECURITY.md). Changes to claims, evidence validation, signing, release, or deployment controls require CODEOWNER review.
