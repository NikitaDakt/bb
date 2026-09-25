import { execFile, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ServiceDefinition } from "./service-definition.js";

const execFileAsync = promisify(execFile);
const SERVICE_COMMAND_TIMEOUT_MS = 30_000;

export const LAUNCHD_RESTART_SCRIPT = [
  'domain="$1"',
  'plist="$2"',
  "sleep 1",
  'launchctl bootout "$domain" "$plist" >/dev/null 2>&1 || true',
  "attempt=0",
  'while [ "$attempt" -lt 20 ]; do',
  '  if launchctl bootstrap "$domain" "$plist"; then exit 0; fi',
  "  attempt=$((attempt + 1))",
  "  sleep 1",
  "done",
  "exit 1",
].join("\n");

export type ServerMoveCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<void>;

export interface DetachedSpawnRequest {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  logPath: string;
}

export type DetachedProcessSpawner = (
  request: DetachedSpawnRequest,
) => Promise<number>;

export interface RestartServiceArgs {
  definition: ServiceDefinition;
  runCommand: ServerMoveCommandRunner;
  spawnDetached: DetachedProcessSpawner;
  uid: number;
  env: NodeJS.ProcessEnv;
  logPath: string;
}

export const defaultServerMoveCommandRunner: ServerMoveCommandRunner = async (
  command,
  args,
) => {
  await execFileAsync(command, [...args], {
    env: process.env,
    timeout: SERVICE_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
};

export const defaultDetachedProcessSpawner: DetachedProcessSpawner = (
  request,
) => {
  mkdirSync(dirname(request.logPath), { recursive: true });
  const fd = openSync(request.logPath, "a", 0o600);
  try {
    const child = spawn(request.command, request.args, {
      detached: true,
      windowsHide: true,
      env: request.env,
      stdio: ["ignore", fd, fd],
    });
    return new Promise<number>((resolveSpawn, rejectSpawn) => {
      child.once("error", rejectSpawn);
      child.once("spawn", () => {
        child.unref();
        if (child.pid === undefined) {
          rejectSpawn(new Error(`${request.command} did not report a pid`));
          return;
        }
        resolveSpawn(child.pid);
      });
    });
  } finally {
    closeSync(fd);
  }
};

function systemdScopeFlag(definition: ServiceDefinition): string {
  return definition.manager === "systemd-system" ? "--system" : "--user";
}

export async function restartService(args: RestartServiceArgs): Promise<void> {
  if (
    args.definition.manager === "windows-task" ||
    args.definition.manager === "windows-run-key"
  ) {
    const dataDir = args.definition.environment.BB_DATA_DIR;
    if (dataDir === undefined)
      throw new Error("The Windows service has no data directory");
    const installer = join(
      dirname(args.definition.path),
      "install-machine.ps1",
    );
    const helper = `Start-Sleep -Seconds 1; & '${installer.replaceAll("'", "''")}' -Restart -DataDir '${dataDir.replaceAll("'", "''")}'`;
    const encoded = Buffer.from(helper, "utf16le").toString("base64");
    await args.runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $exe=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $child=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=('"'+$exe+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}')}; if ($child.ReturnValue -ne 0) { throw 'Could not launch the machine service restart helper' }`,
    ]);
    return;
  }
  if (args.definition.manager === "launchd") {
    await args.spawnDetached({
      command: "/bin/sh",
      args: [
        "-c",
        LAUNCHD_RESTART_SCRIPT,
        "bb-server-move-restart",
        `gui/${args.uid}`,
        args.definition.path,
      ],
      env: args.env,
      logPath: args.logPath,
    });
    return;
  }
  const scope = systemdScopeFlag(args.definition);
  await args.runCommand("systemctl", [scope, "daemon-reload"]);
  await args.runCommand("systemctl", [
    scope,
    "restart",
    "--no-block",
    args.definition.unitName,
  ]);
}
