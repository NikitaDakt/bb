import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findMachineServiceFile,
  parseWindowsMachineService,
  formatWindowsMachineServiceCommand,
} from "../src/machine-service.js";

const tempDirs: string[] = [];

async function createRoot(): Promise<{ dataDir: string; homeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "bb-machine-service-"));
  tempDirs.push(root);
  const homeDir = join(root, "home");
  const dataDir = join(root, "data & more");
  await mkdir(homeDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  return { dataDir, homeDir };
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

async function writeLaunchAgent(args: {
  dataDir: string;
  homeDir: string;
  name: string;
}): Promise<string> {
  const directory = join(args.homeDir, "Library", "LaunchAgents");
  await mkdir(directory, { recursive: true });
  const path = join(directory, args.name);
  await writeFile(
    path,
    `<plist version="1.0">
<dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BB_APP_NPM_PREFIX</key><string>${xmlEscape(args.dataDir)}/npm</string>
    <key>BB_DATA_DIR</key><string>${xmlEscape(args.dataDir)}</string>
  </dict>
</dict>
</plist>
`,
  );
  return path;
}

async function writeSystemdUnit(args: {
  dataDir: string;
  directory: string;
  name: string;
}): Promise<string> {
  await mkdir(args.directory, { recursive: true });
  const path = join(args.directory, args.name);
  await writeFile(
    path,
    `[Service]
ExecStart="/usr/bin/node" "/opt/bb-app" host-daemon --auto-update
Environment="BB_APP_NPM_PREFIX=${systemdEscape(args.dataDir)}/npm"
Environment="BB_DATA_DIR=${systemdEscape(args.dataDir)}"
`,
  );
  return path;
}

afterEach(async () => {
  for (const root of tempDirs.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("findMachineServiceFile", () => {
  it.each(["windows-task", "windows-run-key"])(
    "finds the enrolled PowerShell service using %s and preserves literal arguments",
    async (manager) => {
      const { dataDir, homeDir } = await createRoot();
      const quoted = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      const directory = join(dataDir, "данные user's %VAR%");
      await mkdir(directory);
      const args = [
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\bb user's\\bb-app.js",
        "host-daemon",
        "--server-url",
        "https://old.test",
      ];
      const content = `\uFEFF$ErrorActionPreference = 'Stop'\n$bbServiceManager = '${manager}'\n$env:BB_DATA_DIR=${quoted(directory)}\n& ${args.map(quoted).join(" ")}\nexit $LASTEXITCODE\n`;
      const file = join(directory, "bb-host-daemon-host_test.ps1");
      await writeFile(file, content);
      expect(
        await findMachineServiceFile({
          dataDir: directory,
          homeDir,
          platform: "win32",
        }),
      ).toBe(file);
      expect(parseWindowsMachineService(content)?.programArguments).toEqual(
        args,
      );
      const replacement = [
        ...args.slice(0, -1),
        "https://new.test/path?x='$value&y=%test%",
      ];
      const updated = formatWindowsMachineServiceCommand(content, replacement);
      expect(parseWindowsMachineService(updated)).toEqual({
        manager,
        environment: { BB_DATA_DIR: directory },
        programArguments: replacement,
      });
      expect(updated.startsWith("\uFEFF")).toBe(true);
    },
  );

  it("ignores a PowerShell launcher that has not installed persistence", async () => {
    const { dataDir, homeDir } = await createRoot();
    await writeFile(
      join(dataDir, "bb-host-daemon-host_test.ps1"),
      `$env:BB_DATA_DIR='${dataDir}'\n& 'node' 'bb-app.js' 'host-daemon'\n`,
    );
    expect(
      await findMachineServiceFile({ dataDir, homeDir, platform: "win32" }),
    ).toBeNull();
  });

  it("finds the launch agent that runs a daemon for the data directory", async () => {
    const { dataDir, homeDir } = await createRoot();
    await writeLaunchAgent({
      dataDir: join(dataDir, "..", "other"),
      homeDir,
      name: "app.getbb.host-daemon.a-other.plist",
    });
    const expected = await writeLaunchAgent({
      dataDir,
      homeDir,
      name: "app.getbb.host-daemon.b-machine.plist",
    });
    await writeLaunchAgent({
      dataDir,
      homeDir,
      name: "com.example.unrelated.plist",
    });

    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
    ).resolves.toBe(expected);
  });

  it("matches a service that names the data directory through a symlink", async () => {
    const { dataDir, homeDir } = await createRoot();
    const linkedDataDir = join(homeDir, "linked-data");
    await symlink(dataDir, linkedDataDir);
    const expected = await writeLaunchAgent({
      dataDir: linkedDataDir,
      homeDir,
      name: "app.getbb.host-daemon.machine.plist",
    });

    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
    ).resolves.toBe(expected);
  });

  it("finds systemd user and system units that run a daemon for the data directory", async () => {
    const { dataDir, homeDir } = await createRoot();
    const escapedDataDir = join(
      dataDir,
      process.platform === "win32"
        ? "with 'quotes' 100%"
        : 'with "quotes" 100%',
    );
    await mkdir(escapedDataDir, { recursive: true });
    const userUnit = await writeSystemdUnit({
      dataDir: escapedDataDir,
      directory: join(homeDir, ".config", "systemd", "user"),
      name: "bb-host-daemon-machine.service",
    });
    const systemUnit = await writeSystemdUnit({
      dataDir,
      directory: join(dataDir, "systemd"),
      name: "bb-host-daemon-machine.service",
    });

    await expect(
      findMachineServiceFile({
        dataDir: escapedDataDir,
        homeDir,
        platform: "linux",
      }),
    ).resolves.toBe(userUnit);
    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "linux" }),
    ).resolves.toBe(systemUnit);
  });

  it("returns null when no service runs a daemon for the data directory", async () => {
    const { dataDir, homeDir } = await createRoot();

    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
    ).resolves.toBeNull();
    await writeLaunchAgent({
      dataDir: join(homeDir, "elsewhere"),
      homeDir,
      name: "app.getbb.host-daemon.elsewhere.plist",
    });
    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "darwin" }),
    ).resolves.toBeNull();
    await expect(
      findMachineServiceFile({ dataDir, homeDir, platform: "win32" }),
    ).resolves.toBeNull();
  });
});
