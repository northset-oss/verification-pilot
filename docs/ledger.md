# Public mission ledger

Build the machine-readable ledger from mission directories:

```sh
node bin/ledger.mjs build \
  --missions-dir missions \
  --out missions/index.json \
  --now 2026-07-15T00:00:00Z
```

Each direct child directory is checked for `mission.json`. Receipts are validated with
the mission validator, and invalid receipts are omitted with a warning on standard
error. A successful build exits zero even when it skips receipts. Add `--json` to print
the included and skipped totals as a machine-readable summary.

The index is sorted by `mission_id` and contains the public projection plus a normalized
Proof-of-Pass Receipt view model. For every schema-valid mission, the builder reads the
committed `bundle/run_record.json` and requires exact, one-to-one command parity with
`mission.json:commands_declared`; missing, blank, or mismatched receipt evidence fails the
build rather than producing a partial receipt. `generated_at` is the exact `--now` value;
when the optional flag is omitted it is `null`, and the builder never reads the wall clock.

An optional sibling `publication.json` is a mutable factual envelope for an immutable mission. It
records the direct PR URL and head OID, base/head drift, CI state, merge commit,
`prepared`/`open`/`closed_unmerged`/`merged` state, review decision, timestamps, correction note,
and verified release-asset evidence. Ledger builds overlay
that envelope without modifying `mission.json` or any file inside `bundle/`.

The public ledger shows an attributed maintainer decision (`merged`, `approved`, `rejected`, or `closed`) only when the receipt links to that decision; `silent` and `pending` carry no link by nature.

Render the self-contained public ledger and every permanent printable receipt page from an index:

```sh
node bin/ledger.mjs render \
  --index missions/index.json \
  --out site/index.html \
  --now 2026-07-15T00:00:00Z
```

This writes `site/index.html` plus `site/receipts/M-XXX/index.html` for every mission. The
homepage is server-rendered with an M-008 receipt and receipt previews; JavaScript only
enhances filters and copy buttons. Each page is rendered from the normalized record, includes
verbatim raw commands and limitations, expandable committed redacted stdout/stderr when present,
and print CSS sized for an approximately 80 mm receipt. Direct rendering writes every new page
successfully before pruning stale generator-owned `site/receipts/M-XXX/` directories, so a render
error cannot first remove the last complete receipt set. Unrelated site files and receipt
directories are preserved by direct `render` invocations. The CI drift gate is stricter: it
compares the complete committed `site/` tree with a fresh generated tree, so committed `site/`
is currently generator-only. The renderer never reads the network or
the wall clock, uses no external scripts,
stylesheets, fonts, images, or runtime APIs, and works when opened with `file://`.

Future PR disclosure footers should link to the canonical `receipts/M-XXX/` page, not the legacy
homepage `#M-XXX` anchor. Existing PR bodies are historical records and are not rewritten by the
ledger generator.
