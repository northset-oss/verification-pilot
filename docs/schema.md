# Mission receipt schema v0

`schema/mission.schema.json` is a JSON Schema draft 2020-12 description of a Northset OSS Run Record mission receipt. The dependency-free CLI applies the same structural constraints and the additional receipt policy rules.

## Required fields

| Field | Meaning |
| --- | --- |
| `mission_id` | Mission identifier: `M-` followed by three digits, or `M-E2a` through `M-E2c`. |
| `variant` | `own_repo_rehearsal`, verification-give (`V`), worker-side (`W`), or funder-side (`F`). |
| `claims_tier` | Unique tiers from `R0`–`R2`; may be empty. A tier is an **achieved evidence level**, never an intention — an in-flight mission claims `[]` and adds tiers as their evidence lands. `R3` (deterministic settlement) is not claimable in v0 and will only return together with its required settlement-evidence fields; `R4` is roadmap-only and unrepresentable. |
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

Objects reject undeclared properties. Nested object members are required whenever the object is present and non-null. Free-text policy checks cover disclosure, funding source, counterparty, policy summary, worker identity, declared commands, network policy, and limitations; matching is normalized (case, hyphens, underscores, whitespace), so ordinary spelling variants of banned or settlement wording are still caught.

## Tier, grade, and role policy rules

The validator refuses any receipt whose claims outrun its evidence:

- `TIER_VARIANT` — `R0` only on `own_repo_rehearsal`; `R1`/`R2` only on external variants (`V`, `W`, `F`).
- `R1_EVIDENCE` — claiming `R1` (attested run record) requires non-null `attestation_uri`, `run_record_bundle_digest`, and `environment`.
- `R2_OUTCOME` — claiming `R2` (external decision) requires a maintainer decision: `merged`, `approved`, `rejected`, or `silent`.
- `ATTESTATION_ORIGIN` — a non-null `attestation_uri` must point into this repository (`https://github.com/northset-oss/verification-pilot/…`); nothing else may render as "attested".
- `SIDE_ALTERNATION` / `EXTERNAL_COUNTERPARTY` — `both_sides_disclosed` only on rehearsals; external variants need a real counterparty; rehearsals must have none.
- `GRADE_VARIANT` / `GRADE_OUTCOME_CONSISTENCY` — `B0` only on rehearsals; `B1`/`B+`/`A-`/`A` only on external variants; `B1` requires a reached decision, `B+` requires merged or approved. Use a `null` grade while the outcome is pending.
- `E2_VARIANT` — `M-E2a`–`M-E2c` ids are reserved for funded-bounty (`F`) receipts.
- `PAYMENT_TIMING` — `post_decision_donation` is impossible while the outcome is `pending`.
- `MERGE_CONTINGENT_FORBIDDEN`, `CONSENT_REQUIRED`, `REHEARSAL_LABEL`, `OUTCOME_EVIDENCE_REQUIRED`, `LIMITATIONS_BASELINE`, `BANNED_PHRASES`, `TIER_LANGUAGE` — as before; settlement/on-chain wording is rejected on every v0 receipt since no claimable tier permits it.

## Validation

Run `node bin/validate-mission.mjs <file> [<file> ...]`. Valid inputs produce no text and exit zero. Each violation is written as `<file>: <RULE_ID>: <message>` and causes exit one. Add `--json` for a JSON result containing each file's `valid` flag and error objects.
