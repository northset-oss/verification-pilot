# Run-request intake

This procedure turns an inbound request into scoped consent to run repository-declared checks. It
does not grant permission to change the pull request, publish a run record, or act on other pull
requests.

## Consent evidence by request route

For the dedicated GitHub form, the public issue itself is the consent artifact. The `run-request`
label is the intake queue, not an analytics tracker. Preserve the issue URL and the submitted
answers with the run's private operator record; do not broaden the request beyond the named PR.

For a request sent to `oss@northset.ai`, preserve the original correspondence in Northset's
private evidence store. Record the received time, sender, PR URL, repository, statement that the
sender is a maintainer or authorized representative, requested checks, preferred contact, and
publication preference. Do not copy private correspondence into a public issue, repository,
ledger, or receipt.

For an onboarded repository, a `northset-verify` label requests a run only on the PR carrying the
label. Preserve the label event and the repository's onboarding authorization together. A label
in a repository that has not been onboarded is not sufficient consent by itself.

## Operator gates

Before execution:

1. Confirm the request names a public PR and repository.
2. Confirm the requester selected maintainer or authorized representative. If they selected
   `Other`, obtain and preserve authorization before proceeding.
3. Confirm the declared checks: use repository defaults unless the requester supplied a specific
   scope.
4. Confirm the result is private by default and the preferred return channel is usable.
5. Bind the retained consent artifact to the run input before any repository code executes.

After execution, return the scoped run record privately. Public form submission is not
publication approval. Publishing a receipt or signed bundle requires separate, affirmative
publication approval that names the record to be published; preserve that approval with the
operator record.

A stop or withdrawal overrides the earlier request. Record the withdrawal, halt work that has not
completed, do not publish, and do not treat the request as continuing consent for another PR.
