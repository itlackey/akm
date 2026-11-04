// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Explicit human retirement. No proposal rows, approval or invented successor. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetPathForName, stashDirFor } from "../../core/asset/asset-placement";
import { parseFrontmatter } from "../../core/asset/frontmatter";
import { parseRefInput } from "../../core/asset/resolve-ref";
import { isWithin, toErrorMessage } from "../../core/common";
import { loadConfig } from "../../core/config/config";
import { UsageError } from "../../core/errors";
import type { ArchivedMemoryCleanupRecord } from "../../core/improve-types";
import { resolveBundleWriteTarget } from "../../core/mutation-target";
import { recordWrittenPath } from "../../core/write-provenance";
import {
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  withWriteTargetMutation,
} from "../../core/write-source";
import { withAssetMutationLease } from "../../indexer/index-writer-lock";
import { indexWrittenAssets } from "../../indexer/index-written-assets";
import { closeDatabase, openReadonlyExistingDatabase } from "../../storage/repositories/index-connection";
import { getEntryIdByFilePath } from "../../storage/repositories/index-entries-repository";
import { archiveCleanupCandidate, derivedTwinPath } from "../improve/memory/memory-improve";
import { handleApiRequest } from "./api";
import { assertWriteLeaseFree } from "./proposal-actions";

const ARCHIVE = ".akm/memory-cleanup/archive";

function expectedAsset(root: string, ref: string): string {
  const identity = parseRefInput(ref),
    dir = stashDirFor(identity.type);
  if (!dir || ["skill", "secret", "env", "session"].includes(identity.type))
    throw new UsageError("Retire supports single-file assets, not skill packages or protected files.");
  return assetPathForName(identity.type, path.join(root, dir), identity.name);
}

