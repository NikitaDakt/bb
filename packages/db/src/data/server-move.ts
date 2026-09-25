import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { posix, win32 } from "node:path";
import { isNativeWindowsProjectPath } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import {
  hosts,
  installedPlugins,
  pluginArtifacts,
  pluginMarketplaces,
  pluginStateSnapshots,
} from "../schema.js";

export interface RerootServerOwnedPathsArgs {
  fromRoot: string;
  toRoot: string;
}

export interface RerootServerOwnedPathsResult {
  pluginArtifacts: number;
  pluginMarketplaces: number;
  pluginStateSnapshots: number;
  plugins: number;
}

export interface SwapServerHostRolesArgs {
  sourceServerHostId: string | null;
  targetHostId: string;
  now: number;
}

export interface SwapServerHostRolesResult {
  sourceServerHostBecameManual: boolean;
  targetHostBecameServer: boolean;
}

export interface PathInstalledPluginSource {
  id: string;
  sourcePath: string;
}

const MANUAL_MACHINE_PROVIDER_ID = "manual";

function rootPaths(root: string) {
  return isNativeWindowsProjectPath(root) ? win32 : posix;
}

function normalizedPathColumn(column: SQLiteColumn, root: string) {
  return rootPaths(root) === win32
    ? sql`replace(${column}, '/', ${"\\"}) collate nocase`
    : column;
}

function rootPrefix(root: string): string {
  const separator = rootPaths(root).sep;
  return root.endsWith(separator) ? root : `${root}${separator}`;
}

function isUnderRoot(column: SQLiteColumn, root: string): SQL {
  const prefix = rootPrefix(root);
  const value = normalizedPathColumn(column, root);
  return or(
    sql`${value} = ${root}`,
    sql`substr(${value}, 1, length(${prefix})) = ${prefix}`,
  )!;
}

function rerootedValue(column: SQLiteColumn, args: RerootServerOwnedPathsArgs) {
  const value = normalizedPathColumn(column, args.fromRoot);
  let suffix = sql`substr(${value}, length(${rootPrefix(args.fromRoot)}) + 1)`;
  const fromSeparator = rootPaths(args.fromRoot).sep;
  const toSeparator = rootPaths(args.toRoot).sep;
  if (fromSeparator !== toSeparator) {
    suffix = sql`replace(${suffix}, ${fromSeparator}, ${toSeparator})`;
  }
  return sql`case when ${value} = ${args.fromRoot} then ${args.toRoot} else ${rootPrefix(args.toRoot)} || ${suffix} end`;
}

