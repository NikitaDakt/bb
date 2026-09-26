import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandOutput,
  compareVersions,
  downloadedInstallerCommand,
  formatCommand,
  installationVerification,
  npmCommand,
  npmGlobalInstallCommand,
  npmGlobalInstallSource,
  probeNpmGlobalPackage,
  readCliVersion,
  resolveExecutablePath,
  versionFrom,
  type ExecutableProbeDeps,
} from "./provider-maintenance-kit.js";

describe("provider maintenance kit", () => {
  it.skipIf(process.platform === "win32")(
    "reads the version of a CLI that keeps reading stdin until EOF",
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "bb-cli-version-"));
      try {
        const executable = path.join(dir, "stdio-server-cli");
        await writeFile(
          executable,
          '#!/bin/sh\ncat >/dev/null\necho "tool 1.2.3"\n',
        );
        await chmod(executable, 0o755);
        expect(await readCliVersion(executable)).toBe("1.2.3");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("compares the numeric core of CLI versions, prerelease below release", () => {
    expect(compareVersions("0.135.9", "0.136.0")).toBeLessThan(0);
    expect(compareVersions("0.136.0-beta.1", "0.136.0")).toBeLessThan(0);
    expect(compareVersions("0.136.0", "0.136.0-beta.1")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.136.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it.each([
    ["1.0.0-alpha", "1.0.0-alpha.1"],
    ["1.0.0-alpha.1", "1.0.0-alpha.beta"],
    ["1.0.0-alpha.beta", "1.0.0-beta"],
    ["1.0.0-beta", "1.0.0-beta.2"],
    ["1.0.0-beta.2", "1.0.0-beta.11"],
    ["1.0.0-beta.9", "1.0.0-beta.10"],
    ["1.0.0-beta.11", "1.0.0-rc.1"],
    ["1.0.0-rc.2", "1.0.0-rc.10"],
    ["1.0.0-rc.10", "1.0.0"],
    ["1.0.0-9", "1.0.0-alpha"],
    ["1.0.0-B", "1.0.0-a"],
    ["1.0.0-alpha.2", "1.0.0-alpha.2.1"],
    ["1.0.0", "1.0.1-alpha"],
  ])("orders %s below %s in both directions", (older, newer) => {
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);
    expect(compareVersions(older, older)).toBe(0);
  });

  it("ignores build metadata for precedence", () => {
    expect(compareVersions("1.0.0+build.9", "1.0.0+build.10")).toBe(0);
    expect(compareVersions("1.0.0-beta.2+x", "1.0.0-beta.2+y")).toBe(0);
    expect(compareVersions("1.0.0-beta.9+x", "1.0.0-beta.10+y")).toBeLessThan(
      0,
    );
  });

  it.each([
    "not-a-version",
    "",
    "1.0",
    "1.0.0.1",
    "01.0.0",
    "1.0.0-beta.01",
    "1.0.0-beta..1",
    "1.0.0-",
    "1.0.0+",
    "tool 1.0.0",
    "1.0.0 trailing",
  ])("rejects invalid version %j in either operand", (invalid) => {
    expect(() => compareVersions(invalid, "0.0.0")).toThrow(TypeError);
    expect(() => compareVersions("0.0.0", invalid)).toThrow(TypeError);
  });

  it("reads the version out of a CLI banner", () => {
    expect(versionFrom("codex-cli 0.150.0")).toBe("0.150.0");
    expect(versionFrom("v2.1.0-beta.3\n")).toBe("2.1.0-beta.3");
    expect(versionFrom("no version here")).toBeNull();
    expect(versionFrom(null)).toBeNull();
  });

  it.each([
    "1.2.3-2026.01.15",
    "0.5.0-01",
    "1.2.3-beta..1",
    "1.2.3-beta.",
    "1.2.3-",
    "1.2.3+",
    "1.2.3+build..1",
    "1.2.3.4",
    "01.2.3",
  ])("returns null for invalid CLI version %s", (version) => {
    expect(versionFrom(`codex ${version}`)).toBeNull();
  });

  it("preserves valid prereleases and build metadata", () => {
    const version = versionFrom("codex 1.2.3-beta.10+2026.01.15");
    expect(version).toBe("1.2.3-beta.10+2026.01.15");
    expect(compareVersions(version!, "1.2.3-beta.9")).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32").each([
    ["1.2.3-2026.01.15", ""],
    ["0.5.0-01", " >&2"],
    ["1.2.3-beta..1", ""],
  ])("returns null when --version reports %s", async (version, redirect) => {
    const dir = await mkdtemp(path.join(tmpdir(), "bb-cli-invalid-version-"));
    try {
      const executable = path.join(dir, "invalid-version-cli");
      await writeFile(
        executable,
        `#!/bin/sh\necho "codex ${version}"${redirect}\n`,
      );
      await chmod(executable, 0o755);
      expect(await readCliVersion(executable)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("quotes only the arguments a shell would mangle", () => {
    expect(
      formatCommand("npm", ["install", "-g", "@openai/codex@latest"]),
    ).toBe("npm install -g @openai/codex@latest");
    expect(formatCommand("sh", ["-c", "echo 'hi' && ls"])).toBe(
      "sh -c 'echo '\\''hi'\\'' && ls'",
    );
  });

  it("attributes an executable inside npm's global bin to npm", () => {
    const npmBin = path.join(path.sep, "usr", "local", "bin");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: path.join(npmBin, "codex"),
        npmBin,
      }),
    ).toBe("npmGlobal");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: path.join(path.sep, "opt", "homebrew", "bin", "codex"),
        npmBin,
      }),
    ).toBe("external");
    expect(
      npmGlobalInstallSource({ installed: true, executablePath: null, npmBin }),
    ).toBe("external");
    expect(
      npmGlobalInstallSource({
        installed: false,
        executablePath: null,
        npmBin: null,
      }),
    ).toBe("notInstalled");
  });

  it("verifies an update against the latest version, or a change when the registry was unreachable", () => {
    expect(
      installationVerification(
        { currentVersion: "1.0.0", latestVersion: "1.1.0" },
        "update",
      ),
    ).toEqual({ kind: "version_at_least", version: "1.1.0" });
    expect(
      installationVerification(
        { currentVersion: "1.0.0", latestVersion: null },
        "update",
      ),
    ).toEqual({ kind: "version_changed", previousVersion: "1.0.0" });
    expect(
      installationVerification(
        { currentVersion: null, latestVersion: null },
        "install",
      ),
    ).toEqual({ kind: "installed" });
  });
});

