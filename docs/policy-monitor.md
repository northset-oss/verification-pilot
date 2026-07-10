# Policy monitor

The policy monitor checks candidate contribution and AI-policy paths in target GitHub
repositories. It records each existing file's Git blob SHA and compares that fresh map with a
stored snapshot. A missing path (`404`) is normal; other GitHub API failures appear as warning
results.

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
the job summary, and exits with status `2` to leave a visible signal. It never commits snapshot
updates.
