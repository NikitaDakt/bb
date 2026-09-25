import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export const MACHINE_INSTALLER_ENV_NAME = "BB_MACHINE_INSTALLER";

const LAUNCHD_SERVICE_PREFIX = "app.getbb.host-daemon.";
const LAUNCHD_SERVICE_SUFFIX = ".plist";
const SYSTEMD_SERVICE_PREFIX = "bb-host-daemon-";
const SYSTEMD_SERVICE_SUFFIX = ".service";
const LAUNCHD_DATA_DIR_PATTERN =
  /<key>BB_DATA_DIR<\/key>\s*<string>([^<]*)<\/string>/u;
const SYSTEMD_DATA_DIR_PATTERN =
  /^Environment="BB_DATA_DIR=((?:[^"\\]|\\.)*)"\s*$/mu;
const WINDOWS_COMMAND_PATTERN = /^& ((?:'(?:[^'\r\n]|'')*'[ \t]*)+)\r?$/mu;
const WINDOWS_WORD_PATTERN = /'((?:[^'\r\n]|'')*)'/gu;
const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

export interface FindMachineServiceFileArgs {
  dataDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
}

interface ServiceDirectory {
  directory: string;
  parseDataDir(content: string): string | null;
  prefix: string;
  suffix: string;
}

export function parseWindowsMachineService(content: string): {
  manager: "windows-task" | "windows-run-key";
  environment: Record<string, string>;
  programArguments: string[];
} | null {
  const manager =
    /^\$bbServiceManager = '(windows-task|windows-run-key)'\r?$/mu.exec(
      content,
    )?.[1];
  const command = WINDOWS_COMMAND_PATTERN.exec(content)?.[1];
  if (
    (manager !== "windows-task" && manager !== "windows-run-key") ||
    command === undefined
  ) {
    return null;
  }
  const environment: Record<string, string> = {};
  for (const match of content.matchAll(
    /^\$env:([A-Za-z_][A-Za-z0-9_]*)='((?:[^'\r\n]|'')*)'\r?$/gmu,
  )) {
    if (match[1] !== undefined && match[2] !== undefined) {
      environment[match[1]] = match[2].replaceAll("''", "'");
    }
  }
  return {
    manager,
    environment,
    programArguments: Array.from(
      command.matchAll(WINDOWS_WORD_PATTERN),
      (match) => (match[1] ?? "").replaceAll("''", "'"),
    ),
  };
}

export function formatWindowsMachineServiceCommand(
  content: string,
  programArguments: readonly string[],
): string {
  if (
    !WINDOWS_COMMAND_PATTERN.test(content) ||
    programArguments.length < 2 ||
    programArguments.some((value) => /[\r\n]/u.test(value))
  ) {
    throw new Error("Invalid Windows machine service command");
  }
  const command =
    "& " +
    programArguments
      .map((value) => "'" + value.replaceAll("'", "''") + "'")
      .join(" ");
  return content.replace(WINDOWS_COMMAND_PATTERN, () => command);
}

function parseLaunchdDataDir(content: string): string | null {
  const match = LAUNCHD_DATA_DIR_PATTERN.exec(content);
  if (match?.[1] === undefined) {
    return null;
  }
  return match[1].replace(
    /&(?:amp|apos|gt|lt|quot);/gu,
    (entity) => XML_ENTITIES[entity] ?? entity,
  );
}

function parseSystemdDataDir(content: string): string | null {
  const match = SYSTEMD_DATA_DIR_PATTERN.exec(content);
  if (match?.[1] === undefined) {
    return null;
  }
  return match[1].replace(
    /\\(.)|%%/gu,
    (_sequence, escaped?: string) => escaped ?? "%",
  );
}

function serviceDirectories(
  args: FindMachineServiceFileArgs,
): ServiceDirectory[] {
  if (args.platform === "win32") {
    return [
      {
        directory: args.dataDir,
        parseDataDir: (content) =>
          parseWindowsMachineService(content)?.environment.BB_DATA_DIR ?? null,
        prefix: "bb-host-daemon-",
        suffix: ".ps1",
      },
    ];
  }
  if (args.platform === "darwin") {
    return [
      {
        directory: join(args.homeDir, "Library", "LaunchAgents"),
        parseDataDir: parseLaunchdDataDir,
        prefix: LAUNCHD_SERVICE_PREFIX,
        suffix: LAUNCHD_SERVICE_SUFFIX,
      },
    ];
  }
  if (args.platform === "linux") {
    return [
      join(args.homeDir, ".config", "systemd", "user"),
      join(args.dataDir, "systemd"),
    ].map((directory) => ({
      directory,
      parseDataDir: parseSystemdDataDir,
      prefix: SYSTEMD_SERVICE_PREFIX,
      suffix: SYSTEMD_SERVICE_SUFFIX,
    }));
  }
  return [];
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return resolve(path);
    }
    throw error;
  }
}

async function listServiceFiles(
  directory: ServiceDirectory,
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory.directory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
  return names
    .filter(
      (name) =>
        name.startsWith(directory.prefix) && name.endsWith(directory.suffix),
    )
    .sort()
    .map((name) => join(directory.directory, name));
}

export async function findMachineServiceFile(
  args: FindMachineServiceFileArgs,
): Promise<string | null> {
  const expectedDataDir = await canonicalPath(args.dataDir);
  for (const directory of serviceDirectories(args)) {
    for (const path of await listServiceFiles(directory)) {
      let content: string;
      try {
        content = await readFile(path, "utf8");
      } catch (error) {
        if (isMissingPathError(error)) {
          continue;
        }
        throw error;
      }
      const serviceDataDir = directory.parseDataDir(content);
      if (
        serviceDataDir !== null &&
        (await canonicalPath(serviceDataDir)) === expectedDataDir
      ) {
        return path;
      }
    }
  }
  return null;
}
