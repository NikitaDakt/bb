import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_TOOLCHAIN_PINS,
  resolvePluginBuildToolchain,
  toolchainCacheDir,
} from "./toolchain.js";

describe("plugin build toolchain", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "bb-toolchain-"));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it("keys the cache directory on the pinned versions", () => {
    const dir = toolchainCacheDir("/data");
    for (const version of Object.values(PLUGIN_TOOLCHAIN_PINS)) {
      expect(basename(dir)).toContain(version);
    }
    expect(dir).toBe(join("/data", basename(dir)));
  });

  it("prefers a locally resolvable toolchain over fetching", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir, {
      onFetchStart: () => {
        throw new Error("fetched despite a locally resolvable toolchain");
      },
    });

    expect(toolchain.esbuild).toMatch(/^file:\/\//);
    expect(toolchain.esbuild).toContain("esbuild");
    expect(toolchain.tailwindNode).toContain("@tailwindcss/node");
    expect(toolchain.tailwindOxide).toContain("@tailwindcss/oxide");
    expect(
      await rm(toolchainCacheDir(baseDir), { recursive: true }).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  it("returns importable module specifiers", async () => {
    const toolchain = await resolvePluginBuildToolchain(baseDir);
    const esbuild = (await import(
      toolchain.esbuild
    )) as typeof import("esbuild");
    const result = await esbuild.transform("const x: number = 1", {
      loader: "ts",
    });

    expect(result.code.trim()).toBe("const x = 1;");
  });

  describe("fetched toolchain", () => {
    it.runIf(process.env.BB_TEST_TOOLCHAIN_FETCH === "1")(
      "builds a plugin frontend with nothing resolvable locally",
      async () => {
        const fetchEvents: string[] = [];
        const toolchain = await resolvePluginBuildToolchain(baseDir, {
          ignoreLocal: true,
          onFetchStart: () => fetchEvents.push("start"),
          onFetchDone: (ms) => fetchEvents.push(`done:${ms > 0}`),
        });

        expect(fetchEvents).toEqual(["start", "done:true"]);

        expect(toolchain.esbuild).toContain("toolchain-");
        expect(toolchain.tailwindCssDir).toContain("toolchain-");

        const pluginDir = join(baseDir, "plugin");
        await mkdir(pluginDir, { recursive: true });
        await writeFile(
          join(pluginDir, "package.json"),
          JSON.stringify({
            name: "bb-plugin-fetched",
            version: "0.1.0",
            bb: {
              name: "Fetched",
              description: "Fetched toolchain fixture.",
              branding: { icon: "Zap" },
              server: "./server.ts",
              app: "./app.tsx",
            },
          }),
        );
        await writeFile(
          join(pluginDir, "server.ts"),
          "export default function plugin() {}",
        );
        await writeFile(
          join(pluginDir, "app.tsx"),
          `import { definePluginApp } from "@get-bb/plugin-sdk/app";\n` +
            `export default definePluginApp({});\n`,
        );

        await promisify(execFile)(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "--eval",
            `import assert from "node:assert/strict";
             import { readFile } from "node:fs/promises";
             import { buildPluginApp } from ${JSON.stringify(new URL("./build-plugin-app.ts", import.meta.url).href)};
             const result = await buildPluginApp(${JSON.stringify(pluginDir)}, "0.9.0-test", ${JSON.stringify(toolchain)});
             const css = await readFile(result.cssPath, "utf8");
             assert.ok(css.length > 0);
             assert.ok(css.includes("--"));`,
          ],
          { timeout: 60_000 },
        );
      },
      600_000,
    );

    it("fetches with the shipped npm and excludes script-policy config without PATH executables", async () => {
      const envDump = join(baseDir, "npm-env.txt");
      const preload = join(baseDir, "capture-npm-env.mjs");
      await writeFile(
        preload,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(envDump)}, Object.entries(process.env).map(([key, value]) => key + "=" + value).join("\\n"));`,
          "process.exit(0);",
        ].join("\n"),
      );

      const overrides: Record<string, string> = {
        PATH: baseDir,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        npm_config_allow_scripts: "@github/keytar,node-pty",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
        npm_config_registry: "https://registry.example.invalid/",
      };
      const previous = new Map<string, string | undefined>();
      for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key]);
        process.env[key] = value;
      }
      try {
        await expect(
          resolvePluginBuildToolchain(baseDir, { ignoreLocal: true }),
        ).rejects.toThrow(/incomplete or misversioned/);
      } finally {
        for (const [key, value] of previous) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }

      const seen = new Map(
        (await readFile(envDump, "utf8"))
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => {
            const at = line.indexOf("=");
            return [
              line.slice(0, at).toLowerCase(),
              line.slice(at + 1),
            ] as const;
          }),
      );
      expect(seen.has("npm_config_allow_scripts")).toBe(false);
      expect(seen.has("npm_config_ignore_scripts")).toBe(false);
      expect(seen.get("npm_config_registry")).toBe(
        "https://registry.example.invalid/",
      );
    });

    it("reuses an already-fetched toolchain without reinstalling", async () => {
      const local = await resolvePluginBuildToolchain(baseDir);
      expect(local.tailwindCssDir.length).toBeGreaterThan(0);
    });
  });
});
