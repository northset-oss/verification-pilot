# Independent consent scopes

Consent is recorded as four independent decisions. One scope never implies another:

1. `contribution_invitation`
2. `verification_execution_consent`
3. `receipt_publication_consent`
4. `marketing_reference_consent`

The schema is [`schema/consent-scopes.schema.json`](../schema/consent-scopes.schema.json).
Each scope is `granted`, `absent`, or `not_applicable`. A granted scope requires its own evidence,
grant time, and granting identity. Public evidence is stored as an HTTP(S) URL; private evidence
is represented only by a SHA-256 digest. Non-granted scopes carry no evidence or grant metadata.

Receipt publication fails closed. If `receipt_publication_consent` is absent, the renderer emits
no named receipt page, homepage listing, repository aggregate, or machine-readable public
receipt. `correction_only` is not a general consent bypass: it is reserved for the M-012 incident
record, creates only that unlisted direct correction page, and cannot restore the original
technical projection.

Marketing reference is always a separate decision. Technical publication consent does not allow
use of a project, maintainer, contribution, review, or outcome in promotional copy, product
demonstrations, repository aggregate pages, or acquisition material.

Legacy consent schema v1 is accepted only when it explicitly records
`publication_consent: true`; the ledger maps that affirmative publication decision to the new
receipt-publication scope. No other missing or historical record is grandfathered.

A withdrawal or correction supersedes prior public projection authority. It does not mutate the
immutable mission, bundle, proof, or attestation bytes.
