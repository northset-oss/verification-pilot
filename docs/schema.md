# Mission receipt schema v0

`schema/mission.schema.json` is a JSON Schema draft 2020-12 description of a Northset OSS Run Record mission receipt. The dependency-free CLI applies the same structural constraints and the additional receipt policy rules.

## Required fields

| Field | Meaning |
| --- | --- |
| `mission_id` | Mission identifier: `M-` followed by three digits, or `M-E2a` through `M-E2c`. |
| `variant` | `own_repo_rehearsal`, verification-give (`V`), worker-side (`W`), or funder-side (`F`). |
| `claims_tier` | One or more unique tiers from `R0` through `R3`; `R4` is not part of v0. |
| `grade` | `B0`, `B1`, `B+`, `A-`, `A`, or `null` while pending. |
| `disclosure_label` | Human-readable disclosure for the run. Rehearsals require the mandated rehearsal sentence. |
| `funding_source` | Human-readable source of mission funding. |
| `northset_role` | `worker_runtime_operator`, `funder`, `verifier`, or `both_sides_disclosed`. |
| `external_counterparty` | Counterparty description, or `null`. |
| `target_repo` | Absolute repository URL. |
| `consent_artifact` | Absolute consent-artifact URL, or `null`; variants `V`, `W`, and `F` require a URL. |
| `commands_declared` | Commands declared for the run; the array may be empty. |
| `maintainer_outcome` | Status, optional outcome URL, and optional ISO-8601/RFC 3339 decision timestamp. |
| `payment` | Maintainer-payment category and a `merge_contingent` flag, which must always be `false`. |
| `limitations` | One or more limitations, including both mandated baseline statements. |

## Optional fields

| Field | Meaning |
| --- | --- |
| `issue_or_task` | Absolute issue or task URL, or `null`. |
| `repo_policy_snapshot` | Policy URL, ISO-8601/RFC 3339 checked timestamp, and AI-policy summary, or `null`. |
| `worker_identity` | Runtime and human-operator descriptions, or `null`. |
| `base_commit`, `patch_commit` | Forty-character hexadecimal commit identifiers, or `null`. |
| `patch_diff_hash` | `sha256:` plus 64 hexadecimal characters, or `null`. |
| `environment` | Container image digest (or `null`) and a network-policy description, or `null`. |
| `run_record_bundle_digest` | `sha256:` plus 64 hexadecimal characters, or `null`. |
| `attestation_uri` | Absolute attestation URL, or `null`. |

Objects reject undeclared properties. Nested object members are required whenever the object is present and non-null. Free-text policy checks cover disclosure, funding source, counterparty, policy summary, worker identity, declared commands, network policy, and limitations.

## Validation

Run `node bin/validate-mission.mjs <file> [<file> ...]`. Valid inputs produce no text and exit zero. Each violation is written as `<file>: <RULE_ID>: <message>` and causes exit one. Add `--json` for a JSON result containing each file's `valid` flag and error objects.
