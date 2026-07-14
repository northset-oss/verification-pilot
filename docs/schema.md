# Mission receipt schema v0

Every file under `schema/` uses JSON Schema draft 2020-12. `mission.schema.json` describes the
immutable mission envelope; `publication.schema.json`, `ledger.schema.json`,
`public-receipt.schema.json`, `run-record.schema.json`, and `public-consent.schema.json` describe
the mutable observation envelope and machine-readable evidence surfaces. The dependency-free
runtime applies strict structural and cross-field checks without loading a schema package.

## Required fields

| Field | Meaning |
| --- | --- |
| `mission_id` | Mission identifier: `M-` followed by three digits, or `M-E2a` through `M-E2c`. |
| `variant` | `own_repo_rehearsal`, verification-give (`V`), worker-side (`W`), funder-side (`F`), or `author_contribution` (Northset contributes a fix to an external repo and documents its OWN work — external for tier/grade/side, but consent-exempt because the work is ours). |
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

## Publication envelope and PR disclosure

`publication.json` is the mutable observation envelope for an immutable signed mission. Its
optional `pr_disclosure` object is deliberately absent from the ten historical contributor
receipts. For every future non-prepared `author_contribution`, the live disclosure gate requires:

| Field | Required value |
| --- | --- |
| `schema_version` | `1` |
| `required` | `true` |
| `mode` | `pr_body` |
| `canonical_url` | The exact `https://northset-oss.github.io/verification-pilot/receipts/M-XXX/` URL matching `mission_id` |
| `verified_at` | UTC ISO-8601 timestamp at or after the PR's `opened_at` |

This stored observation is not accepted on trust. The separate CI disclosure job reads the live
PR body and comments, confirms the receipt endpoint, and fails if the remote state no longer
matches. The field is prohibited on a `prepared` publication because there is no PR to observe.

Every publication retains the attestation fields. While `state` is `prepared`,
`attestation_uri`, `release_asset_sha256`, and `attestation_verified_at` must be either all `null`
or all valid and present; partial evidence is rejected. The prepared publication envelope is
authoritative over mission-level attestation metadata, so the all-null form cannot inherit a stale
URI. Generated receipts then state that the asset is not recorded and its provenance is not
verified. For `open`, `closed_unmerged`, and `merged`, all three fields must be non-null and valid.

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
- `CODE_BINDING` / `CODE_IDENTITY` — **the integrity core.** For an honest, clean checkout a
  receipt cannot name code it did not run. The executor derives the actual `source_commit` — but
  only from a **clean** checkout (a dirty/untracked tree yields `null`, since a commit hash lies
  about a modified worktree; git runs hardened, with hooks/fsmonitor/external-config disabled so
  a copied repo cannot execute code on the host), the pre-patch `base_tree_digest`, and the
  applied `patch_sha256`. The pipeline rejects any mission whose declared `base_commit`/
  `patch_diff_hash` disagrees with what ran (both directions), and rejects a declared
  `base_commit` it could not derive (unprovable). `CODE_IDENTITY` additionally requires R1/R2
  receipts to name a `base_commit`. **Honest scope:** this catches accidental and naive
  dirtiness; it is not adversary-proof against an operator who deliberately manipulates the
  input `.git` (index `assume-unchanged`/`skip-worktree`, or `.gitignore`d files a clean
  checkout would not contain). Within our own clean-clone flow that surface does not arise, and
  `base_tree_digest` (which walks the whole tree) captures ignored files for re-runners; the
  signed artifact and its recorded inputs remain auditable, but signing provenance is not
  independent witnessing of execution.
- `CONSENT_REQUIRED` — only variants `V`/`W`/`F` (running checks on someone else's work) require a consent artifact. `author_contribution` is our own work and is consent-exempt; `CONTRIBUTOR_LABEL` requires it to state, as data, "Contributor self-run. Not maintainer verification.", `CONTRIBUTION_BASE_COMMIT` requires it to pin the upstream commit, and `CONTRIBUTION_ROLE`/`CONTRIBUTION_PATCH` require the worker role + a real bound patch so a consent-requiring V/W/F cannot relabel to dodge consent. (The exemption rests on operator discipline — the record never claims maintainer verification regardless — which is acceptable for our own single-operator contributions.)
- `MERGE_CONTINGENT_FORBIDDEN`, `REHEARSAL_LABEL`, `OUTCOME_EVIDENCE_REQUIRED`, `LIMITATIONS_BASELINE`, `BANNED_PHRASES`, `TIER_LANGUAGE` — as before; settlement/on-chain wording is rejected on every v0 receipt since no claimable tier permits it.

## Validation

Run `node bin/validate-mission.mjs <file> [<file> ...]`. Valid inputs produce no text and exit zero. Each violation is written as `<file>: <RULE_ID>: <message>` and causes exit one. Add `--json` for a JSON result containing each file's `valid` flag and error objects.