describe("windows executable discovery", () => {
  it("names the npm.cmd shim on win32", () => {
    expect(npmCommand("win32")).toBe("npm.cmd");
    expect(npmCommand("linux")).toBe("npm");
  });

  it("asks where.exe on win32 and keeps PATHEXT order", async () => {
    const seen: { file: string; args: string[] }[] = [];
    const resolved = await resolveExecutablePath("codex", {
      platform: "win32",
      runLookup: async (file, args) => {
        seen.push({ file, args });
        return {
          stdout: "C:\\tools\\codex.cmd\r\nC:\\tools\\codex.exe\r\n",
        };
      },
    });
    expect(seen).toEqual([{ file: "where.exe", args: ["codex"] }]);
    expect(resolved).toBe("C:\\tools\\codex.cmd");
  });

  it("treats the where.exe exit code 1 as not installed", async () => {
    const resolved = await resolveExecutablePath("codex", {
      platform: "win32",
      runLookup: async () => {
        throw Object.assign(new Error("Command failed: where.exe codex"), {
          code: 1,
        });
      },
    });
    expect(resolved).toBeNull();
  });

  it("asks which on posix", async () => {
    const seen: { file: string; args: string[] }[] = [];
    const resolved = await resolveExecutablePath("codex", {
      platform: "linux",
      runLookup: async (file, args) => {
        seen.push({ file, args });
        return { stdout: "/usr/local/bin/codex\n" };
      },
    });
    expect(seen).toEqual([{ file: "which", args: ["codex"] }]);
    expect(resolved).toBe("/usr/local/bin/codex");
  });

  it("runs --version against the platform npm without a shell", async () => {
    const seen: { command: string; args: readonly string[] }[] = [];
    const deps: ExecutableProbeDeps = {
      platform: "win32",
      runCommand: async (command, args) => {
        seen.push({ command, args });
        return { stdout: "codex-cli 0.150.0\n", stderr: "" };
      },
    };
    await expect(readCliVersion("npm.cmd", deps)).resolves.toBe("0.150.0");
    expect(seen).toEqual([{ command: "npm.cmd", args: ["--version"] }]);
  });

  it("combines stdout and stderr for registry probes", async () => {
    await expect(
      commandOutput("npm", ["view", "codex", "version"], {
        platform: "linux",
        runCommand: async () => ({
          stdout: "0.150.0\n",
          stderr: "warning: using registry\n",
        }),
      }),
    ).resolves.toBe("0.150.0\n\nwarning: using registry");
  });

  it("keeps the npm prefix itself as the global bin on win32", async () => {
    const seen: string[] = [];
    const deps: ExecutableProbeDeps = {
      platform: "win32",
      runCommand: async (command, args) => {
        seen.push(command);
        if (args[0] === "prefix") {
          return {
            stdout: "C:\\Users\\u\\AppData\\Roaming\\npm\r\n",
            stderr: "",
          };
        }
        return {
          stdout: JSON.stringify({
            dependencies: { "@openai/codex": { version: "0.150.0" } },
          }),
          stderr: "",
        };
      },
    };
    const probe = await probeNpmGlobalPackage("@openai/codex", deps);
    expect(seen).toEqual(["npm.cmd", "npm.cmd"]);
    expect(probe.npmBin).toBe("C:\\Users\\u\\AppData\\Roaming\\npm");
    expect(probe.npmGlobalPackageVersion).toBe("0.150.0");
  });

  it("appends bin to the npm prefix on posix", async () => {
    const probe = await probeNpmGlobalPackage("@openai/codex", {
      platform: "linux",
      runCommand: async (_command, args) => {
        if (args[0] === "prefix") {
          return { stdout: "/usr/local\n", stderr: "" };
        }
        return { stdout: "{}", stderr: "" };
      },
    });
    expect(probe.npmBin).toBe("/usr/local/bin");
  });

  it("reads --version for real on this host", async () => {
    await expect(readCliVersion(process.execPath)).resolves.toMatch(
      /\d+\.\d+\.\d+/u,
    );
  });

  it("finds the node binary for real on this host", async () => {
    await expect(resolveExecutablePath(process.execPath)).resolves.toBe(
      process.execPath,
    );
  });
});

