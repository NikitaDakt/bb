# Windows process cleanup

Windows has no portable Node API for enumerating another process's working directory. Diagnostic listing uses CIM executable paths, command-line paths and recorded spawn directories; results mark approximate paths and their evidence.

Destructive cleanup uses only directories recorded when BB launches a process and descendants of those registered processes. Merely mentioning a workspace in an argument or running an executable stored there does not authorize termination. Termination calls native `taskkill.exe /PID <pid> /T /F`; failures against a live process propagate to the caller.

Launch workspace processes through `spawnPortableProcess` with `cwd`, or register and unregister externally spawned roots, as the ConPTY adapter does. Unregistered processes and descendants whose parent exited before discovery can survive a sweep. PID reuse between enumeration and termination remains a race. Native lifecycle acceptance must exercise cancellation, closed terminals, removed worktrees and daemon shutdown; injected Windows tests on Linux do not establish that acceptance.

The root registry is local to a process. The Plugin SDK host cleanup helper delegates over the existing worker IPC channel on Windows, combining its local roots with the daemon's roots. This covers live provider bridges, their descendants and daemon-owned terminals. A real separate-worker regression exercises that delegation; its Windows branch also checks that an unregistered process in the same directory survives. Native execution is still required. Roots owned exclusively by other plugin workers, and descendants orphaned before enumeration, remain outside this registry. Do not restore termination based only on a matching command-line path to bypass these limitations.

Short path expansion uses `realpathSync.native`; Unicode, case, drive and UNC normalization have injected-platform coverage. Windows-only filesystem tests are explicitly excluded from the Linux evidence and must run on Windows.
