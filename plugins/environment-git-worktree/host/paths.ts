import { WorkspaceError } from "bb-environment-provider-host/git";
import { createHash } from "node:crypto";
import path from "node:path";

const REPO_DIR_NAME_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const WINDOWS_RESERVED_NAME_PATTERN =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const MAX_REPO_DIR_NAME_BYTES = 200;
const MAX_WINDOWS_GIT_DIR_BYTES = 260 - 40;
const REPO_DIR_HASH_LENGTH = 16;

function invalidSourcePath(sourcePath: string): WorkspaceError {
  return new WorkspaceError(
    "invalid_source_path",
    `Cannot derive repository directory name from source "${sourcePath}"`,
  );
}

function sourcePathBasename(sourcePath: string): string {
  if (!sourcePath || CONTROL_CHARACTER_PATTERN.test(sourcePath)) {
    throw invalidSourcePath(sourcePath);
  }
  const pathApi = path.posix.isAbsolute(sourcePath)
    ? path.posix
    : path.win32.isAbsolute(sourcePath)
      ? path.win32
      : null;
  if (pathApi === null) {
    throw invalidSourcePath(sourcePath);
  }
  const trailingSeparators = pathApi === path.posix ? /\/+$/u : /[\\/]+$/u;
  return pathApi.basename(sourcePath.replace(trailingSeparators, ""));
}

function isSafeRepoDirName(candidate: string, maxBytes: number): boolean {
  return (
    candidate !== "." &&
    candidate !== ".." &&
    REPO_DIR_NAME_PATTERN.test(candidate) &&
    !candidate.endsWith(".") &&
    !WINDOWS_RESERVED_NAME_PATTERN.test(candidate) &&
    Buffer.byteLength(candidate, "utf8") <= maxBytes
  );
}

function slugRepoDirName(candidate: string, maxBytes: number): string {
  const suffix = createHash("sha256")
    .update(candidate, "utf8")
    .digest("hex")
    .slice(0, REPO_DIR_HASH_LENGTH);
  const readableLimit = maxBytes - suffix.length - 1;
  const normalizedReadable = candidate
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "");
  const readable = (
    WINDOWS_RESERVED_NAME_PATTERN.test(normalizedReadable)
      ? `repo-${normalizedReadable}`
      : normalizedReadable
  )
    .slice(0, readableLimit)
    .replace(/[._-]+$/u, "");
  return `${readable || "repo".slice(0, readableLimit)}-${suffix}`;
}

export function deriveRepoDirName(
  sourcePath: string,
  maxBytes = MAX_REPO_DIR_NAME_BYTES,
): string {
  const basename = sourcePathBasename(sourcePath);
  const candidate = basename.endsWith(".git")
    ? basename.slice(0, -".git".length)
    : basename;

  if (!candidate || candidate === "." || candidate === "..") {
    throw invalidSourcePath(sourcePath);
  }
  return isSafeRepoDirName(candidate, maxBytes)
    ? candidate
    : slugRepoDirName(candidate, maxBytes);
}

export function resolveWorktreesRoot(dataDir: string): string {
  return path.join(dataDir, "worktrees");
}

export function resolveWorktreeAttemptRoot(args: {
  dataDir: string;
  pathKey: string;
}): string {
  if (
    !args.pathKey ||
    args.pathKey === "." ||
    args.pathKey === ".." ||
    path.posix.basename(args.pathKey) !== args.pathKey ||
    path.win32.basename(args.pathKey) !== args.pathKey ||
    !REPO_DIR_NAME_PATTERN.test(args.pathKey)
  ) {
    throw new WorkspaceError(
      "invalid_path_key",
      "A worktree path key must be a single path segment",
    );
  }
  return path.join(resolveWorktreesRoot(args.dataDir), args.pathKey);
}

export function resolveWorktreeTargetPath(args: {
  dataDir: string;
  pathKey: string;
  sourcePath: string;
  platform?: NodeJS.Platform;
}): string {
  const root = resolveWorktreeAttemptRoot(args);
  const pathApi =
    (args.platform ?? process.platform) === "win32" ? path.win32 : path;
  const maxBytes =
    pathApi === path.win32
      ? Math.min(
          MAX_REPO_DIR_NAME_BYTES,
          MAX_WINDOWS_GIT_DIR_BYTES -
            Buffer.byteLength(
              pathApi.join(pathApi.resolve(root), ".git"),
              "utf8",
            ) -
            1,
        )
      : MAX_REPO_DIR_NAME_BYTES;
  if (maxBytes < REPO_DIR_HASH_LENGTH + 2) {
    throw new WorkspaceError(
      "invalid_source_path",
      "The Windows Git worktree path is too long; choose a shorter bb data directory",
    );
  }
  return pathApi.join(root, deriveRepoDirName(args.sourcePath, maxBytes));
}

export function resolveWorktreeChildPath(args: {
  dataDir: string;
  pathKey: string;
  childName: string;
}): string {
  if (
    args.childName === "." ||
    args.childName === ".." ||
    path.posix.basename(args.childName) !== args.childName ||
    !REPO_DIR_NAME_PATTERN.test(args.childName)
  ) {
    throw new WorkspaceError(
      "invalid_source_path",
      "A managed worktree directory name must be a safe path segment",
    );
  }
  return path.join(resolveWorktreeAttemptRoot(args), args.childName);
}
