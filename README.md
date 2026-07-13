# Northset OSS Run Records

If you maintain an open-source project, your review queue looks different than it did two years
ago: more pull requests, many AI-assisted, most plausible at a glance. Writing code stopped being
the bottleneck. Deciding which of these actually do what they claim is the work now — and it
lands on you.

We're a small team, and we built one narrow thing to help with that. Not another bot that opens
pull requests — a way to check the work already sitting in your queue.

**The offer.** Point us at a pull request — especially an AI-assisted one — and we run its
declared checks in a locked-down, throwaway container and send you the result: the exact commands
we ran, their results, and the (redacted, size-capped) output. It's free, it's private by
default, and it asks nothing of you in return.

**When you want proof others can check, we sign it.** If you'd like a record anyone can
independently verify — to show a downstream user the work was really run, say — we publish a
signed run record to our [public ledger](https://northset-oss.github.io/verification-pilot/),
with your agreement. Signing uses a public transparency
log, so a signed record is a public one: anyone can then confirm the bundle came from our
attestation workflow at a specific commit and hasn't been altered, without trusting us:

```
gh attestation verify run-record-<id>-<bundle-digest-prefix>.tar.gz \
  --repo northset-oss/verification-pilot \
  --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
```

That proves *provenance* — where the record came from — which is the opposite of "trust us."
What the record *means* is spelled out exactly in our [Claims Boundary](policies/claims_boundary.md),
and we hold every word we say to it.

**What the record is — and isn't.** A run record is evidence of what ran: the declared commands,
on the declared code, in the declared container. The pipeline refuses to publish a record whose
declared commands don't match what actually executed, so the record can't claim something
different from what happened. It is still not a verdict on whether the code is good, safe, or
ready — you stay the judge; the record just means you don't have to reconstruct "what does this
branch actually do" by hand.

**Two things we do, kept separate.** Most of what's above is the first: **verifying work already
in your queue** — running a PR's declared checks, or publishing a signed record about it. That is
strictly consent-first, and every lever is yours:

- Nothing runs until you say so — a label you apply, or a written OK. A disclosure inside a pull
  request isn't us assuming consent.
- You choose the scope: one pull request, or a standing OK for PRs that carry your label.
- The result comes to you privately by default. A signed, publicly-verifiable record — which
  lives in a public transparency log — is created only if you agree to publish one. Signing and
  publishing are your choice, not our default.
- Say "stop" and we stop — we close anything open and don't come back unless you invite us.
- We never comment uninvited, never post into a stranger's issues, and add no promotional
  content.

**The second is ordinary contributing.** When your project opens an issue to contribution — a
`good first issue` or `help wanted` label, an assignment, or an explicit invitation — Northset
may submit a fix under your normal rules, like any contributor: a named person opens the PR, AI
assistance disclosed in your format, small and linked. Alongside our own PR we may publish a
record of *our own work* — the checks we ran on our own change — clearly labeled "Contributor
self-run. Not maintainer verification." It says nothing about your approval or your project's
state, carries at most one plain link, and we remove it from our surfaces on request. Your merge
or rejection is entirely yours, and it's the only thing we treat as the outcome.

If the honest answer is "not interested," that's a complete answer. We thank you and close, and
we don't argue a rejection or criticize maintainers publicly.

**About the sandbox, honestly.** Checks run in a hardened, stock Docker container: non-root, all
Linux capabilities dropped, `no-new-privileges`, a read-only root filesystem, and — while your
checks run — no network. (Installing dependencies, a separate earlier step, does use the network;
every record discloses that.) We treat all pull-request code as hostile and isolate it
accordingly, and we review that isolation adversarially. It is not a kernel-grade sandbox against
a determined privilege-escalation exploit, and we won't pretend otherwise.

**Why we do this.** We're building verification tooling for AI-assisted software work, and the
honest way to build it is under the real constraints maintainers work in. So we won't call it
"giving back" — it's early, unglamorous work alongside the people who feel the problem first. The
tool assists; it doesn't replace you.

**Who we are.** Northset — a small team building verification tooling for AI-assisted software
work. Anything automated we do is clearly labeled as automation; anything about consent or your
relationship with us comes from a person.

**Opt in, opt out, or ask us anything.** Open an issue in this repository or email
oss@northset.ai. Opting out takes effect as soon as we see it, and we'll remove your entries
from the public ledger on request.

---

## The public ledger

Public records appear at **<https://northset-oss.github.io/verification-pilot/>**. Verification work
for a maintainer is consent-first; contributor self-run records cover only Northset's own submitted
changes and do not represent maintainer approval. Immutable run bundles are kept separate from the
mutable `publication.json` envelope that tracks a PR's live status. The first entry is our own-repo
rehearsal ([`missions/M-001`](missions/M-001)), labeled as exactly that.

## Our promises

- [Claims Boundary](policies/claims_boundary.md) — exactly what a run record does and does not establish.
- [Maintainer Respect Policy](policies/maintainer_respect_policy.md) — how we behave in and around your project.
- [Payment Policy](policies/payment_policy.md) — when, how, and — most importantly — what payment is never tied to.

## About this repository

This repo holds the open tooling behind the run records, with no runtime dependencies (pure
Node.js + the built-in test runner):

| Piece | What it does | Docs |
| --- | --- | --- |
| `schema/` + `bin/validate-mission.mjs` | The `mission.json` receipt schema and its policy validator | [docs/schema.md](docs/schema.md) |
| `lib/executor.mjs` + `bin/execute.mjs` | The two-phase, network-isolated Docker sandbox that runs declared checks | [docs/executor.md](docs/executor.md) |
| `lib/bundle.mjs` + `bin/bundle.mjs` | Assembles the redacted run-record bundle and its digest manifest | [docs/bundle.md](docs/bundle.md) |
| `lib/pipeline.mjs` + `bin/run-mission.mjs` | Consent gate → sandbox → bundle → ledger, binding the record to what actually ran | [docs/pipeline.md](docs/pipeline.md) |
| `lib/ledger.mjs` + `bin/ledger.mjs` | Builds the public mission ledger and its static page | [docs/ledger.md](docs/ledger.md) |
| `.github/workflows/attest-bundle.yml` | Signs a bundle with GitHub artifact attestations | [docs/attestation.md](docs/attestation.md) |

Run the test suite with `node --test`.

Everything here — the tooling, the `mission.json` receipt format, and the bundle layout — is
licensed under [Apache-2.0](LICENSE), so you can adopt, implement, or fork the format without
asking us.
