# Northset OSS Run Records

**Free, private, consent-first checks for the pull requests already in your queue — plus the open-source tooling behind them.** Point us at a PR (especially an AI-assisted one) and we run *its own declared checks* in a locked-down, throwaway container, then send you exactly what ran. Prefer to run the whole thing yourself? It's all in this repo — Apache-2.0, no package dependencies.

If you maintain an open-source project, your review queue looks different than it did two years
ago: more pull requests, many AI-assisted, most plausible at a glance. Writing code stopped being
the bottleneck. Deciding which of these actually do what they claim is the work now — and it
lands on you.

We're a small team, and we built one narrow thing to help with that. Not another bot that opens
pull requests — a way to check the work already sitting in your queue.

## A few words we use

- **Declared checks** — the commands your project already runs on a change: its tests, linter,
  type-check, build. We run those, not checks of our own invention.
- **Run record** — the receipt from a run: evidence of *what ran* (the declared commands, the
  code, the container, the outputs). It is not a verdict on whether the code is good.
- **Mission** — one such run, described by a `mission.json` that records the declared code,
  container, and commands. The pipeline checks those declarations against the executor record.

## How it works

1. **You invite us.** [Email a private request](mailto:oss@northset.ai) or
   [open a public run request](https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml)
   and point us at a PR. For a repo already onboarded with Northset, applying the
   `northset-verify` label to a PR requests a run on that PR. Nothing runs before that; a
   disclosure inside a PR is never, by itself, consent.
2. **We run its declared checks** in a hardened, network-isolated, throwaway container.
3. **You get the result privately** — the exact commands, their outcomes, and the redacted,
   size-capped output. A signed, publicly-verifiable copy is published **only if you ask for one.**

## Ask us to check a PR

- **Private route:** [email oss@northset.ai](mailto:oss@northset.ai) and point us at the PR.
- **Public route:** [open the dedicated run-request form](https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml).
  The issue is public, so do not include secrets or private repository details.
- **Already onboarded:** apply **`northset-verify`** to the specific PR you want checked. That
  label requests a run on that PR; it is not blanket or standing consent for other PRs. Remove
  the label, or just say "stop," and we stop.

Either way it's **free**, the result comes back to you **privately by default**, and it **asks
nothing of you in return**. You choose the scope for each requested PR, and you decide whether
any record is ever made public. The operator-side consent handling for public forms, private
email, and per-PR labels is documented in [Run-request intake](docs/run-request-intake.md).

**Why not just read your own CI?** Because a signed run record is portable in a way a CI dashboard
isn't: a downstream user can verify the exact record bytes, their workflow provenance, and the
declared commands, code identifiers, environment, and outputs without relying on a mutable
dashboard. Execution remains self-operated and self-reported; the signer does not independently
witness it. And because it lands on the PRs you're already triaging,
it subtracts review effort rather than adding one more tool to babysit.

