import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = fileURLToPath(
  new URL("../../src/assets/install-machine.ps1", import.meta.url),
);
const FIXTURE_ARTIFACT_DIGEST = createHash("sha256")
  .update("fixture-tarball")
  .digest("hex");
const POWERSHELL_BIN = process.platform === "win32" ? "powershell.exe" : "pwsh";
const powerShellProbe = spawnSync(
  POWERSHELL_BIN,
  ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
  { timeout: 10_000 },
);
const fixtures: { root: string; dataDir: string }[] = [];
const BOOTSTRAP_ARGS = ["-BootstrapEnv", "BB_ENROLLMENT"];

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

it("keeps the distributed script readable by Windows PowerShell 5.1", () => {
  expect(readFileSync(SCRIPT_PATH, "utf8")).not.toMatch(/[^\x00-\x7F]/u);
});

it.skipIf(process.platform !== "win32" && powerShellProbe.status !== 0)(
  "parses the complete installer with PowerShell",
  () => {
    const result = spawnSync(
      POWERSHELL_BIN,
      [
        "-NoProfile",
        "-Command",
        `$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile(${quotePowerShell(SCRIPT_PATH)},[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status, result.stderr).toBe(0);
  },
);

const CURL_FIXTURE_PS1 = [
  "param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CurlArgs)",
  "$logFile = $env:BB_PS1_TEST_CURL_LOG",
  "Add-Content -Path $logFile -Value ($CurlArgs -join ' ') -Encoding utf8",
  "$status = [int]$env:BB_PS1_TEST_ARTIFACT_STATUS",
  "$headerDigest = $env:BB_PS1_TEST_HEADER_DIGEST",
  "$output = ''",
  "$headers = ''",
  "$config = ''",
  "for ($i = 0; $i -lt $CurlArgs.Count; $i++) {",
  "  if ($CurlArgs[$i] -eq '--output' -and ($i + 1) -lt $CurlArgs.Count) { $output = $CurlArgs[$i + 1] }",
  "  if ($CurlArgs[$i] -eq '--dump-header' -and ($i + 1) -lt $CurlArgs.Count) { $headers = $CurlArgs[$i + 1] }",
  "  if ($CurlArgs[$i] -eq '-K' -and ($i + 1) -lt $CurlArgs.Count) { $config = $CurlArgs[$i + 1] }",
  "}",
  "$wantsNoneMatch = $false",
  "if ($config -ne '' -and (Test-Path -LiteralPath $config)) {",
  "  $configText = Get-Content -Raw -Path $config",
  "  Add-Content -Path $logFile -Value $configText -Encoding utf8",
  "  if ($configText.Contains($headerDigest)) {",
  "    $wantsNoneMatch = $true",
  "    Add-Content -Path $logFile -Value ('if-none-match: ' + $headerDigest) -Encoding utf8",
  "  }",
  "}",
  "if ($headers -ne '') {",
  "  Set-Content -Path $headers -Value ('HTTP/1.1 ' + $status + \"`r`n\" + 'x-bb-artifact-sha256: ' + $headerDigest + \"`r`n\") -Encoding ascii",
  "}",
  "if ($wantsNoneMatch -and ($status -eq 200)) {",
  "  Write-Output '304'",
  "} else {",
  "  if ($output -ne '') { [IO.File]::WriteAllBytes($output, [Text.Encoding]::ASCII.GetBytes('fixture-tarball')) }",
  "  Write-Output ([string]$status)",
  "}",
  "exit 0",
].join("\n");

const NPM_FIXTURE_JS = [
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  "const args = process.argv.slice(2);",
  "fs.appendFileSync(process.env.BB_PS1_TEST_NPM_LOG, JSON.stringify(args) + '\\n');",
  "if (process.env.BB_PS1_TEST_NPM_FAIL === '1') process.exit(1);",
  "let prefix = null;",
  "for (let i = 0; i < args.length; i++) { if (args[i] === '--prefix') prefix = args[i + 1]; }",
  "if (!prefix) process.exit(2);",
  "const template = fs.readFileSync(process.env.BB_PS1_TEST_BBAPP_TEMPLATE, 'utf8');",
  "fs.mkdirSync(path.join(prefix, 'node_modules', 'bb-app', 'host-daemon', 'dist'), { recursive: true });",
  "fs.mkdirSync(path.join(prefix, 'node_modules', 'bb-app', 'dist'), { recursive: true });",
  "fs.writeFileSync(path.join(prefix, 'bb-app.cmd'), '@echo off\\r\\nnode \"%~dp0node_modules\\\\bb-app\\\\dist\\\\bb-app.js\" %*\\r\\n');",
  "fs.writeFileSync(path.join(prefix, 'bb.cmd'), '@echo off\\r\\nnode \"%~dp0node_modules\\\\bb-app\\\\dist\\\\bb.js\" %*\\r\\n');",
  "fs.writeFileSync(path.join(prefix, 'node_modules', 'bb-app', 'dist', 'bb-app.js'), template);",
  "fs.writeFileSync(path.join(prefix, 'node_modules', 'bb-app', 'dist', 'bb.js'), template);",
  "fs.writeFileSync(path.join(prefix, 'node_modules', 'bb-app', 'host-daemon', 'dist', 'daemon-bundle.mjs'), 'fixture\\n');",
  "if (!process.env.BB_PS1_TEST_NPM_SKIP_NATIVE) {",
  "  for (const name of ['node-pty', '@parcel/watcher']) {",
  "    fs.mkdirSync(path.join(prefix, 'node_modules', 'bb-app', 'node_modules', name), { recursive: true });",
  "    fs.writeFileSync(path.join(prefix, 'node_modules', 'bb-app', 'node_modules', name, 'index.js'), 'module.exports = {};\\n');",
  "  }",
  "}",
].join("\n");

const BB_APP_FIXTURE = String.raw`
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const args = process.argv.slice(2);
const dataDir = process.env.BB_DATA_DIR;
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === "machine" && args[1] === "enroll") {
  const bootstrap = JSON.parse(process.env[option("--bootstrap-env")]);
  if (process.env.BB_PS1_TEST_ENROLL_FAIL === "1") process.exit(1);
  fs.writeFileSync(path.join(dataDir, "enrollment.json"), JSON.stringify({ args, bootstrap, inheritedCli: process.env.BB_CLI ?? null }));
  fs.writeFileSync(path.join(dataDir, "auth.json"), JSON.stringify({ hostId: bootstrap.hostId, hostKey: "fixture" }));
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ serverUrl: bootstrap.serverUrl }));
  process.exit(0);
}
if (args[0] !== "host-daemon") process.exit(2);
const auth = JSON.parse(fs.readFileSync(path.join(dataDir, "auth.json"), "utf8"));
fs.writeFileSync(path.join(dataDir, "daemon-start.json"), JSON.stringify({ args, pid: process.pid, bootstrap: process.env.BB_ENROLLMENT ?? null, cwd: process.cwd() }));
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ hostId: auth.hostId, serverUrl: option("--server-url"), connected: true }));
}).listen(Number(option("--host-daemon-port")), "127.0.0.1");
`;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "bb-win-install-"));
  const binDir = join(root, "bin");
  const dataDir = join(root, "данные & %USERNAME% user's");
  const homeDir = join(root, "home");
  const npmDirectory = join(binDir, "node_modules", "npm", "bin");
  for (const path of [dataDir, homeDir, npmDirectory])
    mkdirSync(path, { recursive: true });
  const curlFixture = join(root, "curl-fixture.ps1");
  const curlLog = join(root, "curl.log");
  const npmLog = join(root, "npm.log");
  writeFileSync(curlFixture, CURL_FIXTURE_PS1);
  writeFileSync(join(binDir, "npm.cmd"), "@exit /b 99\r\n");
  writeFileSync(join(npmDirectory, "npm-cli.js"), NPM_FIXTURE_JS);
  writeFileSync(join(root, "bb-app-template.js"), BB_APP_FIXTURE);
  const bootstrap = {
    hostId: `host_${randomUUID().replaceAll("-", "")}`,
    credential: "ephemeral-'$code",
    serverUrl: "https://machine.getbb.app",
    expiresAt: Date.now() + 600_000,
    headers: { "x-private-access": "private-token" },
  };
  const fixture = {
    root,
    binDir,
    dataDir,
    homeDir,
    curlFixture,
    curlLog,
    npmLog,
    bootstrap,
  };
  fixtures.push(fixture);
  return fixture;
}

function runInstaller(
  fixture: ReturnType<typeof createFixture>,
  env: Record<string, string> = {},
  args = BOOTSTRAP_ARGS,
  scriptPath = SCRIPT_PATH,
) {
  return spawnSync(
    POWERSHELL_BIN,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
    {
      encoding: "utf8",
      timeout: 55_000,
      windowsHide: true,
      env: {
        ...process.env,
        BB_DATA_DIR: fixture.dataDir,
        BB_ENROLLMENT: JSON.stringify(fixture.bootstrap),
        BB_CLI: "must-not-reexecute-another-installation",
        BB_INSTALL_SKIP_SERVICE: "1",
        BB_INSTALL_CURL_EXE: fixture.curlFixture,
        BB_PS1_TEST_ARTIFACT_STATUS: "200",
        BB_PS1_TEST_BBAPP_TEMPLATE: join(fixture.root, "bb-app-template.js"),
        BB_PS1_TEST_CURL_LOG: fixture.curlLog,
        BB_PS1_TEST_HEADER_DIGEST: FIXTURE_ARTIFACT_DIGEST,
        BB_PS1_TEST_NPM_LOG: fixture.npmLog,
        USERPROFILE: fixture.homeDir,
        HOMEDRIVE: fixture.homeDir.slice(0, 2),
        HOMEPATH: fixture.homeDir.slice(2),
        PATH: [fixture.binDir, process.env.PATH ?? ""].join(delimiter),
        ...env,
      },
    },
  );
}

function stopFixture(fixture: { dataDir: string }) {
  for (const pidFile of ["install-daemon.pid", "daemon-start.json"]) {
    const path = join(fixture.dataDir, pidFile);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const pid = pidFile.endsWith(".json")
      ? JSON.parse(text).pid
      : Number(text.trim());
    if (Number.isSafeInteger(pid) && pid > 0)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000,
      });
  }
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    stopFixture(fixture);
    rmSync(fixture.root, {
      force: true,
      recursive: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  }
});

describe.runIf(process.platform === "win32")(
  "native Windows machine installer",
  () => {
    it("rejects a missing enrollment without touching npm", () => {
      const fixture = createFixture();
      const result = runInstaller(fixture, { BB_ENROLLMENT: "" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Usage: install.ps1 -BootstrapEnv");
      expect(existsSync(fixture.npmLog)).toBe(false);
    });

    it.each(["expired", "invalid-url", "invalid-host"])(
      "rejects %s enrollment before installing",
      (kind) => {
        const fixture = createFixture();
        const bootstrap = { ...fixture.bootstrap };
        if (kind === "expired") bootstrap.expiresAt = 1;
        if (kind === "invalid-url") bootstrap.serverUrl = "file:///C:/temp";
        if (kind === "invalid-host") bootstrap.hostId = "../other-machine";
        const result = runInstaller(fixture, {
          BB_ENROLLMENT: JSON.stringify(bootstrap),
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Invalid or expired enrollment");
        expect(existsSync(fixture.npmLog)).toBe(false);
      },
    );

    it.each(["missing", "different"])(
      "rejects reconnect on a %s machine before downloading",
      (identity) => {
        const fixture = createFixture();
        if (identity === "different")
          writeFileSync(
            join(fixture.dataDir, "auth.json"),
            JSON.stringify({ hostId: "host_other", hostKey: "preserve-me" }),
          );
        const result = runInstaller(fixture, {
          BB_ENROLLMENT: JSON.stringify({
            ...fixture.bootstrap,
            reconnect: true,
            dataDir: fixture.dataDir,
          }),
        });
        expect(result.status).not.toBe(0);
        expect(existsSync(fixture.curlLog)).toBe(false);
        if (identity === "different")
          expect(
            readFileSync(join(fixture.dataDir, "auth.json"), "utf8"),
          ).toContain("preserve-me");
      },
    );

    it.each(["0", "65536"])("rejects invalid API port %s", (port) => {
      const fixture = createFixture();
      const result = runInstaller(fixture, {}, [
        ...BOOTSTRAP_ARGS,
        "-HostDaemonPort",
        port,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("between 1 and 65535");
    });

    it("enrolls with private access headers and starts from a literal Unicode path", () => {
      const fixture = createFixture();
      const result = runInstaller(fixture);
      expect(
        result.status,
        `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`,
      ).toBe(0);
      const enrollment = JSON.parse(
        readFileSync(join(fixture.dataDir, "enrollment.json"), "utf8"),
      );
      expect(enrollment).toEqual({
        args: ["machine", "enroll", "--bootstrap-env", "BB_ENROLLMENT"],
        bootstrap: fixture.bootstrap,
        inheritedCli: null,
      });
      expect(readFileSync(fixture.curlLog, "utf8")).toContain(
        "x-private-access: private-token",
      );
      const npmArgs = JSON.parse(readFileSync(fixture.npmLog, "utf8").trim());
      expect(npmArgs).toContain(join(fixture.dataDir, "npm"));
      expect(npmArgs).toContain(
        "--allow-scripts=better-sqlite3,node-pty,@parcel/watcher",
      );
      const daemon = JSON.parse(
        readFileSync(join(fixture.dataDir, "daemon-start.json"), "utf8"),
      );
      expect(daemon.bootstrap).toBeNull();
      expect(daemon.args).not.toContain("join");
      expect(daemon.cwd).toBe(fixture.dataDir);
      const launcher = readFileSync(
        join(fixture.dataDir, `bb-host-daemon-${fixture.bootstrap.hostId}.ps1`),
      );
      expect(launcher.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
      expect(result.stdout + result.stderr).not.toContain(
        fixture.bootstrap.credential,
      );
      expect(result.stdout + result.stderr).not.toContain("private-token");
      const savedInstaller = readFileSync(
        join(fixture.dataDir, "install-machine.ps1"),
        "utf8",
      );
      expect(savedInstaller).not.toContain(fixture.bootstrap.credential);
      expect(savedInstaller).not.toContain("private-token");
    });

    it("reuses the exact installed artifact and keeps the daemon port stable", () => {
      const fixture = createFixture();
      const first = runInstaller(fixture);
      expect(first.status, first.stderr).toBe(0);
      const port = readFileSync(
        join(fixture.dataDir, "host-daemon-port"),
        "utf8",
      );
      const second = runInstaller(fixture);
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain("identical server host artifact");
      expect(
        readFileSync(fixture.npmLog, "utf8").trim().split("\n"),
      ).toHaveLength(1);
      expect(
        readFileSync(join(fixture.dataDir, "host-daemon-port"), "utf8"),
      ).toBe(port);
    });

    it("adopts an existing machine without replacing its identity or enrolling again", () => {
      const fixture = createFixture();
      const first = runInstaller(fixture);
      expect(first.status, first.stderr).toBe(0);
      stopFixture(fixture);
      const configPath = join(fixture.dataDir, "config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          serverUrl: fixture.bootstrap.serverUrl,
          serverHeaders: { "x-adopted-access": "retained-token" },
        }),
      );
      const identity = readFileSync(join(fixture.dataDir, "auth.json"), "utf8");
      const enrollment = readFileSync(
        join(fixture.dataDir, "enrollment.json"),
        "utf8",
      );
      const second = runInstaller(
        fixture,
        { BB_ENROLLMENT: "invalid-and-unused" },
        ["-Adopt", "-DataDir", fixture.dataDir],
      );
      expect(second.status, second.stderr).toBe(0);
      expect(readFileSync(join(fixture.dataDir, "auth.json"), "utf8")).toBe(
        identity,
      );
      expect(
        readFileSync(join(fixture.dataDir, "enrollment.json"), "utf8"),
      ).toBe(enrollment);
      expect(readFileSync(fixture.curlLog, "utf8")).toContain(
        "x-adopted-access: retained-token",
      );
      expect(
        JSON.parse(
          readFileSync(join(fixture.dataDir, "daemon-start.json"), "utf8"),
        ).bootstrap,
      ).toBeNull();
    }, 120_000);

    it("uninstalls the owned Windows service while preserving its data", () => {
      const fixture = createFixture();
      const installed = runInstaller(fixture);
      expect(installed.status, installed.stderr).toBe(0);
      const identity = readFileSync(join(fixture.dataDir, "auth.json"), "utf8");
      const result = runInstaller(
        fixture,
        {},
        ["-Uninstall", "-DataDir", fixture.dataDir],
        join(fixture.dataDir, "install-machine.ps1"),
      );
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(fixture.dataDir, "auth.json"), "utf8")).toBe(
        identity,
      );
      expect(
        existsSync(
          join(
            fixture.dataDir,
            `bb-host-daemon-${fixture.bootstrap.hostId}.ps1`,
          ),
        ),
      ).toBe(false);
      const daemon = JSON.parse(
        readFileSync(join(fixture.dataDir, "daemon-start.json"), "utf8"),
      );
      expect(() => process.kill(daemon.pid, 0)).toThrow();
    }, 120_000);

    it("refuses to adopt an empty directory before downloading", () => {
      const fixture = createFixture();
      const result = runInstaller(fixture, {}, [
        "-Adopt",
        "-DataDir",
        fixture.dataDir,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("no valid enrolled machine identity");
      expect(existsSync(fixture.curlLog)).toBe(false);
    });

    it.each(["404", "503"])(
      "refuses HTTP %s rather than installing an unrelated registry build",
      (status) => {
        const fixture = createFixture();
        const result = runInstaller(fixture, {
          BB_PS1_TEST_ARTIFACT_STATUS: status,
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`HTTP ${status}`);
        expect(existsSync(fixture.npmLog)).toBe(false);
      },
    );

    it("rejects a mismatched artifact digest before npm runs", () => {
      const fixture = createFixture();
      const result = runInstaller(fixture, {
        BB_PS1_TEST_HEADER_DIGEST: "a".repeat(64),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("SHA-256 verification");
      expect(existsSync(fixture.npmLog)).toBe(false);
    });

    it.each([
      ["BB_PS1_TEST_NPM_FAIL", "Could not install bb-app"],
      ["BB_PS1_TEST_NPM_SKIP_NATIVE", "native add-ons"],
      ["BB_PS1_TEST_ENROLL_FAIL", "Machine enrollment failed"],
    ])("does not start a daemon when %s fails", (variable, message) => {
      const fixture = createFixture();
      const result = runInstaller(fixture, { [variable]: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(existsSync(join(fixture.dataDir, "daemon-start.json"))).toBe(
        false,
      );
    });
  },
);
