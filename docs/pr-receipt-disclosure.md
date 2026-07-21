# PR receipt disclosure

Northset-authored contributor PRs published after the historical cutover carry a facts-first,
state-specific verification block in the PR body. Block v2 is rendered from the mission's recorded
verification command, patch commit, and canonical receipt URL. The full receipt stays on the
receipt page; the PR gets no badge, logo, or unsolicited bot-style comment.

Two read-only audit lanes enforce the same marked-block contract:

- The missions-directory lane reads `missions/M-XXX/mission.json` and `publication.json`.
  Its expected block version is the stored `publication.json:pr_disclosure.schema_version`.
- The factory lane reads a local checkout of the `receipts` branch at
  `receipts/M-XXX/current.json` plus the selected `<contribution_commit_oid>/proof.json` and
  `publication.json`. It verifies `current.json:proof_sha256` against the exact proof bytes before
  using the proof. The expected command is `proof.patched_observation.command`, and the exact head
  is `proof.commit_oid`.

Both audit lanes read live PR bodies and comments only through the same fail-closed HTTP response
adapter. The audits never write to GitHub; PR-body rewrites happen only through the explicit,
human-authorized guarded sync paths described below.

## Enforced invariants

For every in-scope contributor receipt after its lane's cutover:

1. The lane-specific mission, publication, and receipt identities agree. Missions-directory
   records also require a schema-valid `publication.json:pr_disclosure`; factory records require
   the selected proof-byte digest to match `current.json`.
2. The exact canonical `receipts/M-XXX/` endpoint returns HTTP `200`.
3. The exact allowed marked block for the lane-selected block version occurs in the live PR body.
   Missions use the stored `pr_disclosure.schema_version`; factory records use their policy pin or
   the current default. Existing v1 records remain valid; new syncs and factory publications use v2.
   A v2 factory record whose publication state is `MERGED` may temporarily retain the exact open
   block and is reported as `merged_sync_pending`; the exact merged block is `verified`. No other
   merged body is accepted.
4. The canonical receipt URL occurs exactly once. An exact v2 merged block also contains the
   run-request template URL exactly once, for exactly two Northset URLs total. Exact v2 open and
   closed-unmerged blocks contain one Northset URL. The body contains no legacy `#M-XXX` URL.
5. No configured Northset actor has posted that receipt URL as a PR comment.
6. The private-run invitation occurs exactly once in an accepted merged block and never in an open
   or closed-unmerged block. A merged-style block on an `OPEN` or unmerged `CLOSED` factory PR
   fails, preserving the non-promotional-while-open rule.

The GitHub Actions job is read-only and has no `issues: write` or `pull-requests: write`
permission. It observes live public PR state; it never edits or comments. GitHub credentials are
sent only to `https://api.github.com`, never to the public receipt site.

## Read-only missions-directory audit

```sh
node bin/pr-receipt-disclosure.mjs check \
  --missions-dir missions \
  --policy policies/pr_receipt_disclosure_policy.json \
  --json
```

The command exits nonzero on any missing metadata, dead receipt URL, body mismatch, legacy URL,
URL-count violation, or Northset-authored receipt-link comment. Prepared receipts and explicit
historical exemptions are reported separately and cause no network requests. Only non-exempt,
non-prepared contributor receipts cause remote reads.

## Read-only factory receipts audit

Point `--factory-receipts-dir` at the `receipts/` directory from a local checkout or archive of
the `receipts` branch:

```sh
node bin/pr-receipt-disclosure.mjs check \
  --factory-receipts-dir /path/to/receipts \
  --policy policies/pr_receipt_disclosure_policy.json \
  --json
```

For each mission directory, the checker follows `current.json:contribution_commit_oid`, verifies
the exact selected `proof.json` bytes against `current.json:proof_sha256`, and reads the adjacent
`publication.json`. `OPEN` and unmerged `CLOSED` records require the non-promotional block and fail
if a merged-style block is present. For a v2 `MERGED` record, exactly two block states are accepted:

- The byte-exact v2 open block (one Northset URL, no invitation) reports
  `merged_sync_pending`. This is a labeled, non-failing status counted separately in text and JSON.
- The byte-exact v2 merged block (the invitation once, two Northset URLs) reports `verified`.

Any other body fails. Factory publication schema versions 1 and 2 are accepted for existing status
records, but an expected block v2 requires a proof schema v2 with a recorded patched command.

`policies/pr_receipt_disclosure_policy.json:factory_block_schema_versions` pins the historical
factory PRs to block v1. Unlisted factory mission IDs use `current_block_schema_version` (v2), so
future publications fail closed unless the exact v2 block is present. These version pins are not
audit exemptions: legacy factory PR bodies are still checked against the exact v1 block, state,
URL-count, invitation, and comment rules.

