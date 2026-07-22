# Foreign PR run #1 gate checklist

This is a blocking, per-deployment checklist for the first untrusted PR verification run. Executor
unit tests and Docker argv inspection are necessary evidence, not authorization. Every checkbox
below must be checked, have contemporaneous evidence, and be signed by the named operator. A skip,
unknown, verbal assurance, or “accepted residual” substituted for a precondition means **NO-GO**.

Target production runner/daemon: ____________________

Candidate PR and immutable commit: ____________________

Operator: ____________________  Date/time (UTC): ____________________

The approved pilot runner profile is `bin/foreign-runner.mjs` on `sbx >= 0.35.0`, using a fresh
per-job micro-VM and its private Docker daemon. See
[Foreign PR production runner](foreign-production-runner.md). `foreign-runner.mjs gate` produces
an infrastructure decision for whether the team may make foreign-PR offers. Every accepted offer
still requires `foreign-runner.mjs run` to repeat the checks against the exact candidate commit
before code executes.

## Ordered blocking checks

- [ ] **1. The job is isolated and credential-free.** The runner/job has no cloud instance role,
  workload identity, repository write token, SSH key, signing key, Docker credential, or unrelated
  service credential available to the executor, Docker client, container, workspace, or metadata
  service. Evidence (runner template/IAM identity and credential inventory):
  ____________________. **Findings: C1, C3.**

- [ ] **2. Phase-A deployment networking is isolated.** From the actual phase-A container network,
  `169.254.0.0/16` (including `169.254.169.254` IMDS), the host Docker daemon (Unix socket and every
  TCP listener/subnet), runner host/LAN services, and internal/control-plane services are
  unreachable. Only the dependency-fetch path needed for the declared package registries is
  reachable. Record the enforced mechanism and rule/policy identifier:
  ____________________. Acceptable patterns include:

  - IMDSv2 required with response hop-limit 1 for the metadata control, paired with a separate rule
    that blocks Docker, host/LAN, and internal-service reachability;
  - a host or upstream firewall that drops link-local and daemon/internal subnets from container
    egress while permitting only required registry destinations;
  - an egress allowlist proxy limited to the required package registries, with direct container
    egress denied; or
  - a credential-free isolated runner whose network has no route to metadata, daemon, host/LAN, or
    internal services.

  IMDSv2 alone does not close host/LAN or Docker TCP reachability. **Findings: C1, C3.**

- [ ] **3. Isolation is stronger than unremapped stock Docker.** Verify one: Docker
  `userns-remap` is enabled and effective for this daemon; gVisor is the selected runtime; Kata is
  the selected runtime; or the entire job runs in a disposable per-job micro-VM destroyed after the
  run. Merely passing `--user 1000:1000` is insufficient because container uid 1000 equals host uid
  1000 on a stock bind mount. Mechanism plus live evidence:
  ____________________. **Finding: H2.**

- [ ] **4. The bind-mounted workspace has a kernel/filesystem-enforced hard cap.** Place the
  executor temporary workspace on a dedicated hard-capped filesystem or a project-quota'd
  filesystem with byte and inode/file-count limits sized for the job. Verify the quota on the
  actual path used by `mkdtemp`, including a safe rejected-over-limit probe. `--memory`, the 512 MiB
  `/tmp` tmpfs, and the 250 ms workspace watchdog do not cap writes to the host bind mount. Mount,
  quota, and probe evidence: ____________________. **Finding: H1.**

  The approved runner uses a daemon-owned tmpfs volume capped at 1 GiB and 32,768 inodes and keeps
  it mounted for the complete executor lifetime. The gate requires both a byte-over-limit and an
  inode-over-limit probe to fail with `ENOSPC` on that exact mount.

- [ ] **5. Intake owns a quiescent `repo_dir`.** The intake stage creates an immutable clean clone
  or otherwise prevents every concurrent writer from the start of executor preflight until the
  source copy completes. A preflight traversal followed by `fs.cp` is not a race-proof bounded
  copier. Intake procedure and immutable source identifier: ____________________. **Finding: M2.**

