# Sacrificial boundary acceptance evidence

This suite proves properties of the executor boundary without authorizing a foreign-code run. The
normal acceptance path uses Docker argv inspection and injected fake Docker/Git processes; it does
not run hostile fixture code on the host. One safe runtime-environment subtest uses a tiny real
container only when `EXECUTOR_DOCKER_TEST=1`; it runs `env`, not foreign code. The command for the
gate is:

```sh
node --test test/sacrificial-boundary.acceptance.test.mjs test/executor.test.mjs
```

`ALREADY-COVERED` means the executor already enforced the property before this acceptance suite.
`NEWLY-CLOSED` identifies a boundary gap closed by the accompanying executor change.
`ACCEPTED-RESIDUAL` means the stated property holds only inside the documented two-phase boundary;
the remaining exposure is explicit rather than silently described as isolation.

| Fixture class | Disposition | Boundary evidence |
| --- | --- | --- |
| 1. Metadata access | ACCEPTED-RESIDUAL | `buildDockerArgs('phaseB')` adds `--network=none`, covered by `buildDockerArgs encodes both-phase isolation...` in `test/executor.test.mjs` and acceptance test 1. Phase A deliberately uses bridge networking and may reach link-local metadata services where the runner platform exposes them. No host credentials are passed by executor env or mounts, but metadata-issued credentials are not disproved; phase A requires a credential-free runner/network policy. |
| 2. Environment-variable reading | NEWLY-CLOSED | The executor already avoided explicit host-secret `--env` arguments, but image-declared ENV and Docker-client proxy injection were not cleared. Both phases now override the image entrypoint with `/usr/bin/env -i` and start the foreign shell from only fixed executor/profile values. Acceptance test 2 proves the exact clean-environment argv and includes a safe `EXECUTOR_DOCKER_TEST=1` runtime subtest that rejects host canaries, image ENV, and proxy variables. The Docker client process still inherits operator env, but the forced clean entrypoint prevents those values from reaching the foreign shell. |
| 3. Credential discovery | ALREADY-COVERED | `commonRunArgs` emits one explicit bind mount: the disposable workspace. `/tmp` is a new tmpfs. Existing both-phase argv coverage and acceptance test 3 prove no home, SSH, cloud, credential, secret, or env-file mount is supplied. Credentials deliberately committed inside the untrusted repository would be repository bytes, not discovered host credentials. |
| 4. `/var/run/docker.sock` | ALREADY-COVERED | No Docker socket mount exists in `commonRunArgs`; acceptance test 4 checks every phase argv. The container therefore cannot drive the host daemon through the conventional socket. |
| 5. Host mounts | ALREADY-COVERED | `execute` copies `repo_dir` to a `northset-executor-*` temporary workspace and mounts only that copy. `buildDockerArgs encodes both-phase isolation...` already proves original source/patch paths are absent; acceptance test 5 observes the generated temporary source, sole bind mount, capped tmpfs, and final temporary-root removal. |
| 6. Outbound HTTP during checks | ACCEPTED-RESIDUAL | Phase B has `--network=none`, proved by existing phase separation tests and acceptance test 6. Phase A bridge egress is intentional for dependency installation and remains an accepted exposure with fixed foreign-command env and only the disposable repository copy. It can still reach platform metadata where the runner network permits it. |
| 7. DNS exfiltration during checks | ACCEPTED-RESIDUAL | Phase B has `--network=none` and no DNS override, proved by acceptance test 7. Phase A DNS/network access is the same explicit setup residual as outbound HTTP. |
| 8. Process explosion | ALREADY-COVERED | `commonRunArgs` passes the validated positive integer `limits.pids` as `--pids-limit` in both phases. Existing `assertSecurityArgs` coverage and acceptance test 8 prove the configured bound is present; the suite does not launch a fork bomb. |
| 9. Disk exhaustion | NEWLY-CLOSED | Both phases already received a 512 MiB `/tmp` tmpfs cap, and writable phases already had the workspace watchdog/final check. The gap was copying an already-oversized foreign checkout before enforcement. `execute` now rejects a symlink/non-directory source, preflights bytes without following symlinks before copying, and rechecks the copy before Git or Docker. Acceptance test 9 proves pre-copy rejection plus an event-driven watchdog kill on a safe 2 KiB runtime breach. The watchdog sampling interval and a concurrent source-mutation race remain documented residuals. |
| 10. File-count exhaustion | NEWLY-CLOSED | `enforceWorkspaceSize` already counted entries without following symlinks and aborted runtime breaches, but initial source count was unchecked before copying. The same new source preflight and immediate post-copy check now enforce `workspace_file_count` before Docker. The existing writable-copy case and acceptance test 10 prove both runtime and pre-copy breaches abort. A concurrent source-mutation race is not claimed closed by the preflight. |
| 11. Output flooding | ALREADY-COVERED | `LimitedCapture` retains at most `output_bytes_per_stream` bytes independently for stdout and stderr, then records `[TRUNCATED]`. Phase-A utility capture is separately capped at 64 KiB. Existing `stream output is truncated...` coverage and acceptance test 11 prove the byte bound and marker. No executor change was required. |
| 12. Symlink escape | ALREADY-COVERED | Patch paths are normalized, checked component-by-component with `lstat`, and rejected if a component is a symlink; patch-created symlink modes are also rejected before worktree application. Existing source-symlink and patch-symlink adversarial tests plus acceptance test 12 prove the external target is untouched and Docker never starts. Final writable-workspace manifests also reject new/changed symlinks. |
| 13. Cross-job persistence | ALREADY-COVERED | `execute` assigns a distinct container name to each declared command; every run uses `--rm`, read-only rootfs, and a fresh `/tmp` tmpfs. Existing multi-command/cleanup tests and acceptance test 13 prove two commands use two ephemeral containers. The workspace is intentionally shared within one execution and is addressed separately below. |
| 14. Cross-job artifact access | NEWLY-CLOSED | Separate `execute` calls already created and removed distinct temporary workspaces, and default phase B already mounted the shared workspace read-only. The gap was `writable_copy`: final-only validation let one command create a forbidden artifact or tracked mutation for a later command to consume and then hide. `lib/executor.mjs` now validates the manifest after every command and aborts before the next container on tracked changes, mode changes, unapproved paths, or new symlinks. Acceptance test 14 proves an unapproved artifact never reaches command 2, an allowlisted artifact may cross by design, and no artifact reaches a fresh execution job. A mutation created and restored entirely within one command remains the documented final-state-at-command-boundary residual. |
| Archive-parsing bypass | ALREADY-COVERED | N/A to executor extraction. Investigation of `lib/` found no tar/zip extraction in `lib/executor.mjs`: repository archives are opaque bytes copied into the disposable workspace. Acceptance test 15 constructs a valid tar with `../`, absolute-path, and escaping-symlink members, proves the copied archive is byte-identical, and leaves the external sentinel untouched. `lib/signing-handoff.mjs` separately parses (does not extract) handoff tarballs, requires canonical `bundle/` paths and regular-file/directory member types, and rejects unsafe/duplicate paths and symlink member types; that path is not invoked by setup or declared checks. Archive tools run by foreign commands remain confined to their phase's container/workspace boundary. |

## Properties not proved

- This suite does not prove resistance to a container/kernel escape. The documented stock-Docker
  isolation ceiling (no user-namespace remap, gVisor, or Kata) remains unchanged.
- It does not prove phase-A network isolation. Phase A intentionally has bridge egress. The proof is
  that no host environment secrets or credential mounts are passed to the foreign shell, not that a
  malicious lifecycle script cannot obtain platform metadata credentials where exposed or send the
  repository bytes or dependency-derived data.
- It does not claim full per-command workspace isolation in `writable_copy`; allowlisted outputs are
  intentionally visible to later commands, and changes restored before a command exits are not
  represented in its boundary manifest.
- The workspace watchdog is not a filesystem quota. A burst may exceed a configured byte or file
  limit between 250 ms samples before the named container is stopped.
- Source preflight is not a race-proof bounded copier. A concurrent actor that mutates `repo_dir`
  between/during preflight and copy can temporarily exceed the cap before the immediate post-copy
  rejection and cleanup. Normal clean-clone intake must keep that source quiescent.
- Docker argv proves the requested Docker posture. This suite does not independently certify daemon
  configuration, default seccomp correctness, or the security of the pinned container image/kernel.
