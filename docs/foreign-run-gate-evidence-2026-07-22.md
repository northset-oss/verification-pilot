# Foreign PR offer infrastructure gate evidence — 2026-07-22

Decision: **GO for consent-first foreign-PR offers.** This is not blanket permission to execute a
PR. Each accepted offer must still pass the candidate-bound `foreign-runner.mjs run` command
against the exact approved base commit, config, and patch before foreign code executes.

- Evidence time: `2026-07-22T15:31:15Z`
- Runner source commit: `a197177a2edae7b39b43fe326ba5631156ec16df`
- Runner source SHA-256: `f926efa30ea5664a4bdf109f1c8312a245c85039aff869b9ab603b554824182a`
- Acceptance-test SHA-256: `044217ab69c6ea8474b5d753fe0405d9773fb566385a7ecd2b93bf796085628b`
- `sbx`: `v0.35.0` (`01e01520456e4126a9653471e7072e4d9b280321`)
- Production Docker daemon in the disposable VM: `29.6.1`, cgroup v2
- Production image ID: `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5`
- Gate sandbox ID: `eb651253-0672-4928-9601-8e344539170c` (removed after evidence collection)

## Checklist disposition

1. **PASS — isolated and credential-free.** The job ran in a fresh clone-mode micro-VM. The
   sandbox secret inventory was empty. The clean guest inventory had no GitHub, SSH, cloud,
   Docker, Codex, or model credentials, and the only host source mount was read-only.
2. **PASS — phase-A network isolation.** Effective policy allowed
   `registry.npmjs.org:443` and denied GitHub, OpenRouter, the Docker pull CDN, IMDS/link-local, and
   host/LAN targets. The runtime phase-A probe reached the npm registry while denied DNS/HTTP did
   not. Phase B passed with `--network=none`.
3. **PASS — stronger isolation.** Every job used a fresh Docker Sandbox micro-VM with its own
   kernel and Docker daemon. The host-side wrapper removed the complete VM after the job.
4. **PASS — hard byte and inode cap.** The actual executor `TMPDIR` was a daemon-owned tmpfs with
   `size=1048576k,nr_inodes=32768`. A 1-byte-over allocation failed with `ENOSPC`; file creation
   failed at the inode ceiling with `ENOSPC`.
5. **PASS — quiescent intake.** Intake cloned the exact detached commit, verified a clean tree,
   changed ownership to root, removed every write bit, and proved the executor user could not
   create a writer-probe file. Gate evidence bound commit
   `a197177a2edae7b39b43fe326ba5631156ec16df` to tree
   `8b76ad150c0bf298c347cc2fd9218d0ae89512ff`.
6. **PASS — external reaper.** After an executor-shaped child created
   `northset-executor-a-reaper-probe` plus a `northset-executor-reaper-probe` workspace and was
   killed with `SIGKILL`, the host wrapper identified both leftovers and removed the entire VM in
   `7040 ms`. `sbx ls --json` was empty afterward.
7. **PASS — exact production battery.** The battery completed `71/71`, with `0` failures and `0`
   skips, on the same VM daemon and hard-capped mount named above.
8. **PASS — writable-copy caveat avoided.** The runner refuses any profile other than Node, the
   exact pinned image, or a phase-B workspace mode other than `readonly`.
9. **PASS — final infrastructure review.** Immediately before the SIGKILL/reaper probe, the runner
   rechecked the exact source commit, tmpfs mount, image ID, daemon/cgroup posture, registry allow,
   and GitHub/OpenRouter/IMDS/LAN denies. No sandbox survived the run.

## Candidate-bound smoke

A separate sacrificial run exercised the real `run` path with an immutable base plus an approved
patch. It returned `GO_AND_EXECUTED` and bound these exact inputs before execution:

- config: `sha256:da66ce7972a53f4015da637f21cbc78b82b64d5cce9e9034a13c7f8d29da9e32`
- base commit: `675cd45bc8e210466d6e52612aa3dccfabe53d83`
- patch: `sha256:f4727d6364c99d710b03563dfef7d377f04a6295fe797e0ffe3035a90698d1c1`

The staged input hashes were rechecked in the final review. The patched declared check passed
`1/1`; only `run_record.json`, `stdout.txt`, and `stderr.txt` were copied out; and the micro-VM was
removed in `6248 ms`. No real foreign PR, maintainer contact, GitHub mutation, receipt publication,
or push occurred.

## Operational authorization

- The team may now send a narrow offer to verify a named foreign PR.
- The offer must not imply that code has already run and must preserve private-by-default results.
- Explicit maintainer consent for that PR is required before running it.
- After consent, use only `foreign-runner.mjs run`; any non-`GO_AND_EXECUTED` result is a no-go.
- Publication and every GitHub mutation remain separate human-authorized actions.
