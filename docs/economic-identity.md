# Economic identity in Proof-of-Pass receipts

Schema-v2 Proof-of-Pass receipts add a factual economic identity to the existing technical run
record. This is not a second receipt and it is not a valuation. The canonical per-mission URL and
the signed run bundle remain the public verification surface.

## Evidence layers

One receipt combines three deliberately different evidence layers:

1. `bundle/economic.json` is part of the immutable signed bundle. It records issue-level task
   identity, the complete attempt lineage through the current attempt, observed stage timing,
   measured executor usage, enforced resource caps, verified work scope, and public cost facts.
2. `approval.json` is an immutable sibling created only after a human approves the prepared bytes.
   It records the stable operator identity, approval time, approved manifest digest, funding
   identity, and operational caps. It cannot truthfully be placed inside the earlier prepared
   bundle.
3. `publication.json` remains mutable. It records observable upstream PR, CI, decision, and timing
   changes without rewriting either immutable layer.

The ledger requires both `economic.json` and `approval.json` for schema v2. If both are absent, it
renders the existing schema-v1 receipt. A partial upgrade fails closed. Existing signed bundles are
not retrofitted.

## Factuality rules

Every public field must be supported by a recorded observation or a public evidence reference.

- Estimates, value hypotheses, ROI claims, market-rate substitutions, and inferred provider bills
  are forbidden.
- Unknown measurements are `null`; incomplete categories are labeled `partial`, `unpriced`,
  `unavailable`, or `not_observed` as appropriate.
- A cost line is public only. Internal or confidential finance facts do not belong in the public
  receipt.
- Every cost line carries a digest-bound JSON pointer to an artifact under `bundle/`. The artifact,
  digest, and pointed value must all exist when the receipt is built.
- `provider_billed` requires public provider billing evidence plus a recorded amount and currency.
- `calculated_from_usage` requires observed quantity, recorded unit rate, and an immutable rate-card
  digest. `allocated_shared_cost` additionally requires its allocation method.
- If any applicable cost component is missing, `total_economic_cost` must be `null`. A complete
  total is permitted only when the included components are known and all applicable components are
  accounted for. Priced line arithmetic, category subtotals, and the reported total must reconcile
  exactly as decimal values.

For the current contributor lane, `maintainer_payment` is an observed quantity of zero external
transfers. Its amount remains `null`: the fact proves only that Northset did not pay the maintainer.
It says nothing about model, compute, human, or shared-tooling cost.

## Task and attempt identity

The task is the public GitHub issue, identified by a deterministic `TASK-OSS-…` value derived by
the private orchestrator from the normalized `owner/repo#issue` key. A mission ID identifies one
attempt. Attempt sequences begin at 1, are contiguous, and include every earlier task-bound attempt.
Earlier attempts must be terminal; a task that already shipped cannot start another attempt.
The public validator independently recomputes the task ID from the clean GitHub issue URL.

The current receipt reports end-to-end task scope, so discovery and qualification effort are not
silently discarded when authoring begins. Unobserved prior history is not reconstructed.

## Usage semantics

The receipt distinguishes recorded duration from resource consumption and from money:

- discovery, qualification, authoring, and preparation durations come from their producing tools;
- `executor_elapsed_ms` is the measured run-record wall interval;
- `networked_setup_elapsed_ms` is the observed whole phase-A Docker interval, including container
  lifecycle overhead;
- `dependency_install_ms` is `null` until the executor can isolate dependency installation itself;
- `declared_commands_ms` is the sum of recorded declared-command durations;
- `unclassified_executor_ms` is the non-negative residual after declared commands and networked
  setup, labeled as a derived residual rather than install time;
- CPU time and peak RSS remain `null` unless directly measured;
- resource-envelope values are enforced caps, not claims that the resources were consumed.

Model names distinguish requested from actual. If the provider does not return an actual model or
token counters, those fields remain `null`; the configured model name is never copied into an
“actual” field.

## Public projection and visual hierarchy

The v2 page leads with a compact at-a-glance band, then a summary grid, an effort strip, and a
plain-language known/unknown/unpriced section. Dense economic, technical, and provenance evidence
is retained in expandable drawers and the machine-readable `receipt.json`. Upstream outcome stays
visually marked as mutable. Print styles preserve the complete evidence without forcing the screen
view into a long undifferentiated field list.

The formal structures are in
[`economic-identity.schema.json`](../schema/economic-identity.schema.json),
[`approval.schema.json`](../schema/approval.schema.json), and
[`public-receipt.schema.json`](../schema/public-receipt.schema.json). The dependency-free runtime
also enforces cross-file timing, digest, pointer, task, payment, usage, and completeness rules that
JSON Schema alone cannot express.
