# Public mission ledger

Build the machine-readable ledger from mission directories:

```sh
node bin/ledger.mjs build \
  --missions-dir missions \
  --out missions/index.json \
  --now 2026-07-15T00:00:00Z
```

Each direct child directory is checked for `mission.json`. Receipts are validated with
the mission validator. Strict mode is the default: a missing/invalid publication envelope,
receipt, bundle relationship, or normalized evidence field fails the build. The explicit
`--allow-skips` diagnostic mode omits invalid entries with warnings. Add `--json` to print the
included and skipped totals as a machine-readable summary.

The index is sorted by `mission_id` and contains the public projection plus a normalized
Proof-of-Pass Receipt view model. For every schema-valid mission, the builder reads the
committed `bundle/run_record.json` and requires exact, one-to-one command parity with
`mission.json:commands_declared`; missing, blank, or mismatched receipt evidence fails the
build rather than producing a partial receipt. It also binds top-level `mission.json` to the
signed `bundle/mission.json` (only the post-signing digest and attestation envelope may differ)
and requires every declared command to have returned exit `0` without timing out. When present,
only the nested issue title from `bundle/issue_snapshot.json` is exposed, and its `html_url` must
match `mission.json:issue_or_task`; bodies and comments are never projected. `generated_at` is
the exact `--now` value;
when the optional flag is omitted it is `null`, and the builder never reads the wall clock.

Schema-v2 receipts additionally require signed `bundle/economic.json` and an immutable top-level
`approval.json`; either both exist or neither exists. The builder verifies task and funding
identity, complete contiguous attempt lineage, run usage reconciliation, approval after run finish,
issue-snapshot provenance, and every cost source reference down to its public bundle-member digest
and JSON pointer. The economic file must have a matching `bundle.manifest.json` entry. It then
projects those facts into the same receipt. Existing missions with neither
artifact remain schema v1 and are not rewritten. See [Economic identity](economic-identity.md).

A required sibling `publication.json` is a mutable factual envelope for an immutable mission. It
records the direct PR URL and head OID, base/head drift, CI state, merge commit,
`prepared`/`open`/`closed_unmerged`/`merged` state, review decision, timestamps, correction note,
an optional public `scope_note`, verified release-asset evidence, and an optional structured
`pr_disclosure` observation. A scope note is a nullable,
validated, transparent public interpretation of the receipt's scope. It stays in the mutable
publication envelope, is shown separately from the immutable signed limitations, and must not
claim checks absent from the signed command evidence. Ledger builds overlay
that envelope without modifying `mission.json` or any file inside `bundle/`.

During the `prepared` bootstrap stage, `attestation_uri`, `release_asset_sha256`, and
`attestation_verified_at` remain present and must be either all `null` or all populated. The
prepared publication envelope is authoritative over any stale mission-level attestation value;
an all-null envelope renders the asset as not recorded and its provenance as not verified, and
the ledger index reports `attested: false`. Once publication moves to `open`, `closed_unmerged`,
or `merged`, all three fields are required and strictly validated.

The public ledger shows an attributed maintainer decision (`merged`, `approved`, `rejected`, or `closed`) only when the receipt links to that decision; `silent` and `pending` carry no link by nature.

Render the self-contained public ledger and every permanent printable receipt page from an index:

```sh
node bin/ledger.mjs render \
  --index missions/index.json \
  --out site/index.html \
  --now 2026-07-15T00:00:00Z
```

This writes `site/index.html`, `site/ledger.json`, the public schemas under `site/schema/`,
`site/receipts/M-XXX/index.html`, and a minimized, versioned
`site/receipts/M-XXX/receipt.json` summary for every mission. Every page and JSON projection
records the deterministic ledger `generated_at`. The JSON summary excludes raw
patches, output streams, and the mutable publication envelope. The homepage is server-rendered
with an M-008 receipt, newest-first external receipt previews, and a lower collapsed archive for
own-repository rehearsals; JavaScript only
enhances filters and copy buttons. Each page is rendered from the normalized record, includes
verbatim raw commands and limitations, expandable committed redacted stdout/stderr when present,
and print CSS. Schema-v1 pages retain their narrow receipt layout; schema-v2 pages use a wider
summary-first layout with dense economic, technical, and provenance evidence in expandable drawers.
Direct rendering writes every new page
successfully before pruning stale generator-owned `site/receipts/M-XXX/` directories, so a render
error cannot first remove the last complete receipt set. Unrelated site files and receipt
directories are preserved by direct `render` invocations. The CI drift gate is stricter: it
compares the complete committed `site/` tree with a fresh generated tree, so committed `site/`
is currently generator-only. The renderer never reads the network or
the wall clock, uses no external scripts,
stylesheets, fonts, images, or runtime APIs, and works when opened with `file://`.

Future contributor PR disclosure uses at most one short canonical per-receipt
`receipts/M-XXX/` URL in the PR body, not the legacy homepage `#M-XXX` anchor. Do not add a
separate comment unless a maintainer invites one. Existing PR bodies are historical records and
are not rewritten by the ledger generator. This is mechanically enforced for every future
non-prepared `author_contribution` by the independent `ci / pr-disclosure` job; the checked
historical exemption list lives in `policies/pr_receipt_disclosure_policy.json`. The deterministic
ledger builder remains network-free. See [PR receipt disclosure](pr-receipt-disclosure.md) for
the operator and enforcement flow.