In `ci / pr-disclosure`, the missions-directory lane runs from the checked-out branch. A separate
step initializes an ephemeral Git repository under `$RUNNER_TEMP`, fetches the `receipts` branch
only into that temporary repository, extracts its archive under `$RUNNER_TEMP`, and runs the factory
lane over it. The checkout's `.git` directory is untouched. If a fork or fresh repository has no
`receipts` branch, receipts directory, or `current.json` records, the workflow emits a clearly
labeled notice and skips only the factory lane. The job retains the repository-wide `contents: read`
permission and no write permission.

## Check or synchronize one missions-directory PR

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
the PR is open (and if it closes without merging), block v2 is:

```md
<!-- northset-receipt:M-021:start -->
### Verification

`npm test` exited 0 on this exact head (`abcdef0`) in a network-off container, before this PR was opened.
No workflow or CI files are modified in this change.
Commands, environment, and hashes: [receipt M-021](https://northset-oss.github.io/verification-pilot/receipts/M-021/) — checkable in ~30 seconds without trusting us.
Self-run by the contributor, not maintainer verification.
<!-- northset-receipt:M-021:end -->
```

The workflow/CI sentence is present only when the factory mechanically derived the changed-file
list and found no workflow or recognized CI configuration path. The checker accepts the exact v2
block with or without that sentence. An argv-array command is joined with single spaces; a rendered
command longer than 80 characters becomes the literal text `the repository's declared test command`.

After the publication state is recorded as `merged`, the synchronizer replaces only that marked
block with:

```md
<!-- northset-receipt:M-021:start -->
### Verification

`npm test` exited 0 on this exact head (`abcdef0`) in a network-off container, before this PR was opened.
No workflow or CI files are modified in this change.
Commands, environment, and hashes: [receipt M-021](https://northset-oss.github.io/verification-pilot/receipts/M-021/) — checkable in ~30 seconds without trusting us.
This record covers Northset's own contribution; it is not maintainer verification.
Maintainers: request a separate private run for any PR in your queue — open a run request: https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml or email oss@northset.ai.
For repositories already onboarded with Northset, adding `northset-verify` to a PR requests a run on that PR.
<!-- northset-receipt:M-021:end -->
```

After a successful remote readback, the command records the validated `pr_disclosure` observation
in the mutable `publication.json`. It never modifies `mission.json`, any signed bundle file, or a
historically exempt PR. If a maintainer explicitly invites a separate receipt comment, stop: the
default gate intentionally rejects it until a human-authorized, reviewable exception is added.

## Guarded factory merged-state sync

Factory PRs are opened with the non-promotional v2 open block. The factory worker never rewrites a
PR body after creation, and its reconciler remains read/status-only. After the adjacent factory
`publication.json` records `MERGED`, the read-only sync command reports either
`merged_sync_pending` or `verified` without changing local or remote state:

```sh
node bin/pr-receipt-disclosure.mjs sync \
  --factory-receipts-dir /path/to/receipts \
  --mission M-1009 \
  --policy policies/pr_receipt_disclosure_policy.json
```

An authorized human may apply the merged block only with the exact PR URL and a GitHub token:

```sh
node bin/pr-receipt-disclosure.mjs sync \
  --factory-receipts-dir /path/to/receipts \
  --mission M-1009 \
  --policy policies/pr_receipt_disclosure_policy.json \
  --apply \
  --confirm-pr-url https://github.com/OWNER/REPO/pull/NUMBER
```

Before editing, the command verifies the exact `current.json` to `proof.json` SHA-256 binding, the
selected proof identity, a `publication.json` with the same confirmed PR URL and `MERGED` state,
and a live body containing the exact v2 open-state marked block. It then replaces only that marked
block with the exact merged bytes and rereads the PR to confirm them. It writes no receipt-branch
files and records no new state files. This stateless design deliberately avoids making the ledger
tool write into orchestrator-owned publication envelopes.

PR-body rewrites are never autonomous. They occur only through this human-authorized sync path;
the factory worker, reconciler, audit, and CI remain read-only after PR creation.

## Missions-directory publication sequence

1. Reserve the mission ID and produce the proof-of-pass receipt.
2. Publish the receipt and confirm its canonical endpoint is live.
3. Open the named-person contributor PR under the target repository's current rules.
4. Record the exact PR URL in `publication.json`.
5. Run the guarded `sync --apply` command with explicit human authorization.
6. Commit the resulting `pr_disclosure` observation.
7. Require `ci / pr-disclosure` before merging the ledger publication.
8. When the recorded PR state changes, run the guarded synchronizer again. A merge adds the
   one-time invitation inside the existing body block; closure without merge keeps it absent.

The missions-directory historical list and the factory block-version pins are the two cutovers.
Do not broaden the exemption list or add a v1 factory pin to make a future receipt pass; correct
the live PR disclosure instead.

## Factory-lane lifecycle

1. The factory opens the contributor PR with the exact non-promotional v2 open block.
2. When `publication.json` first records `MERGED`, that unchanged body audits successfully as
   `merged_sync_pending`; CI passes while reporting and counting the pending sync separately.
3. A human authorizes and runs the guarded factory `sync --apply` command with the exact PR URL.
4. The command applies and confirms the exact v2 merged block, after which the audit reports
   `verified`.
