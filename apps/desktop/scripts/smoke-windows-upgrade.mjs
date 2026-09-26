import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { sleep, waitForChildExit } from "./child-process-helpers.mjs";
import { createPackagedAppLaunchArguments } from "./packaged-app-launch.mjs";

const { values } = parseArgs({
  options: {
    "baseline-installer": { type: "string" },
    "baseline-version": { type: "string" },
    "candidate-installer": { type: "string" },
    "candidate-version": { type: "string" },
    "evidence-dir": { type: "string" },
  },
});
assert.equal(process.platform, "win32");
for (const key of [
  "baseline-installer",
  "baseline-version",
  "candidate-installer",
  "candidate-version",
  "evidence-dir",
]) {
  assert.ok(values[key], `--${key} is required`);
}
const evidenceDir = resolve(values["evidence-dir"]);
await mkdir(evidenceDir, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "bb upgrade Кириллица & [data]-"));
const installDir = join(root, "installed app");
const dataDir = join(root, "data");
const userDataDir = join(root, "user data");
const projectPath = join(root, "project & [files]");
await mkdir(projectPath);
const binary = join(installDir, "wbb.exe");
const evidence = { root, checks: [], versions: [] };
const execFileAsync = promisify(execFile);

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${label}`, { cause: lastError });
}

async function allocatePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((done, fail) =>
    server.close((error) => (error ? fail(error) : done())),
  );
  return port;
}

async function runInstaller(path, args) {
  await execFileAsync(path, args, {
    windowsVerbatimArguments: true,
    timeout: 120_000,
  });
}

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(5_000),
  });
  assert.ok(
    response.ok,
    `${response.status} ${url}: ${response.ok ? "" : await response.text()}`,
  );
  return response.json();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function attachInspector(endpoint) {
  const socket = new WebSocket(endpoint);
  await once(socket, "open", { signal: AbortSignal.timeout(10_000) });
  let id = 0;
  return {
    close() {
      socket.close();
    },
    evaluate(expression) {
      const requestId = ++id;
      return new Promise((done, fail) => {
        const timer = setTimeout(
          () => finish(new Error("Inspector evaluation timed out")),
          15_000,
        );
        const onClose = () =>
          finish(new Error("Inspector closed during evaluation"));
        const onMessage = ({ data }) => {
          const response = JSON.parse(data);
          if (response.id !== requestId) return;
          const error = response.error ?? response.result?.exceptionDetails;
          finish(
            error ? new Error(JSON.stringify(error)) : null,
            response.result?.result?.value,
          );
        };
        function finish(error, result) {
          clearTimeout(timer);
          socket.removeEventListener("message", onMessage);
          socket.removeEventListener("close", onClose);
          if (error) fail(error);
          else done(result);
        }
        socket.addEventListener("message", onMessage);
        socket.addEventListener("close", onClose, { once: true });
        socket.send(
          JSON.stringify({
            id: requestId,
            method: "Runtime.evaluate",
            params: {
              expression,
              awaitPromise: true,
              returnByValue: true,
            },
          }),
        );
      });
    },
  };
}

async function launch(version) {
  const serverPort = await allocatePort();
  const daemonPort = await allocatePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const env = {
    ...process.env,
    BB_DATA_DIR: dataDir,
    BB_SERVER_PORT: String(serverPort),
    BB_HOST_DAEMON_PORT: String(daemonPort),
    BB_DESKTOP_OPEN_DEVTOOLS: "0",
    BB_DESKTOP_ATTACH_WITHOUT_PROMPT: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BB_DESKTOP_NODE_EXEC_PATH;
  delete env.BB_DESKTOP_APP_URL;
  const output = [];
  let outputTail = "";
  let endpoint;
  let outputBytes = 0;
  let inspector;
  let runtime;
  const child = spawn(
    binary,
    [
      "--inspect=127.0.0.1:0",
      ...createPackagedAppLaunchArguments({ platform: "win32", userDataDir }),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes < 2 * 1024 * 1024) output.push(chunk);
    outputTail = (outputTail + chunk.toString()).slice(-4096);
    const match = outputTail.match(
      /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/u,
    );
    if (match) endpoint = match[1];
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const stop = async () => {
    try {
      if (inspector && child.exitCode === null && child.signalCode === null) {
        await inspector.evaluate(
          "setImmediate(() => require('electron').app.quit()); true",
        );
      }
      inspector?.close();
      assert.ok(
        await waitForChildExit(child, 20_000),
        "Desktop did not quit normally",
      );
      assert.equal(child.exitCode, 0, "Desktop quit failed");
      if (runtime)
        await waitFor(
          "owned runtime shutdown",
          () => !isAlive(runtime.pid),
          20_000,
        );
    } finally {
      inspector?.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await writeFile(
        join(evidenceDir, `${version}-desktop.log`),
        Buffer.concat(output),
      );
    }
  };
  try {
    inspector = await attachInspector(
      await waitFor("main process inspector", () => endpoint),
    );
    assert.equal(await inspector.evaluate("process.pid"), child.pid);
    assert.equal(
      await inspector.evaluate("require('electron').app.getVersion()"),
      version,
    );
    const status = await waitFor("native host daemon", async () => {
      const status = await json(`http://127.0.0.1:${daemonPort}/status`);
      return status.connected && status.serverUrl === serverUrl && status;
    });
    assert.equal(status.platform, "windows");
    assert.ok(status.hostId);
    await waitFor("server and plugins", () =>
      json(`${serverUrl}/api/v1/system/providers`),
    );
    runtime = JSON.parse(
      await readFile(join(userDataDir, "owned-runtime.json"), "utf8"),
    );
    assert.ok(Number.isInteger(runtime.pid) && runtime.pid > 0);
    assert.equal(runtime.serverUrl, serverUrl);
    const desktopInfo = await waitFor("compiled Desktop version", () =>
      inspector.evaluate(`
      Promise.all(require('electron').BrowserWindow.getAllWindows().map(window =>
        window.webContents.executeJavaScript('typeof window.bbDesktop === "object" ? window.bbDesktop.getInfo() : null').catch(() => null)
      )).then(results => results.find(info => info && info.version))
    `),
    );
    assert.equal(desktopInfo.version, version);
    evidence.versions.push({
      version,
      hostId: status.hostId,
      guiPid: child.pid,
      runtimePid: runtime.pid,
    });
    return { serverUrl, hostId: status.hostId, stop };
  } catch (error) {
    await stop().catch((cleanupError) => console.error(cleanupError));
    throw error;
  }
}