**When you want proof others can check, we sign it.** If you'd like a record anyone can
independently verify — to show a downstream user the work was really run, say — we publish a
signed run record to our [public ledger](https://northset-oss.github.io/verification-pilot/),
with your agreement. Signing writes to a public transparency log (Sigstore/Rekor), so a signed
record is a public one: anyone can then confirm the bundle came from our attestation workflow at
a specific commit and hasn't been altered, without trusting us. Grab any bundle from the ledger
(the **Attested** links) and check it yourself:

```
gh attestation verify run-record-M-031-5a774731726a.tar.gz \
  --repo northset-oss/verification-pilot \
  --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
```

That proves *provenance* — where the record came from — which is the opposite of "trust us."
What the record *means* is spelled out exactly in our [Claims Boundary](policies/claims_boundary.md),
and we hold every word we say to it.

**What the record is — and isn't.** A run record is evidence of what ran: the declared commands,
on the declared code, in the declared container. The pipeline refuses to publish a record whose
declared commands don't match what actually executed, so the record can't claim something
different from the executor record. This is an internal consistency check, not independent
observation of the run. It is still not a verdict on whether the code is good, safe, or
ready — you stay the judge; the record just means you don't have to reconstruct "what does this
branch actually do" by hand.

**Consent-first, and every lever is yours.**

- Nothing runs until you say so — the `northset-verify` label, or a written OK.
- You choose the scope for each pull request you submit or label.
- The result comes to you privately by default. A signed, publicly-verifiable record — which
  lives in a public transparency log — is created only if you agree to publish one.
- Say "stop" and we stop — we close anything open and don't come back unless you invite us.
- We never comment uninvited, never post into a stranger's issues, and add no promotional
  content. A future contributor PR may include at most one short canonical receipt URL in its
  body; we post no separate receipt comment unless a maintainer invites one.

**We also contribute, like anyone.** Separately from all of the above: when your project opens an
issue to contribution — a `good first issue` or `help wanted` label, an assignment, or an
explicit invitation — Northset may submit a fix under your normal rules, like any contributor: a
named person opens the PR, AI assistance disclosed in your format, small and linked. Alongside
our own PR we may publish a record of *our own work* — the checks we ran on our own change —
clearly labeled "Contributor self-run. Not maintainer verification." It says nothing about your
approval or your project's state, carries at most one plain link, and we remove it from our
surfaces on request. Your merge or rejection is entirely yours, and it's the only thing we treat
as the outcome.

If the honest answer is "not interested," that's a complete answer. We thank you and close, and
we don't argue a rejection or criticize maintainers publicly.

**About the sandbox, honestly.** Checks run in a hardened, stock Docker container: non-root, all
Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, and — while your
checks run — no network. (Installing dependencies, a separate earlier step, does use the network;
every record discloses that.) We treat all pull-request code as hostile and isolate it
accordingly, and we review that isolation adversarially. It is not a kernel-grade sandbox against
a determined privilege-escalation exploit, and we won't pretend otherwise.

**About money.** It's free to you. During this pilot we aren't moving money at all — no payments,
no honoraria, no bounties. The [Payment Policy](policies/payment_policy.md) is the rule set for if
that ever changes, and its first rule is the important one: nothing we pay is ever tied to whether
you merge.

**Why we do this.** We're building verification tooling for AI-assisted software work, and the
honest way to build it is under the real constraints maintainers work in. So we won't call it
"giving back" — it's early, unglamorous work alongside the people who feel the problem first. The
tool assists; it doesn't replace you.

**Who we are.** Northset — a small team building verification tooling for AI-assisted software
work. Anything automated we do is clearly labeled as automation; anything about consent or your
relationship with us comes from a person.

**Opt in, opt out, or ask us anything.** [Email a private request](mailto:oss@northset.ai) or
[open the public run-request form](https://github.com/northset-oss/verification-pilot/issues/new?template=request-a-run.yml).
Opting out takes effect as soon as we see it, and we'll remove your entries from the public
ledger on request.

---

## Run it yourself

The whole pipeline is in this repo — Apache-2.0, with no package dependencies (pure Node.js and
its built-in test runner). Running the tests needs only Node; producing a real run record also
needs Docker, since the sandbox is a container.

**Prerequisites:** Node.js ≥ 20 (and Docker to produce a record).

```sh
node --test          # run the test suite — Node only, no Docker
```

To produce a run record, `bin/run-mission.mjs` takes a *mission-input* JSON file and runs the
consent gate → sandbox → bundle → ledger pipeline:

```sh
node bin/run-mission.mjs <mission-input.json> --missions-dir missions
```

The mission-input is a wrapper — a mission receipt plus the repository path and executor config;
its full shape and every flag (including the optional `--site`, which re-renders the ledger page)
are documented in [docs/pipeline.md](docs/pipeline.md). [`examples/`](examples/) holds sample
`mission.json` receipts — the inner object that wrapper carries — and each piece of the pipeline
has its own page under [`docs/`](docs/) (the table below). Signing happens separately, in GitHub
Actions — the pipeline itself never contacts GitHub.

A fresh execution rejects any pre-existing attestation and writes the new mission envelope with
`run_record_bundle_digest` and `attestation_uri` set to `null`. Those fields remain pending until
the new bundle is signed and its publication metadata is recorded.

## Proof-of-Pass Receipts

Public records appear at **<https://northset-oss.github.io/verification-pilot/>**. Verification work
for a maintainer is consent-first; contributor self-run records cover only Northset's own submitted
changes and do not represent maintainer approval. Immutable run bundles are kept separate from the
mutable `publication.json` envelope that tracks a PR's live status. The first entry is our own-repo
rehearsal ([`missions/M-001`](missions/M-001)), labeled as exactly that.

The ledger is an index of printable, permanent Proof-of-Pass Receipts. Each receipt shows the
verbatim declared commands and exit statuses from its committed run record, the recorded code and
environment, the source limitations, bundle provenance, and (separately) any linked live upstream
outcome. A pass is scoped to those declared commands; it is not a statement that the code is good,
secure, fully tested, maintainer-approved, or production-ready.

New contributor receipts also carry a factual **economic identity** in the same canonical receipt:
the issue-level task and complete attempt lineage, observed stage effort, measured executor usage,
enforced resource caps, verified change scope, explicit human approval, and public cost evidence
when it actually exists. Unknown model usage, compute, human effort, rates, or costs remain visibly
unknown; estimates and value/ROI claims are not accepted. A recorded zero maintainer payment means
only that no external maintainer payment occurred, never that the work cost zero. See
[Economic identity in Proof-of-Pass receipts](docs/economic-identity.md).

For future Northset-authored contributions, publication is fail-closed on the PR disclosure
rule: the live receipt must return `200`, its exact canonical URL must appear once in the PR
body, no legacy ledger anchor or second Northset ledger link may appear there, and configured
Northset accounts must not post the receipt as a separate PR comment. The ten receipts published
before this gate are explicitly listed as historical exemptions and are never rewritten by the
checker. See [PR receipt disclosure](docs/pr-receipt-disclosure.md).

## Our promises

- [Claims Boundary](policies/claims_boundary.md) — exactly what a run record does and does not establish.
- [Maintainer Respect Policy](policies/maintainer_respect_policy.md) — how we behave in and around your project.
- [Payment Policy](policies/payment_policy.md) — when, how, and — most importantly — what payment is never tied to.

## About this repository

This repo holds the open tooling behind the run records, with no runtime dependencies (pure
Node.js + the built-in test runner):

| Piece | What it does | Docs |
| --- | --- | --- |
| `schema/` + `bin/validate-mission.mjs` | Versioned mission, publication, ledger, public receipt, economic identity, approval, consent, and run-record schemas plus policy validation | [docs/schema.md](docs/schema.md) |
| `lib/executor.mjs` + `bin/execute.mjs` | The two-phase, network-isolated Docker sandbox that runs declared checks | [docs/executor.md](docs/executor.md) |
| `lib/bundle.mjs` + `bin/bundle.mjs` | Assembles the redacted run-record bundle and its digest manifest | [docs/bundle.md](docs/bundle.md) |
| `lib/pipeline.mjs` + `bin/run-mission.mjs` | Consent gate → sandbox → bundle → ledger, binding the record to what actually ran | [docs/pipeline.md](docs/pipeline.md) |
| `lib/ledger.mjs` + `bin/ledger.mjs` | Builds the public mission ledger and its static page | [docs/ledger.md](docs/ledger.md) |
| `lib/economic-identity.mjs` | Validates, finalizes, and projects factual task economics | [docs/economic-identity.md](docs/economic-identity.md) |
| `lib/pr-receipt-disclosure.mjs` + `bin/pr-receipt-disclosure.mjs` | Checks and safely synchronizes the one-link contributor PR-body disclosure | [docs/pr-receipt-disclosure.md](docs/pr-receipt-disclosure.md) |
| `lib/signing-handoff.mjs` + `bin/signing-handoff.mjs` | Packages zero-to-50 HEAD-tree bundles and independently verifies their range, archive contents, and exact bytes while retaining one artifact per receipt | [docs/attestation.md](docs/attestation.md) |
| `.github/workflows/attest-bundle.yml` | Attests exact per-mission bundles together, then publishes each under its receipt-specific release | [docs/attestation.md](docs/attestation.md) |

Run the test suite with `node --test`.

Everything here — the tooling, the `mission.json` receipt format, and the bundle layout — is
licensed under [Apache-2.0](LICENSE), so you can adopt, implement, or fork the format without
asking us.