function rerootCondition(
  column: SQLiteColumn,
  args: RerootServerOwnedPathsArgs,
): SQL {
  const paths = rootPaths(args.fromRoot);
  const relative = paths.relative(args.fromRoot, args.toRoot);
  const toRootNestedInFromRoot =
    paths === rootPaths(args.toRoot) &&
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${paths.sep}`) &&
    !paths.isAbsolute(relative);
  return toRootNestedInFromRoot
    ? and(
        isUnderRoot(column, args.fromRoot),
        sql`not (${isUnderRoot(column, args.toRoot)})`,
      )!
    : isUnderRoot(column, args.fromRoot);
}

function rerootPluginColumns(
  transaction: DbTransaction,
  args: RerootServerOwnedPathsArgs,
): number {
  let changes = transaction
    .update(installedPlugins)
    .set({ rootDir: rerootedValue(installedPlugins.rootDir, args) })
    .where(rerootCondition(installedPlugins.rootDir, args))
    .run().changes;
  changes += transaction
    .update(installedPlugins)
    .set({ sourcePath: rerootedValue(installedPlugins.sourcePath, args) })
    .where(
      and(
        isNotNull(installedPlugins.sourcePath),
        rerootCondition(installedPlugins.sourcePath, args),
      ),
    )
    .run().changes;
  return changes;
}

function rerootArtifactColumns(
  transaction: DbTransaction,
  args: RerootServerOwnedPathsArgs,
): number {
  let changes = transaction
    .update(pluginArtifacts)
    .set({ path: rerootedValue(pluginArtifacts.path, args) })
    .where(rerootCondition(pluginArtifacts.path, args))
    .run().changes;
  changes += transaction
    .update(pluginArtifacts)
    .set({
      gitCheckoutRoot: rerootedValue(pluginArtifacts.gitCheckoutRoot, args),
    })
    .where(
      and(
        isNotNull(pluginArtifacts.gitCheckoutRoot),
        rerootCondition(pluginArtifacts.gitCheckoutRoot, args),
      ),
    )
    .run().changes;
  return changes;
}

function rerootSnapshotColumns(
  transaction: DbTransaction,
  args: RerootServerOwnedPathsArgs,
): number {
  let changes = transaction
    .update(pluginStateSnapshots)
    .set({ snapshotPath: rerootedValue(pluginStateSnapshots.snapshotPath, args) })
    .where(rerootCondition(pluginStateSnapshots.snapshotPath, args))
    .run().changes;
  changes += transaction
    .update(pluginStateSnapshots)
    .set({ statePath: rerootedValue(pluginStateSnapshots.statePath, args) })
    .where(rerootCondition(pluginStateSnapshots.statePath, args))
    .run().changes;
  changes += transaction
    .update(pluginStateSnapshots)
    .set({ databasePath: rerootedValue(pluginStateSnapshots.databasePath, args) })
    .where(
      and(
        isNotNull(pluginStateSnapshots.databasePath),
        rerootCondition(pluginStateSnapshots.databasePath, args),
      ),
    )
    .run().changes;
  changes += transaction
    .update(pluginStateSnapshots)
    .set({ secretsPath: rerootedValue(pluginStateSnapshots.secretsPath, args) })
    .where(
      and(
        isNotNull(pluginStateSnapshots.secretsPath),
        rerootCondition(pluginStateSnapshots.secretsPath, args),
      ),
    )
    .run().changes;
  changes += transaction
    .update(pluginStateSnapshots)
    .set({
      registrationPath: rerootedValue(
        pluginStateSnapshots.registrationPath,
        args,
      ),
    })
    .where(
      and(
        isNotNull(pluginStateSnapshots.registrationPath),
        rerootCondition(pluginStateSnapshots.registrationPath, args),
      ),
    )
    .run().changes;
  return changes;
}

function rerootMarketplaceColumns(
  transaction: DbTransaction,
  args: RerootServerOwnedPathsArgs,
): number {
  return transaction
    .update(pluginMarketplaces)
    .set({ manifestUrl: rerootedValue(pluginMarketplaces.manifestUrl, args) })
    .where(
      and(
        eq(pluginMarketplaces.sourceKind, "path"),
        rerootCondition(pluginMarketplaces.manifestUrl, args),
      ),
    )
    .run().changes;
}

export function rerootServerOwnedPluginPaths(
  db: DbConnection,
  args: RerootServerOwnedPathsArgs,
): RerootServerOwnedPathsResult {
  if (!rootPaths(args.fromRoot).isAbsolute(args.fromRoot) || !rootPaths(args.toRoot).isAbsolute(args.toRoot)) {
    throw new Error("Server data directories must be absolute paths");
  }
  args = {
    fromRoot: rootPaths(args.fromRoot).normalize(args.fromRoot),
    toRoot: rootPaths(args.toRoot).normalize(args.toRoot),
  };
  if (
    rootPaths(args.fromRoot) === rootPaths(args.toRoot) &&
    rootPaths(args.fromRoot).relative(args.fromRoot, args.toRoot) === ""
  ) {
    return {
      pluginArtifacts: 0,
      pluginMarketplaces: 0,
      pluginStateSnapshots: 0,
      plugins: 0,
    };
  }
  return db.transaction((transaction) => ({
    plugins: rerootPluginColumns(transaction, args),
    pluginArtifacts: rerootArtifactColumns(transaction, args),
    pluginStateSnapshots: rerootSnapshotColumns(transaction, args),
    pluginMarketplaces: rerootMarketplaceColumns(transaction, args),
  }));
}

export function swapServerHostRoles(
  db: DbConnection,
  args: SwapServerHostRolesArgs,
): SwapServerHostRolesResult {
  return db.transaction((transaction) => {
    const targetHostBecameServer =
      transaction
        .update(hosts)
        .set({ machineProviderId: null, resource: null, updatedAt: args.now })
        .where(
          and(
            eq(hosts.id, args.targetHostId),
            eq(hosts.machineProviderId, MANUAL_MACHINE_PROVIDER_ID),
          ),
        )
        .run().changes > 0;
    const sourceServerHostId = args.sourceServerHostId;
    const sourceServerHostBecameManual =
      sourceServerHostId !== null &&
      sourceServerHostId !== args.targetHostId &&
      transaction
        .update(hosts)
        .set({
          machineProviderId: MANUAL_MACHINE_PROVIDER_ID,
          resource: { version: 1, hostId: sourceServerHostId },
          updatedAt: args.now,
        })
        .where(
          and(
            eq(hosts.id, sourceServerHostId),
            isNull(hosts.machineProviderId),
          ),
        )
        .run().changes > 0;
    return { sourceServerHostBecameManual, targetHostBecameServer };
  });
}

export function listPathInstalledPluginSources(
  db: DbConnection,
): PathInstalledPluginSource[] {
  return db
    .select({
      id: installedPlugins.id,
      sourcePath: installedPlugins.sourcePath,
    })
    .from(installedPlugins)
    .where(
      and(
        eq(installedPlugins.sourceKind, "path"),
        isNull(installedPlugins.removedAt),
        isNotNull(installedPlugins.sourcePath),
      ),
    )
    .all()
    .flatMap((row) =>
      row.sourcePath === null ? [] : [{ id: row.id, sourcePath: row.sourcePath }],
    );
}
