import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import {
  enrolledInstallerScript,
  manualEnrollmentCommand,
} from "./manual-enrollment-command.js";
import type { EnrollmentBootstrap } from "./enrollments.js";

const bootstrap: EnrollmentBootstrap = {
  hostId: "host_test",
  credential: "short-lived-code",
  serverUrl: "https://test.getbb.app",
  expiresAt: Date.now() + 60_000,
  headers: { "x-access": "private'$value" },
};

it.skipIf(process.platform === "win32")(
  "passes the exact bootstrap and arguments to the installer without shell expansion",
  () => {
    const script = enrolledInstallerScript(
      'printf "%s\\n%s\\n%s" "$1" "$2" "$BB_ENROLLMENT"',
      bootstrap,
    );
    const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `--bootstrap-env\nBB_ENROLLMENT\n${JSON.stringify(bootstrap)}`,
    );
  },
);

it("builds the transient curl command from the enrollment bootstrap", () => {
  expect(manualEnrollmentCommand(bootstrap)).toBe(
    "curl -sSL --fail-with-body -H 'X-BB-Enrollment: short-lived-code' 'https://test.getbb.app/install.sh' | sh",
  );
});

it("quotes the PowerShell enrollment header without executing credential contents", () => {
  const command = manualEnrollmentCommand(
    { ...bootstrap, credential: "code'$(throw 'expanded')" },
    "powershell",
  );
  expect(command).toContain("'X-BB-Enrollment'='code''$(throw ''expanded'')'");
  expect(command).toContain("-Uri 'https://test.getbb.app/install.ps1'");
  expect(command).not.toContain("private");
});

const powerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellAvailable =
  spawnSync(
    powerShell,
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    { timeout: 10_000 },
  ).status === 0;

it.skipIf(process.platform !== "win32" && !powerShellAvailable)(
  "passes exact JSON through PowerShell and removes the transient environment variable",
  () => {
    const script =
      enrolledInstallerScript(
        "param([string]$BootstrapEnv)\n[Console]::WriteLine($BootstrapEnv)\n[Console]::WriteLine([Environment]::GetEnvironmentVariable($BootstrapEnv))",
        bootstrap,
        "powershell",
      ) + '\nif (Test-Path Env:BB_ENROLLMENT) { throw "Enrollment leaked" }';
    const result = spawnSync(
      powerShell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.replaceAll("\r\n", "\n").trim()).toBe(
      `BB_ENROLLMENT\n${JSON.stringify(bootstrap)}`,
    );
  },
);
it.skipIf(process.platform === "win32")(
  "prints the server's enrollment error and stops before running the installer",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-enrollment-command-"));
    try {
      const curl = join(directory, "curl");
      writeFileSync(
        curl,
        "#!/bin/sh\nprintf '%s\\n' \"echo 'This enrollment command has already been used.' >&2\" 'exit 1'\nexit 22\n",
      );
      chmodSync(curl, 0o755);
      const result = spawnSync(
        "sh",
        ["-c", manualEnrollmentCommand(bootstrap)],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: [directory, process.env.PATH].join(delimiter),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("already been used");
      expect(result.stderr).not.toContain("Syntax error");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
