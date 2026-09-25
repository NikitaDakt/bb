import path from "node:path";
import { PLUGIN_PROCESS_DATA_KINDS } from "@bb/process-utils";
import { isWindowsHostPath } from "../hosts/host-paths.js";

const LEGACY_WORKSPACE_ROOT_NAMES = ["worktrees", "personal-workspaces"];

export function isBbManagedWorkspacePath(args: {
  dataDir: string;
  path: string;
}): boolean {
  const paths = isWindowsHostPath(args.dataDir) ? path.win32 : path.posix;
  const relative = paths.relative(args.dataDir, args.path);
  const [root, pluginSegment, kind] = (
    paths === path.win32 ? relative.toLowerCase() : relative
  ).split(paths.sep);
  if (root !== undefined && LEGACY_WORKSPACE_ROOT_NAMES.includes(root))
    return true;
  return (
    root === "plugins" &&
    pluginSegment !== undefined &&
    pluginSegment.length > 0 &&
    kind !== undefined &&
    PLUGIN_PROCESS_DATA_KINDS.some((candidate) => candidate === kind)
  );
}