/** Refuse symlinks (including a dangling final path) and escapes before any read or copy. */
function contained(root: string, file: string): void {
  const relative = path.relative(root, file);
  if (!relative || !isWithin(file, root)) throw new UsageError("Archive path escapes its bundle.");
  let cursor = fs.realpathSync(root);
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new UsageError("Archive paths cannot contain symbolic links.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
}

async function refresh(target: ResolvedWriteTarget, files: string[], warnings: string[]) {
  if (!(await indexWrittenAssets(target.source.path, files, { bundleId: target.source.name })))
    warnings.push("Files changed, but indexing could not finish. Run akm index before relying on search.");
  try {
    const db = openReadonlyExistingDatabase();
    if (db)
      try {
        if (files.some((file) => !fs.existsSync(file) && getEntryIdByFilePath(db, file) !== undefined))
          warnings.push("A retired entry is still indexed. Run akm index after the active rebuild finishes.");
      } finally {
        closeDatabase(db);
      }
  } catch (error) {
    warnings.push(`Files changed, but index verification failed: ${toErrorMessage(error)}`);
  }
}

export async function retireAsset(ref: string, revision: string) {
  await assertWriteLeaseFree("manual-retire");
  return withAssetMutationLease("manual-retire", async () => {
    const shown = (await handleApiRequest("/api/asset", new URLSearchParams({ ref }))) as {
      durableRef: string;
      redacted: boolean;
      asset: { path?: string };
    };
    if (!shown.durableRef || shown.redacted || !shown.asset.path)
      throw new UsageError("Choose an indexed local asset.");
    const identity = parseRefInput(shown.durableRef);
    const target = prepareWriteTargetForMutation(resolveBundleWriteTarget(loadConfig(), identity.origin!));
    const root = path.resolve(target.source.path),
      file = expectedAsset(root, shown.durableRef);
    contained(root, file);
    if (path.resolve(shown.asset.path) !== file) throw new UsageError("Refresh the index before retiring this file.");
    const bytes = fs.readFileSync(file);
    if (!fs.statSync(file).isFile() || bytes.includes(0) || !Buffer.from(bytes.toString("utf8")).equals(bytes))
      throw new UsageError("Only text assets can be retired here.");
    if (createHash("sha256").update(bytes).digest("hex") !== revision)
      throw new UsageError("The asset changed. Reload before retiring it.", "ASSET_CONTENT_CHANGED");
    const twin = derivedTwinPath(file, identity.type),
      files = twin ? [file, twin] : [file];
    for (const source of files) {
      contained(root, source);
      if (!fs.statSync(source).isFile()) throw new UsageError("Only regular asset files can be retired here.");
    }
    contained(root, path.join(root, ARCHIVE));
    const archived: ArchivedMemoryCleanupRecord[] = [],
      warnings: string[] = [];
    const paths = [...files];
    try {
      withWriteTargetMutation(
        target,
        paths,
        { purpose: "manual-retire", message: `retire: ${shown.durableRef}` },
        () => {
          // Archive once, immediately. The core tombstone is written before each rename.
          for (const source of files) {
            const assetRef = source === file ? shown.durableRef : `${shown.durableRef}.derived`;
            const record = archiveCleanupCandidate(
              root,
              { ref: assetRef, reason: "manual", ...(source === file ? {} : { parentRef: shown.durableRef }) },
              source,
            );
            archived.push(record);
            paths.push(path.join(root, record.auditPath), path.join(root, record.archivedPath));
          }
        },
      );
    } catch (error) {
      if (!archived.length) throw error;
      warnings.push(`Archiving or Git publishing needs attention: ${toErrorMessage(error)}`);
    }
    await refresh(target, files, warnings);
    if (identity.type === "task")
      warnings.push("Installed schedules are not changed. Run akm task sync to reconcile them.");
    return {
      ref: shown.durableRef,
      bundle: target.source.name,
      root,
      archived,
      complete: files.every((source) => !fs.existsSync(source)),
      warnings,
    };
  });
}

/** Undo from the native tombstones, never by trusting caller-supplied source/destination pairs. */
export async function restoreRetiredAssets(bundle: string, archives: string[]) {
  await assertWriteLeaseFree("manual-restore");
  return withAssetMutationLease("manual-restore", async () => {
    const target = prepareWriteTargetForMutation(resolveBundleWriteTarget(loadConfig(), bundle));
    const root = path.resolve(target.source.path);
    const records = [...new Set(archives)].map((relative) => {
      const audit = path.resolve(root, relative);
      contained(root, audit);
      if (!isWithin(audit, path.join(root, ARCHIVE)) || path.basename(audit) !== "cleanup.md")
        throw new UsageError("Use the archive paths from a manual retirement receipt.");
      const data = parseFrontmatter(fs.readFileSync(audit, "utf8")).data;
      if (
        data.kind !== "memory-cleanup-archive" ||
        data.reason !== "manual" ||
        typeof data.ref !== "string" ||
        typeof data.originalPath !== "string" ||
        typeof data.archivedPath !== "string"
      )
        throw new UsageError("Not a manual retirement tombstone.");
      const original = path.resolve(root, data.originalPath),
        archived = path.resolve(root, data.archivedPath);
      contained(root, original);
      contained(root, archived);
      if (
        !isWithin(archived, path.dirname(audit)) ||
        original !== expectedAsset(root, data.ref) ||
        parseRefInput(data.ref).origin !== target.source.name
      )
        throw new UsageError("Archive paths do not match the recorded asset.");
      if (fs.existsSync(original))
        throw new UsageError(
          "The original path is occupied. Restore will not overwrite newer work.",
          "ASSET_CONTENT_CHANGED",
        );
      if (!fs.statSync(archived).isFile()) throw new UsageError("The archived file is missing.");
      return { original, archived, ref: data.ref };
    });
    if (new Set(records.map((record) => record.original)).size !== records.length)
      throw new UsageError("Duplicate restore destinations.");
    const restored: string[] = [],
      warnings: string[] = [];
    try {
      withWriteTargetMutation(
        target,
        records.map((record) => record.original),
        { purpose: "manual-restore", message: "restore: manually retired assets" },
        () => {
          for (const record of records) {
            fs.mkdirSync(path.dirname(record.original), { recursive: true });
            fs.copyFileSync(record.archived, record.original, fs.constants.COPYFILE_EXCL);
            restored.push(record.original);
            fs.chmodSync(record.original, fs.statSync(record.archived).mode & 0o777);
            recordWrittenPath(record.original);
          }
        },
      );
    } catch (error) {
      if (!restored.length) throw error;
      warnings.push(`Restore or Git publishing needs attention: ${toErrorMessage(error)}`);
    }
    await refresh(target, restored, warnings);
    return { restored, complete: restored.length === records.length, warnings };
  });
}