let current;
try {
  await runInstaller(resolve(values["baseline-installer"]), [
    "/S",
    `/D=${installDir}`,
  ]);
  current = await launch(values["baseline-version"]);
  const before = await json(`${current.serverUrl}/api/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Windows upgrade Кириллица & [project]",
      source: {
        type: "local_path",
        hostId: current.hostId,
        path: projectPath,
      },
    }),
  });
  assert.ok(before.id);
  const hostId = current.hostId;
  await current.stop();
  current = null;
  evidence.checks.push(
    "baseline starts real runtime, creates project and quits normally",
  );

  await runInstaller(resolve(values["candidate-installer"]), [
    "/S",
    `/D=${installDir}`,
  ]);
  current = await launch(values["candidate-version"]);
  assert.equal(current.hostId, hostId, "Upgrade replaced machine identity");
  const after = await json(
    `${current.serverUrl}/api/v1/projects/${encodeURIComponent(before.id)}`,
  );
  assert.equal(after.id, before.id);
  assert.equal(after.name, before.name);
  assert.deepEqual(after.sources, before.sources);
  evidence.project = { id: after.id, name: after.name };
  evidence.checks.push(
    "candidate starts, preserves machine identity and persisted project",
  );
  await current.stop();
  current = null;
  evidence.checks.push("candidate quits normally and stops its owned runtime");
} finally {
  try {
    if (current) await current.stop();
  } finally {
    const entries = await readdir(installDir).catch(() => []);
    const uninstaller = entries.find((name) =>
      /uninstall.*\.exe$/iu.test(name),
    );
    if (evidence.versions.length === 2)
      assert.ok(uninstaller, "Installed app has no uninstaller");
    if (uninstaller) {
      const database = await readFile(join(dataDir, "bb.db")).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      await runInstaller(join(installDir, uninstaller), ["/S"]);
      await waitFor(
        "uninstall",
        async () =>
          !(await readdir(installDir).catch(() => [])).includes("wbb.exe"),
        20_000,
      );
      if (database !== null) {
        assert.deepEqual(
          await readFile(join(dataDir, "bb.db")),
          database,
          "Uninstall changed the database",
        );
        evidence.databaseSha256 = createHash("sha256")
          .update(database)
          .digest("hex");
        evidence.checks.push(
          "uninstall removes application and preserves the database byte for byte",
        );
      }
    }
    await writeFile(
      join(evidenceDir, "upgrade.json"),
      JSON.stringify(evidence, null, 2),
    );
  }
}
assert.equal(evidence.checks.length, 4);
console.log(`Native Windows upgrade passed: ${evidence.checks.join("; ")}`);