describe("windows install commands", () => {
  const HOSTILE_URL = "https://example.com/x?a=1&b='injected';echo";

  it("builds the npm global install through the platform npm shim", () => {
    expect(npmGlobalInstallCommand("@openai/codex", "win32")).toEqual({
      command: "npm.cmd",
      args: ["install", "-g", "@openai/codex@latest"],
      displayCommand: "npm.cmd install -g @openai/codex@latest",
    });
    expect(npmGlobalInstallCommand("@openai/codex", "linux")).toEqual({
      command: "npm",
      args: ["install", "-g", "@openai/codex@latest"],
      displayCommand: "npm install -g @openai/codex@latest",
    });
  });

  it("keeps a hostile installer URL inside one quoted word on posix", () => {
    const built = downloadedInstallerCommand(HOSTILE_URL, "linux");
    expect(built.command).toBe("sh");
    expect(built.args).toHaveLength(2);
    expect(built.args[0]).toBe("-c");
    const script = built.args[1] ?? "";
    expect(script).toContain(
      `'https://example.com/x?a=1&b='\\''injected'\\'';echo'`,
    );
    expect(built.displayCommand).toBe(script);
  });

  it("downloads through powershell.exe argv on win32, never sh", () => {
    const built = downloadedInstallerCommand(
      "https://cursor.com/install?win32=true",
      "win32",
    );
    expect(built.command).toBe("powershell.exe");
    expect(built.args.slice(0, 5)).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
    ]);
    expect(built.args).toHaveLength(6);
    const script = built.args[5] ?? "";
    expect(script).toContain("'https://cursor.com/install?win32=true'");
    expect(script).toContain("Invoke-WebRequest");
    expect(script).toContain("& $tmp");
    expect(script).not.toContain("bash");
  });

  it.runIf(process.platform === "win32").each([0, 7])(
    "runs a native installer, preserves exit code %i and removes its temporary file",
    async (exitCode) => {
      const dir = await mkdtemp(
        path.join(tmpdir(), "bb installer Кириллица [100%] &-"),
      );
      try {
        const command = downloadedInstallerCommand(HOSTILE_URL, "win32");
        const download = [
          "function Invoke-WebRequest {",
          "param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)",
          `Set-Content -LiteralPath $OutFile -Value 'Write-Output "installer ran"; exit ${exitCode}'`,
          "}",
        ].join("\n");
        const result = spawnSync(
          command.command,
          [...command.args.slice(0, -1), `${download}\n${command.args.at(-1)}`],
          {
            env: { ...process.env, TEMP: dir, TMP: dir },
            encoding: "utf8",
            windowsHide: true,
            timeout: 10_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(exitCode);
        expect(result.stdout).toContain("installer ran");
        expect(await readdir(dir)).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it("keeps a hostile installer URL inside one powershell argv element", () => {
    const built = downloadedInstallerCommand(HOSTILE_URL, "win32");
    expect(built.command).toBe("powershell.exe");
    expect(built.args).toHaveLength(6);
    const script = built.args[5] ?? "";
    expect(script).toContain("'https://example.com/x?a=1&b=''injected'';echo'");
  });

  it("refuses non-HTTPS installer URLs on every platform", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(() =>
        downloadedInstallerCommand("http://example.com/install", platform),
      ).toThrow("non-HTTPS");
      expect(() =>
        downloadedInstallerCommand("curl evil | sh", platform),
      ).toThrow("non-HTTPS");
    }
  });
});

describe("windows npm install source", () => {
  it("matches a win32 executable under the npm prefix despite casing", () => {
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: "c:\\users\\u\\appdata\\roaming\\npm\\codex.cmd",
        npmBin: "C:\\Users\\u\\AppData\\Roaming\\npm",
        platform: "win32",
      }),
    ).toBe("npmGlobal");
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: "C:\\tools\\codex.exe",
        npmBin: "C:\\Users\\u\\AppData\\Roaming\\npm",
        platform: "win32",
      }),
    ).toBe("external");
  });

  it("stays case-sensitive on posix", () => {
    expect(
      npmGlobalInstallSource({
        installed: true,
        executablePath: "/USR/LOCAL/BIN/codex",
        npmBin: "/usr/local/bin",
        platform: "linux",
      }),
    ).toBe("external");
  });
});

