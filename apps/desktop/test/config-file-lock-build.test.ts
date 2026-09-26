import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

it.each(["cjs", "esm"] as const)(
  "loads native file locks from a %s bundle",
  async (format) => {
    const configRoot = resolve(process.cwd(), "../../packages/config");
    const artifacts = join(configRoot, ".rt");
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "desktop-lock-"));
    const outfile = join(
      directory,
      `file-lock.${format === "cjs" ? "cjs" : "mjs"}`,
    );
    try {
      await build({
        entryPoints: [join(configRoot, "src/file-lock.ts")],
        outfile,
        bundle: true,
        platform: "node",
        format,
        packages: "external",
        logLevel: "silent",
      });
      const result = await execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { pathToFileURL } from "node:url";
         const { withFileLock } = await import(pathToFileURL(process.argv[1]).href);
         await withFileLock({ path: process.argv[2], timeoutMs: 1000,
           work: async () => process.stdout.write("locked") });`,
        outfile,
        join(directory, "config.lock"),
      ]);
      expect(result.stdout).toBe("locked");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
