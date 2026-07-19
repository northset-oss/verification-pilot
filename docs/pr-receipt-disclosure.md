# PR receipt disclosure

Northset-authored contributor PRs published after the historical cutover carry one short link to
their canonical Proof-of-Pass Receipt in the PR body. The full receipt stays on the receipt page;
the PR gets no badge, logo, attestation explanation, or unsolicited bot-style comment.

## Enforced invariants

For every non-prepared `author_contribution` not listed in
`policies/pr_receipt_disclosure_policy.json` as historical:

1. `publication.json:pr_disclosure` is present and schema-valid.
2. The exact canonical `receipts/M-XXX/` endpoint returns HTTP `200`.
3. The exact state-specific marked block occurs in the live PR body and its canonical URL occurs
   exactly once.
4. The body contains no legacy `#M-XXX` URL and no second Northset ledger link.
5. No configured Northset actor has posted that receipt URL as a PR comment.
6. The private-run invitation occurs exactly once for `merged` publications and never for `open`
   or `closed_unmerged` publications.

The GitHub Actions job is read-only and has no `issues: write` or `pull-requests: write`
permission. It observes live public PR state; it never edits or comments. GitHub credentials are
sent only to `https://api.github.com`, never to the public receipt site.

## Read-only repository audit

```sh
node bin/pr-receipt-disclosure.mjs check \
  --missions-dir missions \
  --policy policies/pr_receipt_disclosure_policy.json \
  --json
```

The command exits nonzero on any missing metadata, dead receipt URL, body mismatch, legacy URL,
duplicate ledger link, or Northset-authored receipt-link comment. Prepared receipts and explicit
historical exemptions are reported separately. Only future non-prepared contributor receipts
cause network requests.

## Check or synchronize one future PR

The single-mission command is read-only unless `--apply` is present:

```sh
node bin/pr-receipt-disclosure.mjs sync \
  --mission-dir missions/M-021 \
  --policy policies/pr_receipt_disclosure_policy.json
```

If the disclosure is missing, this read-only check fails without changing local or remote state.
After the receipt page is deployed and the exact PR URL has been recorded, an authorized human
may apply the marked block:

```sh
node bin/pr-receipt-disclosure.mjs sync \
  --mission-dir missions/M-021 \
  --policy policies/pr_receipt_disclosure_policy.json \
  --apply \
  --confirm-pr-url https://github.com/OWNER/REPO/pull/NUMBER \
  --now 2026-07-14T16:00:00Z
```

`--apply` requires both the exact confirmation URL and a GitHub token from `GITHUB_TOKEN`,
`GH_TOKEN`, or the authenticated `gh` session. Before editing, it verifies that the receipt is
live, the publication points to the same PR, no conflicting ledger link is present, and no
prohibited receipt comment exists. It then inserts or replaces an idempotent marked block. While
the PR is open (and if it closes without merging), the block remains deliberately
non-promotional:

```md
<!-- northset-receipt:M-021:start -->
### Verification

[Northset proof-of-pass receipt M-021](https://northset-oss.github.io/verification-pilot/receipts/M-021/)
Contributor self-run; not maintainer verification.
<!-- northset-receipt:M-021:end -->
```

After the publication state is recorded as `merged`, the synchronizer replaces only that marked
block with:

```md
<!-- northset-receipt:M-021:start -->
### Verification

[Northset proof-of-pass receipt M-021](https://northset-oss.github.io/verification-pilot/receipts/M-021/)
This record covers Northset’s own contribution; it is not maintainer verification.
Maintainers can request a separate, private run for a PR already in their queue at oss@northset.ai.
For repositories already onboarded with Northset, adding `northset-verify` to a PR requests a run on that PR.
<!-- northset-receipt:M-021:end -->
```

After a successful remote readback, the command records the validated `pr_disclosure` observation
in the mutable `publication.json`. It never modifies `mission.json`, any signed bundle file, or a
historically exempt PR. If a maintainer explicitly invites a separate receipt comment, stop: the
default gate intentionally rejects it until a human-authorized, reviewable exception is added.

## Publication sequence

1. Reserve the mission ID and produce the proof-of-pass receipt.
2. Publish the receipt and confirm its canonical endpoint is live.
3. Open the named-person contributor PR under the target repository's current rules.
4. Record the exact PR URL in `publication.json`.
5. Run the guarded `sync --apply` command with explicit human authorization.
6. Commit the resulting `pr_disclosure` observation.
7. Require `ci / pr-disclosure` before merging the ledger publication.
8. When the recorded PR state changes, run the guarded synchronizer again. A merge adds the
   one-time invitation inside the existing body block; closure without merge keeps it absent.

The explicit historical list is the cutover. Do not broaden it to make a failing future receipt
pass; correct the live PR disclosure instead.
