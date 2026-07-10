# Northset OSS Run Records — Claims Boundary

The most useful thing we can offer a maintainer is precision about what our work means, and
equal precision about what it doesn't. This page is that. We hold every public claim we make
against it, word for word — and you should too.

**The line we will not cross, stated once and kept:**

> A Northset run record is evidence of declared execution metadata and artifacts. It is not
> proof of code quality, security, maintainer approval, or production readiness.

## What a run record is

A run record says four plain things, and only these four:

- these declared commands ran — and the pipeline refuses to publish a record unless the declared
  commands are exactly what executed,
- on this declared code — a specific base commit plus the exact change under review,
- in this declared container — identified by its resolved content digest, not a movable tag,
- and produced these declared outputs — captured, redacted for secrets, and cut at a size limit
  (we say when output was truncated).

That is the whole claim.

## What a run record is not

- It is not a judgment that the code is correct, well-designed, or safe.
- It is not a security review or an audit.
- It is not a sign-off, an approval, or a merge recommendation — those are the maintainer's, and
  only the maintainer's.
- It is not a statement that the code is ready to ship.

A passing check is evidence that a command exited successfully in a clean room. It is not
evidence that the code is any good. A run record assists a maintainer's review; it does not
replace it.

## What the signature means — and doesn't

A published run record is signed in GitHub Actions using GitHub artifact attestations and
recorded in a public transparency log. (Signing a record publishes it — the transparency log is
public by design; a private, unsigned result stays between us and you.) Verifying a signed
record confirms the bundle came from our attestation workflow, at a specific commit, and hasn't
been altered:

```
gh attestation verify run-record-<id>.tar.gz \
  --repo northset-oss/verification-pilot \
  --signer-workflow northset-oss/verification-pilot/.github/workflows/attest-bundle.yml
```

That is provenance, and only provenance. It tells you *where the record came from* and that it
is intact — not that the checks passed in any meaningful sense, that the code is safe, or that
the work is good. Whether the record's contents matter is for you to judge.

## About the container

Checks run in a hardened, stock Docker container: non-root, all Linux capabilities dropped,
`no-new-privileges`, a read-only root filesystem, and no network reachable while the declared
checks run. (The earlier dependency-install step does use the network; the record discloses this
as its network policy.) We treat all pull-request code as hostile and review the isolation
adversarially.

We're deliberate here: this is a well-locked-down ordinary container, not a kernel-grade
sandbox. A determined attacker holding a working local-privilege-escalation exploit is a threat
we do not claim to stop. We run untrusted code carefully, and we don't overstate the walls
around it.

## How we talk about outcomes

- A maintainer's merge, approval, rejection, or silence is theirs. When we record an attributed
  decision — merged, approved, rejected, or closed — the record must carry a link to that
  decision; we do not put an unlinked "the maintainer rejected this" on a public page. We report
  it as their decision, never as our result or our endorsement.
- When we run our own pipeline on our own repositories to rehearse it, we label that plainly as
  our own rehearsal, not outside validation, and we don't count it as either.
- We describe what ran. We don't describe what it proves about your code, because that's yours to
  conclude.

## Why we're this careful

This pilot exists because the ecosystem is already full of confident, unverifiable claims about
what agent-written code does. One more overstatement would make us part of the problem. The
worth of a run record is exactly that it claims little and proves that little cleanly — we would
rather under-claim and be trusted than over-claim and be noise.
