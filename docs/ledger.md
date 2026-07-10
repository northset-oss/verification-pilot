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

The index is sorted by `mission_id` and contains only the public projection documented
by the ledger format. `generated_at` is the exact `--now` value; when the optional flag
is omitted it is `null`, and the builder never reads the wall clock.

The public ledger shows an attributed maintainer decision (`merged`, `approved`, `rejected`, or `closed`) only when the receipt links to that decision; `silent` and `pending` carry no link by nature.

Render a self-contained page from an index:

```sh
node bin/ledger.mjs render \
  --index missions/index.json \
  --out site/index.html \
  --now 2026-07-15T00:00:00Z
```

The renderer never reads the network or the wall clock. It keeps the index's own
`generated_at` in the inlined data; the optional render `--now` flag is accepted for
deterministic build invocations. The output contains inline CSS, inline JSON data, and
an inline vanilla-JavaScript table renderer. It has no runtime fetches, scripts,
stylesheets, fonts, or other external resources and works when opened with `file://`.
