import childProcess from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "win32") throw new Error("Windows is required");
mkdirSync(".rt/windows-native", { recursive: true });
const logPath = ".rt/windows-native/lifecycle-diagnostic.jsonl";
const log = (event, details) => {
  const line = JSON.stringify({ at: Date.now(), event, ...details });
  appendFileSync(logPath, line + "\n");
  console.log(line);
};
const nativeSpawn = childProcess.spawn;
const nativeSpawnSync = childProcess.spawnSync;
const owned = [];
childProcess.spawn = function (command, args, options) {
  const child = nativeSpawn.call(this, command, args, options);
  if (/bash\.exe$/iu.test(command)) {
    owned.push(child);
    log("spawn", { command, args, pid: child.pid, cwd: options?.cwd });
    child.on("error", (error) =>
      log("error", { pid: child.pid, message: error.message }),
    );
    child.on("exit", (code, signal) =>
      log("exit", { pid: child.pid, code, signal }),
    );
    child.on("close", (code, signal) =>
      log("close", { pid: child.pid, code, signal }),
    );
    child.stdout?.on("end", () => log("stdout-end", { pid: child.pid }));
    child.stderr?.on("end", () => log("stderr-end", { pid: child.pid }));
  }
  return child;
};
childProcess.spawnSync = function (command, args, options) {
  if (!/taskkill\.exe$/iu.test(command))
    return nativeSpawnSync.call(this, command, args, options);
  const result = nativeSpawnSync.call(this, command, args, {
    ...options,
    stdio: "pipe",
    encoding: "utf8",
  });
  log("taskkill", {
    command,
    args,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  return result;
};
syncBuiltinESMExports();
const { runSetupScript } =
  await import("../apps/host-daemon/src/environment-lifecycle-script.ts");
const system32 = join(process.env.SystemRoot, "System32");
const powershell = join(system32, "WindowsPowerShell/v1.0/powershell.exe");
function snapshot() {
  const result = nativeSpawnSync(
    powershell,
    [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  const rows = JSON.parse(result.stdout);
  const ids = new Set(owned.map((child) => child.pid));
  for (let pass = 0; pass < rows.length; pass++)
    for (const row of rows)
      if (ids.has(row.ParentProcessId)) ids.add(row.ProcessId);
  const tree = rows.filter((row) => ids.has(row.ProcessId));
  log("process-tree", { tree });
  return tree;
}
for (const mode of ["timeout", "abort"]) {
  const workspacePath = mkdtempSync(join(tmpdir(), "bb-lifecycle-diagnostic-"));
  const controller = new AbortController();
  writeFileSync(
    join(workspacePath, ".bb-env-setup.sh"),
    "echo started\nsleep 120\n",
  );
  log("begin", { mode });
  let settled = false;
  const running = runSetupScript({
    workspacePath,
    timeoutMs: mode === "timeout" ? 100 : 30_000,
    signal: controller.signal,
    onProgress(entry) {
      log("progress", { mode, text: entry.text });
      if (mode === "abort" && entry.text === "started") controller.abort();
    },
  })
    .then(
      (value) => log("result", { mode, value }),
      (error) => log("result", { mode, message: error.message }),
    )
    .finally(() => {
      settled = true;
    });
  await Promise.race([running, delay(3000)]);
  const tree = snapshot();
  await Promise.race([running, delay(3000)]);
  log("state", {
    mode,
    settled,
    children: owned.map((child) => ({
      pid: child.pid,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
      stdoutDestroyed: child.stdout?.destroyed,
      stderrDestroyed: child.stderr?.destroyed,
    })),
  });
  if (!settled) process.exitCode = 1;
  for (const row of tree.reverse()) {
    try {
      process.kill(row.ProcessId, "SIGKILL");
    } catch {}
  }
  controller.abort();
  await Promise.race([running, delay(1000)]);
  for (const child of owned) {
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  rmSync(workspacePath, { force: true, recursive: true });
}
