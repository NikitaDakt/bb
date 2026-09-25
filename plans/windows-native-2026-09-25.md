# Native Windows parity for current BB

Goal: ship a native Windows 11 x64 build of current BB, retaining desktop, server, daemon, CLI, providers, managed worktrees, plugins, browser, automations, memory, and user workflows without requiring WSL.

Authorization: owner approved implementation after the review of PRs #1426 and #3188. Continue reversible implementation and verification; do not deploy over the working installation or publish a branch without the required explicit authorization.

## Baseline and source

- Current upstream base: 62ec2157834f043ba429891e9804394afd6c8a54 (BB 0.43.4).
- Windows source: e6b387b76a90491ad5d8d67aff7be719d14c1aba (PR #3188).
- Common ancestor: 6cdb4ba6125514b7660332cf311037bc09c82b0e.
- Worktree: /home/bbapp/bb-tools/bb-core-worktrees/windows-native-20260925.
- Source reference #1426 is a fallback for narrower fixes, not an additional blanket merge.

## Contract and acceptance cases

Keep the existing desktop -> server + host-daemon architecture. Windows is a distinct native host. A Linux-hosted server must still handle paths owned by a Windows daemon and vice versa. Preserve current provider APIs, server migrations and plugin contracts.

| Input                                         | Expected result                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Native project at C:/bb-smoke                 | Create project and worktree, run native agent, edit file, observe watcher event and render diff |
| C:/bb smoke/Александр with spaces and Unicode | Same behavior, intact file names, CLI invocation and process cleanup                            |
| Empty project path / filesystem root          | Existing validation error, no provisioning or filesystem writes                                 |

Process lifecycle: closing a Windows window keeps active work available via the tray; explicit Quit stops only owned runtime; attaching to an existing server never acquires permission to kill it. Cancellation must reap owned descendants. Existing macOS/Linux behavior remains intact.

## Execution

- [x] Inspect current installation, upstream status and source Windows branch; pin the base.
- [x] Create isolated worktree; keep existing BB Core worktrees untouched.
- [x] Integrate source changes with a three-way merge, preserving current upstream behavior. Exclude old machine-specific QA evidence and obsolete source-tree paths.
- [ ] Resolve contracts, host paths, process launch/stop, provider launch, terminals and setup hooks. Bump the current daemon protocol once for the new Windows host wire contract.
- [ ] Complete desktop packaging, tray/lifecycle, PATH, browser, file opening, updates and native dependency packaging. Preserve the Linux update path.
- [ ] Add or adapt behavioral checks for the actual gaps. Use current Turbo orchestration and current Vitest shared-worker conventions.
- [ ] Run typechecks and relevant Linux regression suites on remote-test. Diagnose individual failures before broad reruns. Verify each final result against current sources.
- [ ] Build and test Windows artifacts on a Windows-capable executor. Verify real ConPTY, native Codex/Claude, file operations and cleanup on Windows 11.
- [ ] Verify the owner's enabled plugins and configuration migration with isolated data; do not point an old build at the working database.
- [ ] Prepare an installer and an evidence report, including remaining unsupported provider/platform combinations and measured limits. Commit reviewed changes; publishing and replacing the working installation are separate actions.

## Verification surfaces

The initial package checks target @bb/domain, @bb/process-utils, @bb/config, @bb/host-daemon-contract, @bb/host-workspace, @bb/host-watcher, @bb/desktop, @bb/host-daemon, @bb/server, @bb/cli, @get-bb/plugin-sdk and the provider packages. Actual filters and report paths are recorded with each run.

The Windows acceptance run must exercise installed artifacts, including browser integration and lifecycle. Passing simulated-platform unit tests on Linux does not satisfy this gate. Historical QA output from the source PR is context only.

## Environment findings

The current WSL host cannot launch powershell.exe or cmd.exe: bounded probes timed out. The user has native PowerShell 7, Node, Git and Claude installed on Windows. Windows OpenSSH server was not found at the standard path. An accessible Windows validation executor is still required.

The shared Linux build server has 8.5 GB free disk at the initial probe. Keep the configured resource limits and avoid pulling a large Windows/Wine build image without checking capacity. Existing service volumes and unrelated images must remain untouched.

Static review found process-local Windows ownership while teardown runs in a plugin worker. The SDK helper now delegates through the existing worker IPC channel to include daemon-owned provider and terminal roots. A separate-worker regression reproduced the missing cleanup before this change. Native execution, exited roots, other plugin workers' roots and PID reuse remain acceptance gaps; the transport alone does not establish full orphan cleanup.

Cross-worker cleanup cases: a registered daemon child under the workspace is stopped when its provider worker requests removal; on Windows an unregistered child in the same directory survives; an empty or relative cleanup directory is rejected at the daemon boundary. Default grace remains 2000 ms, and explicit zero is valid. POSIX retains its existing working-directory sweep.

Navigation: Semble query "Windows native executable launch process tree termination terminal ConPTY platform support" located apps/host-daemon/src/terminals/terminal-manager.ts, apps/desktop/src/main.ts and packaged-app helpers; exact changed paths come from the pinned source diff.

## Issue #1206 review

The proposal and verification attachment were reviewed on 2026-09-25. They are design inputs, not passing evidence. Their installer references the retired join-code protocol; this port uses the current EnrollmentBootstrap contract. The current upstream already has ownership supervision and moved worktree provisioning into plugins, so those designs must be adapted rather than copied wholesale.

Additional acceptance cases: installed NSIS upgrade and uninstall release owned descendants and preserve user data; native setup hooks stream output and honor timeout/cancellation; paths include spaces, Cyrillic, shell metacharacters and multiple local drives; real NTFS watcher renames; native Node/Electron ABI validation; deterministic provider cancellation; real enabled-provider smoke; all supported workflows on Windows with WSL unavailable. Windows-only skips in Linux runs remain pending Windows gates.

Machine-service cases: adopting a previously enrolled Windows data directory preserves auth/config and installs the server's matching artifact; a missing identity or empty data directory is rejected before installation; stop/uninstall with an unrelated listener or reused PID leaves that process alone and reports the mismatch. With no lifecycle flag, enrollment remains the default. Server move rewrites the existing PowerShell launcher, retaining its environment and persistence method.

Sources:

- https://github.com/get-bb/bb/issues/1206
- https://github.com/user-attachments/files/30864012/Native.Windows.11.support.for.bb.and.bb.Desktop.md
- https://github.com/user-attachments/files/30910457/Native.Windows.11.support.for.bb.and.bb.Desktop.-.Verification.md
