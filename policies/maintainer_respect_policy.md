# Northset OSS Run Records — Maintainer Respect Policy

This is our public promise about how we behave in and around your project. It's short on
purpose, and we intend to be held to it. Some of it is enforced by our tooling; the rest is a
commitment we make and you can check us on. We say which is which.

Your pull-request queue is already full, and a lot of what fills it now is machine-generated and
only half-accountable. So our first commitment is the one an automated tool usually won't make
about itself — **we will not add to that pile.** A run record assists your review; it doesn't
replace it. You are the judge.

**Two things we do, kept separate.** Most of this policy is about the first: **verifying work
already in your queue** — running checks on a pull request you point us at, or publishing a
signed record about it. That is strictly consent-first: nothing happens until a maintainer
welcomes it, exactly as described below. The second is ordinary open-source **contributing**:
when your project has opened an issue to contribution (a `good first issue` / `help wanted`
label, an assignment, or an explicit invitation), Northset may submit a fix under your normal
rules — a named person opens the PR, AI assistance disclosed in your format, small and linked.
Alongside our own PR we may publish a record of *our own work* — the checks we ran on our own
change — clearly labeled "Contributor self-run. Not maintainer verification." That record makes
no claim about your approval or your project's state, carries at most one plain link, and we
remove it from our surfaces on request. Your merge or rejection is entirely yours, and it is the
only thing we treat as the outcome.

## What you control

Not a vague "you're in control" — the specific levers, all of them yours:

- **Whether we verify.** We take no action to verify or publish a record about your
  contributors' work — no run on your PRs, no published record about them — until a maintainer
  has said it's welcome. (Our own contribution PRs follow your normal, public contribution
  process, like any contributor.)
- **How far it reaches.** You grant either a single run on one pull request, or a standing OK to
  run declared checks on PRs that carry your label. Never wider than what you granted.
- **What we run.** We run the checks your project already declares, in an isolated container. We
  don't push, we don't change settings, we don't act outside the pull request you pointed us at.
- **Private by default.** The result comes to you privately. A signed, publicly-verifiable
  record — which lives in a public transparency log — is created only if you agree to publish
  one.
- **When it ends.** Say "stop" and we stop — we close anything open, and don't return unless you
  invite us. We'll also remove your entries from the public ledger on request.

## Consent

1. Consent is something you do, not something we infer. Today that means applying the
   `northset-verify` label to a pull request (a standing OK to run its declared checks) or
   approving a specific request from us in writing. A disclosure at pull-request time is never,
   by itself, consent.
2. Whatever you granted, the link to your words is recorded with the run record — and our tooling
   will not bundle an external run record without it. (This is a hard rule in the pipeline, not a
   promise you have to take on faith.)
3. Revocation takes effect as soon as we see it, and needs no reason. There's nothing to
   negotiate and no follow-up unless you start it.

## How we behave

4. When a change involves a pull request, a named person opens it — not a bot account — and AI
   assistance is disclosed in the format your repository asks for. We check your current
   contribution policy before we contact you, so we're following your rules, not last year's.
5. Small, focused diffs. Linked issues. The verification commands listed in the open. No
   promotional content. For our own contributor PR, disclosure uses at most one short canonical
   per-receipt URL in the PR body. We do not post a separate receipt comment unless a maintainer
   invites one. The automated gate is stricter by default and rejects all Northset-authored
   receipt-link comments; an invited exception requires a separately reviewed policy change and
   explicit human authorization. Historical PR bodies are not rewritten.
6. If you reject our work, we thank you and close. We don't contest it, don't argue in public,
   and don't criticize maintainers anywhere.
7. Our default is to verify work already in your queue — running the declared checks on a pull
   request you're already looking at — so we're subtracting effort, not handing you something new
   to review.

## What we send you

8. The result of the declared checks we ran in a hardened, isolated container, with the redacted
   outputs — privately, by default. If you choose to publish a signed record, anyone can then
   check its provenance:
   ```
   gh attestation verify run-record-<id>.tar.gz \
     --repo northset-oss/verification-pilot \
     --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
   ```
   That confirms where the record came from; no one has to trust us for it.
9. It is evidence of what ran, not a verdict on quality or security — and we say exactly that on
   the record itself.

## Money

10. No payment we make is ever tied to whether you merge or approve anything. Right now, during
    this pilot, we aren't moving money at all — see the [Payment Policy](payment_policy.md) for
    the rules that will apply when we do.
