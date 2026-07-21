# Sacrificial boundary acceptance evidence

This suite proves host-side executor logic and the Docker argv it emits without authorizing a
foreign-code run. The default path uses argv inspection and injected fake Docker/Git processes; it
does not prove that a daemon or kernel enforced those arguments. When `EXECUTOR_DOCKER_TEST=1`, a
bounded real-Docker battery launches purpose-built probes for environment sanitization, phase-A
metadata and Docker-daemon reachability, phase-B egress, rootfs write protection, runtime identity,
`no-new-privileges`, and PID enforcement. The command for the default evidence suite is:

```sh
node --test test/sacrificial-boundary.acceptance.test.mjs test/executor.test.mjs
```

`ALREADY-COVERED` means the executor already enforced the property before this acceptance suite.
`NEWLY-CLOSED` identifies a boundary gap closed by the accompanying executor change.
`RESIDUAL (accepted)` is an explicit limitation accepted only after the required deployment controls
are present, with the reason stated below. `REQUIRED-PRECONDITION (blocks foreign-run #1)` is not
provided by this executor and must be enforced and verified before any foreign PR is run. See
[`foreign-run-gate-checklist.md`](foreign-run-gate-checklist.md) for the operational gate.

| Fixture class | Disposition | Boundary evidence |
| --- | --- | --- |
| 1. Metadata access | REQUIRED-PRECONDITION (blocks foreign-run #1) | Acceptance test 1 proves phase B argv only. Phase A uses bridge networking, so deployment isolation must make `169.254.169.254` unreachable. The gated real-Docker metadata probe must pass on the production daemon. The campaign requirement is “metadata fails”; reachability is not an accepted residual. |
| 2. Environment-variable reading | NEWLY-CLOSED | The executor already avoided explicit host-secret `--env` arguments, but image-declared ENV and Docker-client proxy injection were not cleared. Both phases now override the image entrypoint with `/usr/bin/env -i` and start the foreign shell from only fixed executor/profile values. Acceptance test 2 proves the exact clean-environment argv and includes a safe `EXECUTOR_DOCKER_TEST=1` runtime subtest that rejects host canaries, image ENV, and proxy variables. The Docker client process still inherits operator env, but the forced clean entrypoint prevents those values from reaching the foreign shell. |
| 3. Credential discovery | ALREADY-COVERED | `commonRunArgs` emits one explicit bind mount: the disposable workspace. `/tmp` is a new tmpfs. Existing both-phase argv coverage and acceptance test 3 prove no home, SSH, cloud, credential, secret, or env-file mount is supplied. Credentials deliberately committed inside the untrusted repository would be repository bytes, not discovered host credentials. |
| 4. `/var/run/docker.sock` | ALREADY-COVERED | No Docker socket mount exists in `commonRunArgs`; acceptance test 4 checks every phase argv. The gated real-Docker probe also checks that the conventional socket is absent. Phase-A access to a Docker TCP listener is a deployment-network precondition under fixture class 6, not proved by mount argv. |
| 5. Host mounts | ALREADY-COVERED | `execute` copies `repo_dir` to a `northset-executor-*` temporary workspace and mounts only that copy. `buildDockerArgs encodes both-phase isolation...` already proves original source/patch paths are absent; acceptance test 5 observes the generated temporary source, sole bind mount, capped tmpfs, and final temporary-root removal. |
| 6. Outbound HTTP during checks | ALREADY-COVERED (phase B); REQUIRED-PRECONDITION (phase A, blocks foreign-run #1) | Phase B emits `--network=none`, proved by acceptance test 6 and the gated runtime no-egress probe. Phase A needs package-registry egress, but deployment isolation must prevent access to IMDS, the host/LAN, Docker TCP listeners, and internal services. This is not an accepted residual. |
| 7. DNS exfiltration during checks | ALREADY-COVERED (phase B); REQUIRED-PRECONDITION (phase A, blocks foreign-run #1) | Phase B emits `--network=none` and no DNS override, proved by acceptance test 7 and the gated runtime no-egress probe. Phase-A DNS/egress must be constrained by the same deployment network policy as fixture class 6; unrestricted bridge DNS/egress is not accepted. |
| 8. Process explosion | ALREADY-COVERED | `commonRunArgs` passes the validated positive integer `limits.pids` as `--pids-limit` in both phases. Acceptance test 8 proves argv and the gated real-Docker test launches only 48 short-lived child attempts under a 32-PID cap and requires the cgroup limit to stop the burst. |
| 9. Disk exhaustion | NEWLY-CLOSED (executor preflight/watchdog); REQUIRED-PRECONDITION (host quota, blocks foreign-run #1) | Both phases receive a 512 MiB `/tmp` tmpfs cap. `execute` rejects an initially oversized source and monitors the workspace, and acceptance test 9 proves those executor checks. The bind-mounted workspace is outside `--memory`; a hard-capped or project-quota'd backing filesystem is required because a burst between 250 ms samples can exhaust host resources. |
| 10. File-count exhaustion | NEWLY-CLOSED (executor preflight/watchdog); REQUIRED-PRECONDITION (quiescent intake and host quota, blocks foreign-run #1) | Source preflight, post-copy enforcement, and the runtime watchdog reject count breaches. Intake must keep `repo_dir` quiescent across preflight and copy, and the backing filesystem must enforce its own project/file-count limit; the executor traversal is neither a race-proof copier nor a filesystem quota. |
| 11. Output flooding | ALREADY-COVERED | `LimitedCapture` retains at most `output_bytes_per_stream` bytes independently for stdout and stderr, then records `[TRUNCATED]`. Phase-A utility capture is separately capped at 64 KiB. Existing `stream output is truncated...` coverage and acceptance test 11 prove the byte bound and marker. No executor change was required. |
| 12. Symlink escape | ALREADY-COVERED | Patch paths are normalized, checked component-by-component with `lstat`, and rejected if a component is a symlink; patch-created symlink modes are also rejected before worktree application. Existing source-symlink and patch-symlink adversarial tests plus acceptance test 12 prove the external target is untouched and Docker never starts. Final writable-workspace manifests also reject new/changed symlinks. |
| 13. Cross-job persistence | ALREADY-COVERED | `execute` assigns a distinct container name to each declared command; every run uses `--rm`, read-only rootfs, and a fresh `/tmp` tmpfs. Existing multi-command/cleanup tests and acceptance test 13 prove two commands use two ephemeral containers. The workspace is intentionally shared within one execution and is addressed separately below. |
| 14. Cross-job artifact access | NEWLY-CLOSED; RESIDUAL (accepted) for within-command restore | Separate `execute` calls create and remove distinct temporary workspaces, and default phase B mounts the workspace read-only. In `writable_copy`, manifests are checked after every command, so an unapproved artifact cannot reach command 2. A command can still create or mutate a file, consume it, and restore it before exit; this verification-soundness caveat is accepted because manifests intentionally enforce command-boundary final state, not syscall history. Prefer `readonly`, and use `writable_copy` only when declared outputs require it. |
| Archive-parsing bypass | ALREADY-COVERED | N/A to executor extraction. Investigation of `lib/` found no tar/zip extraction in `lib/executor.mjs`: repository archives are opaque bytes copied into the disposable workspace. Acceptance test 15 constructs a valid tar with `../`, absolute-path, and escaping-symlink members, proves the copied archive is byte-identical, and leaves the external sentinel untouched. `lib/signing-handoff.mjs` separately parses (does not extract) handoff tarballs, requires canonical `bundle/` paths and regular-file/directory member types, and rejects unsafe/duplicate paths and symlink member types; that path is not invoked by setup or declared checks. Archive tools run by foreign commands remain confined to their phase's container/workspace boundary. |

## Residuals and preconditions

- **PRECONDITION (blocks foreign-run #1):** phase-A deployment networking must make IMDS, host/LAN
  services, internal services, and Docker daemon endpoints unreachable while permitting only the
  required dependency-fetch path. Fixed container environment and mount argv do not substitute for
  this control.
- **PRECONDITION (blocks foreign-run #1):** the production deployment must use userns-remap, gVisor,
  Kata, or a disposable per-job micro-VM. Stock Docker without user namespace remapping is not
  accepted because container uid 1000 otherwise equals host uid 1000 on the bind mount.
- **PRECONDITION (blocks foreign-run #1):** the workspace must live on a hard-capped or project-quota'd
  filesystem, intake must keep `repo_dir` quiescent from preflight through copy, and an external
  reaper must remove named executor containers and temporary workspaces after executor `SIGKILL`.
- **PRECONDITION (blocks foreign-run #1):** every gated real-Docker test must pass against the actual
  production daemon. The default skipped path proves logic and argv only, not kernel enforcement,
  daemon policy, seccomp behavior, or cgroup behavior.
- **RESIDUAL (accepted):** no acceptance battery proves the absence of every kernel, runtime, or
  hypervisor escape. After the stronger-isolation, credential-free, network, and disposal
  preconditions above are verified, that remaining platform escape ceiling is accepted as the
  unavoidable limit of this test suite, not as permission to use unremapped stock Docker.
- **RESIDUAL (accepted):** `writable_copy` validates final state at each command boundary, so a
  mutation created, used, and restored within one command is invisible. This is accepted as a
  verification-soundness caveat because syscall-history enforcement is outside this executor; use
  the default `readonly` mode whenever checks do not require declared writable outputs.
