# Policy monitor

The policy monitor checks candidate contribution and AI-policy paths in target GitHub
repositories, plus selected public policy documents hosted on `docs.github.com`. It records each
existing repository file's Git blob SHA and each document's Markdown representation SHA-256
digest, then compares the fresh maps with a stored snapshot. Requesting Markdown avoids false
alerts when GitHub deploys a new rendered site shell. A missing repository path (`404`) is normal;
other request failures appear as warning results. GitHub credentials are sent only to
`api.github.com`, never to document-page requests.

This is a separate candidate watchlist. It is not ongoing monitoring of every repository named
in the public ledger and is not evidence that a ledger counterparty's policy is unchanged. Future
mission records should preserve their own immutable policy URL or blob SHA.

Run a read-only check:

```sh
node bin/policy-monitor.mjs check \
  --targets policy-monitor/targets.json \
  --state policy-monitor/state.json
```

Add `--json` for the complete report, including unchanged files and warnings. The command exits
with `0` when there are no SHA changes, `2` when a file is changed, new, or removed, and `1` for
bad input or when every API request fails. `GITHUB_TOKEN` is optional; when present, the monitor
sends it as a bearer token for higher API rate limits.

After reviewing an expected change, update the snapshot deliberately:

```sh
node bin/policy-monitor.mjs check \
  --targets policy-monitor/targets.json \
  --state policy-monitor/state.json \
  --write
```

The weekly GitHub Actions workflow uses read-only repository permissions, writes changed keys to
the job summary, uploads the complete JSON report for 90 days, and exits with status `2` to leave
a visible signal. It never commits snapshot updates.