- [ ] **6. An external reaper is active and tested.** A supervisor outside the executor identifies
  `northset-executor-a-*` / `northset-executor-b-*` containers and `northset-executor-*` temporary
  workspaces for the job, then kills/removes them after executor crash or `SIGKILL`. Prove this with
  a sacrificial non-foreign job and record cleanup latency and evidence:
  ____________________. In-process `finally` cleanup and Docker `--rm` do not run reliably after
  executor `SIGKILL`. **Finding: M3.**

- [ ] **7. The real-Docker containment battery passes on the production daemon.** Pre-pull the
  production Node image used by the probes, set every additional Docker TCP host/IP in
  `EXECUTOR_DOCKER_DAEMON_PROBE_HOSTS` (probes ports 2375/2376) or exact `host:port` in
  `EXECUTOR_DOCKER_DAEMON_PROBE_TARGETS`, and run on the actual runner. A TCP `DOCKER_HOST` is
  included automatically:

  ```sh
  EXECUTOR_DOCKER_TEST=1 \
  EXECUTOR_DOCKER_IMAGE=<production-node-image> \
  EXECUTOR_DOCKER_DAEMON_PROBE_HOSTS=<additional-daemon-hosts-or-ips> \
  EXECUTOR_DOCKER_DAEMON_PROBE_TARGETS=<additional-host-port-targets> \
  node --test test/sacrificial-boundary.acceptance.test.mjs test/executor.test.mjs
  ```

  The runtime probes must all report `ok`: sanitized environment; phase-A IMDS connect failure;
  phase-A Docker Unix/TCP failure; phase-B no egress; read-only rootfs; uid/gid `1000:1000`;
  setuid control elevates but `no-new-privileges` case does not; and the bounded PID burst hits the
  32-PID limit. **Any skipped runtime probe is a gate failure**, including a skip caused by an
  unavailable Docker daemon. Attach complete TAP output, daemon version/config, runtime, image ID,
  and cgroup mode: ____________________. **Finding: C2; runtime checks also exercise C1, C3, H2.**

  For the approved runner, use `node bin/foreign-runner.mjs gate --json` for infrastructure
  evidence or the candidate-bound `run` command. The wrapper additionally requires phase A to
  reach the declared npm registry while DNS and HTTP to a non-allowlisted host remain denied.

- [ ] **8. The `writable_copy` verification caveat is explicitly accepted or avoided.** Prefer the
  default read-only phase-B workspace. If `writable_copy` is required, record why and accept that a
  command can mutate or create a file, consume it, and restore/remove it before exit without that
  history appearing in the command-boundary manifest. This is a verification-soundness residual,
  not a host-containment control. Decision/evidence: ____________________. **Finding: M1.**

- [ ] **9. Final no-go review is complete.** Reconfirm checks 1–8 against the exact runner, daemon,
  network policy, filesystem, image, and candidate commit that will run. No infrastructure change
  occurred after evidence collection. Final decision: **GO / NO-GO** (circle one).

Final approver: ____________________  Date/time (UTC): ____________________

## Review finding map

| Finding | Gate disposition |
| --- | --- |
| C1 | Checks 1, 2, and 7: metadata must be unreachable; this blocks run #1. |
| C2 | Check 7: production-daemon runtime battery must pass; argv alone is insufficient. |
| C3 | Checks 1, 2, and 7: phase A must not reach Docker TCP, host/LAN, or internal services. |
| H1 | Check 4: bind-mounted workspace requires a hard byte and inode/file-count cap. |
| H2 | Checks 3 and 7: use stronger isolation than unremapped stock Docker and verify runtime posture. |
| M1 | Check 8: within-command mutate/use/restore remains an explicitly accepted soundness residual. |
| M2 | Check 5: intake must hold `repo_dir` quiescent across preflight and copy. |
| M3 | Check 6: an external supervisor must reap containers/workspaces after executor `SIGKILL`. |
