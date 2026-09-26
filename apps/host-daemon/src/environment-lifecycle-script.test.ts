import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLifecycleScriptCommand,
  gitBashProcessGroupId,
  runSetupScript,
  runTeardownScript,
} from "./environment-lifecycle-script.js";

const directories: string[] = [];
async function workspace(
  kind: "setup" | "teardown",
  script: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-core-hooks-"));
  directories.push(directory);
  await writeFile(join(directory, `.bb-env-${kind}.sh`), script);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("core environment scripts", () => {
  it.runIf(process.platform === "win32").each(["setup", "teardown"] as const)(
    "prefers native PowerShell %s in a literal Windows workspace path",
    async (kind) => {
      const workspacePath = await mkdtemp(
        join(tmpdir(), "bb native Кириллица &[hook]-"),
      );
      directories.push(workspacePath);
      await writeFile(join(workspacePath, `.bb-env-${kind}.sh`), "exit 99\n");
      await writeFile(
        join(workspacePath, `.bb-env-${kind}.ps1`),
        "$ErrorActionPreference = 'Stop'\n[IO.File]::WriteAllText([IO.Path]::Combine($PSScriptRoot, 'marker'), 'native')\nWrite-Output native-done\n",
      );
      const output: string[] = [];
      const run = kind === "setup" ? runSetupScript : runTeardownScript;
      await expect(
        run({
          workspacePath,
          timeoutMs: 5000,
          onProgress: (entry) => output.push(entry.text),
        }),
      ).resolves.toEqual({ ran: true });
      expect(await readFile(join(workspacePath, "marker"), "utf8")).toBe(
        "native",
      );
      expect(output).toContain("native-done");
    },
  );

  it("maps a Windows PID to its owned Git Bash process group", () => {
    const processes = [
      "      PID PPID PGID WINPID TTY UID STIME COMMAND",
      "     1303 1 1303 6624 ? 197108 14:44:34 /usr/bin/bash",
      "S    1304 1303 1303 1216 ? 197108 14:44:34 /usr/bin/sleep",
      "     1305 1 1305 2440 ? 197108 14:44:35 /usr/bin/ps",
    ].join("\n");
    expect(gitBashProcessGroupId(processes, 6624)).toBe(1303);
    expect(gitBashProcessGroupId(processes, 1216)).toBeNull();
    expect(gitBashProcessGroupId(processes, 1303)).toBeNull();
    expect(gitBashProcessGroupId("1 0 1 6624 ? root init", 6624)).toBeNull();
    expect(gitBashProcessGroupId("", 6624)).toBeNull();
  });
  it.each(["setup", "teardown"] as const)(
    "runs a native PowerShell %s script without interpreting its path",
    (kind) => {
      const scriptName = `.bb-env-${kind}.ps1`;
      const scriptPath = `C:\\Users\\Александр\\bb project & data\\${scriptName}`;
      const command = buildLifecycleScriptCommand({
        kind,
        scriptName,
        scriptPath,
        platform: "win32",
      });
      expect(command.command).toBe("powershell.exe");
      expect(command.args).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ]);
    },
  );

  it.each(["setup", "teardown"] as const)(
    "supplies stdin EOF so %s continues to completion",
    async (kind) => {
      const workspacePath = await workspace(
        kind,
        'cat >/dev/null\nprintf complete > marker\nprintf "\\342"\nsleep 0.05\nprintf "\\234\\223\\n"\nprintf "done\\n" >&2\n',
      );
      const output: string[] = [];
      const run = kind === "setup" ? runSetupScript : runTeardownScript;
      const result = await run({
        workspacePath,
        timeoutMs: 1000,
        env: { PATH: "/usr/bin:/bin" },
        onProgress: (entry) => output.push(entry.text),
      });
      expect(result).toEqual({ ran: true });
      expect(await readFile(join(workspacePath, "marker"), "utf8")).toBe(
        "complete",
      );
      expect(output).toContain("✓");
      expect(output).toContain("done");
    },
  );

  it("runs in the environment directory and streams stdout and stderr", async () => {
    const workspacePath = await workspace(
      "setup",
      `${process.platform === "win32" ? "pwd -W" : "pwd"} > marker\nprintf 'first\\rsecond\\n'\necho stderr >&2\n`,
    );
    const output: string[] = [];
    await runSetupScript({
      workspacePath,
      timeoutMs: 5000,
      onProgress: (entry) => output.push(entry.text),
    });
    const recordedPath = (
      await readFile(join(workspacePath, "marker"), "utf8")
    ).trim();
    expect(await realpath(recordedPath)).toBe(await realpath(workspacePath));
    expect(output).toContain("second");
    expect(output).toContain("stderr");
    expect(output).toContain("Running .bb-env-setup.sh");
  });

  it("surfaces output before setup failure", async () => {
    const workspacePath = await workspace(
      "setup",
      "echo failed-details >&2\nexit 7\n",
    );
    const output: string[] = [];
    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 5000,
        onProgress: (entry) => output.push(entry.text),
      }),
    ).rejects.toThrow("exit code 7");
    expect(output).toContain("failed-details");
  });

  it.each(["setup", "teardown"] as const)(
    "enforces the %s timeout",
    async (kind) => {
      const workspacePath = await workspace(
        kind,
        "echo before-timeout\nsleep 120\n",
      );
      const output: string[] = [];
      const run = kind === "setup" ? runSetupScript : runTeardownScript;
      const result = run({
        workspacePath,
        timeoutMs: 100,
        onProgress: (entry) => output.push(entry.text),
      });
      if (kind === "setup")
        await expect(result).rejects.toThrow("timed out after 100ms");
      else {
        await expect(result).resolves.toEqual({ ran: true });
        expect(output.join("\n")).toContain("timed out after 100ms");
      }
    },
  );

  it("reports teardown failure without rejecting removal", async () => {
    const workspacePath = await workspace(
      "teardown",
      "echo teardown-details\nexit 9\n",
    );
    const output: string[] = [];
    await expect(
      runTeardownScript({
        workspacePath,
        timeoutMs: 5000,
        onProgress: (entry) => output.push(entry.text),
      }),
    ).resolves.toEqual({ ran: true });
    expect(output.join("\n")).toContain("exit code 9");
    expect(output).toContain("teardown-details");
  });

  it("cancels a running setup before returning to cleanup", async () => {
    const workspacePath = await workspace("setup", "echo started\nsleep 120\n");
    const controller = new AbortController();
    await expect(
      runSetupScript({
        workspacePath,
        timeoutMs: 5000,
        signal: controller.signal,
        onProgress: (entry) => {
          if (entry.text === "started") controller.abort();
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("cancels a native child without stopping another Bash script", async () => {
    const otherPath = await workspace(
      "setup",
      "echo other-ready\nwhile [ ! -f proceed ]; do sleep 0.05; done\necho other-complete\n",
    );
    const otherController = new AbortController();
    let resolveOtherReady!: () => void;
    const otherReady = new Promise<void>((resolve) => {
      resolveOtherReady = resolve;
    });
    const output: string[] = [];
    const other = runSetupScript({
      workspacePath: otherPath,
      timeoutMs: 10_000,
      signal: otherController.signal,
      onProgress(entry) {
        output.push(entry.text);
        if (entry.text === "other-ready") resolveOtherReady();
      },
    });
    const otherResult = other.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const ownedPath = await workspace(
      "setup",
      `"$LIFECYCLE_TEST_NODE" -e 'console.log("owned:"+process.pid);setInterval(()=>{},1000)'\n`,
    );
    const controller = new AbortController();
    let ownedPid: number | undefined;
    try {
      await Promise.race([
        otherReady,
        other.then(() => {
          throw new Error("Other script exited before readiness");
        }),
      ]);
      await expect(
        runSetupScript({
          workspacePath: ownedPath,
          timeoutMs: 10_000,
          signal: controller.signal,
          env: { ...process.env, LIFECYCLE_TEST_NODE: process.execPath },
          onProgress(entry) {
            const match = entry.text.match(/^owned:(\d+)$/u);
            if (match !== null) {
              ownedPid = Number(match[1]);
              controller.abort();
            }
          },
        }),
      ).rejects.toThrow(/cancelled/i);
      expect(ownedPid).toBeGreaterThan(0);
      expect(() => process.kill(ownedPid!, 0)).toThrow();
      await writeFile(join(otherPath, "proceed"), "");
      await expect(otherResult).resolves.toEqual({ value: { ran: true } });
      expect(output).toContain("other-complete");
    } finally {
      otherController.abort();
      await otherResult;
      if (ownedPid !== undefined) {
        try {
          process.kill(ownedPid, "SIGKILL");
        } catch {}
      }
    }
  }, 20_000);

  it("runs POSIX hooks only with the explicitly resolved Git for Windows Bash", () => {
    const input = {
      kind: "setup" as const,
      scriptName: ".bb-env-setup.sh",
      platform: "win32" as const,
      scriptPath: "C:\\bb project & data\\.bb-env-setup.sh",
    };
    expect(() => buildLifecycleScriptCommand(input)).toThrow(
      "Install Git for Windows",
    );
    expect(
      buildLifecycleScriptCommand({
        ...input,
        bashPath: "C:\\Program Files\\Git\\bin\\bash.exe",
      }),
    ).toMatchObject({
      command: "C:\\Program Files\\Git\\bin\\bash.exe",
      args: [input.scriptPath],
    });
  });

  it("skips absent scripts", async () => {
    const workspacePath = await workspace("setup", "exit 0\n");
    await expect(
      runTeardownScript({ workspacePath, timeoutMs: 5000 }),
    ).resolves.toEqual({ ran: false });
  });
});