describe("windows PATHEXT executable resolution", () => {
  it("prefers codex.cmd when where.exe lists the sh shim first on win32", async () => {
    const resolved = await resolveExecutablePath("codex", {
      platform: "win32",
      runLookup: async () => ({
        stdout:
          "C:\\Users\\u\\AppData\\Roaming\\npm\\codex\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd\r\n",
      }),
    });
    expect(resolved).toBe("C:\\Users\\u\\AppData\\Roaming\\npm\\codex.cmd");
  });

  it("prefers pi.cmd when where.exe lists the sh shim first on win32", async () => {
    const resolved = await resolveExecutablePath("pi", {
      platform: "win32",
      runLookup: async () => ({
        stdout:
          "C:\\Users\\Administrator\\AppData\\Local\\pi-node\\current\\pi\r\nC:\\Users\\Administrator\\AppData\\Local\\pi-node\\current\\pi.cmd\r\n",
      }),
    });
    expect(resolved).toBe(
      "C:\\Users\\Administrator\\AppData\\Local\\pi-node\\current\\pi.cmd",
    );
  });

  it("keeps the sh shim first on posix", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const resolved = await resolveExecutablePath("codex", {
        platform,
        runLookup: async () => ({
          stdout: "/usr/local/bin/codex\n/usr/local/bin/codex.cmd\n",
        }),
      });
      expect(resolved).toBe("/usr/local/bin/codex");
    }
  });

  it("resolves an absolute extensionless sibling to its cmd launcher on win32", async () => {
    const seen: string[] = [];
    const resolved = await resolveExecutablePath("C:\\tools\\pi", {
      platform: "win32",
      fileIsExecutable: async (candidate) => {
        seen.push(candidate);
        return candidate.toLowerCase().endsWith(".cmd");
      },
    });
    expect(resolved).toBe("C:\\tools\\pi.cmd");
    expect(seen[0]).toBe("C:\\tools\\pi.com");
  });

  it("falls back to the extensionless file itself when no Windows launcher exists", async () => {
    const resolved = await resolveExecutablePath("C:\\tools\\pi", {
      platform: "win32",
      fileIsExecutable: async (candidate) => candidate === "C:\\tools\\pi",
    });
    expect(resolved).toBe("C:\\tools\\pi");
  });

  it("returns an absolute posix path itself when it is executable", async () => {
    const resolved = await resolveExecutablePath("/usr/local/bin/codex", {
      platform: "linux",
      fileIsExecutable: async () => true,
    });
    expect(resolved).toBe("/usr/local/bin/codex");
  });
});

describe("windows absolute executable paths", () => {
  it("never shells out to where.exe for an absolute win32 path", async () => {
    const seen: { file: string; args: string[] }[] = [];
    const resolved = await resolveExecutablePath("C:\\tools\\codex.cmd", {
      platform: "win32",
      runLookup: async (file, args) => {
        seen.push({ file, args });
        return { stdout: "" };
      },
      fileIsExecutable: async () => false,
    });
    expect(seen).toEqual([]);
    expect(resolved).toBeNull();
  });

  it("passes a hostile bare command to the lookup as one argv element", async () => {
    const seen: { file: string; args: string[] }[] = [];
    const hostile = "codex & del C:\\temp";
    const resolved = await resolveExecutablePath(hostile, {
      platform: "win32",
      runLookup: async (file, args) => {
        seen.push({ file, args });
        throw Object.assign(new Error("not found"), { code: 1 });
      },
    });
    expect(seen).toEqual([{ file: "where.exe", args: [hostile] }]);
    expect(resolved).toBeNull();
  });
});
