/**
 * Unified install-ref dispatcher.
 *
 * Replaces the historical `installRegistryRef()` entry point. Given an
 * unparsed install ref, this resolves the right syncable provider and
 * invokes its `sync()` method.
 *
 * Audit is intentionally NOT performed here; callers (`akmAdd`,
 * `akmUpdate`) decide whether to run `auditInstallCandidate` on the
 * synced `contentDir` because they own the `--trust` flag.
 */

import { UsageError } from "../errors";
import { parseRegistryRef } from "../registry-resolve";
import type { ParsedLocalRef, StashSource } from "../registry-types";
import type { StashLockData, SyncOptions } from "../stash-provider";
import { detectStashRoot } from "./provider-utils";

export async function syncFromRef(ref: string, options?: SyncOptions): Promise<StashLockData> {
  const parsed = parseRegistryRef(ref);
  if (parsed.source === "local") {
    return syncLocalRef(parsed, options);
  }
  if (parsed.source === "npm") {
    const { syncNpmRef } = await import("./npm");
    return syncNpmRef(ref, options);
  }
  if (parsed.source === "git" || parsed.source === "github") {
    const { syncRegistryGitRef } = await import("./git");
    return syncRegistryGitRef(ref, options);
  }
  // Exhaustiveness — `parseRegistryRef` only emits the four sources above.
  throw new UsageError(`No syncable provider for ref: ${ref} (source=${(parsed as { source: StashSource }).source})`);
}

function syncLocalRef(parsed: ParsedLocalRef, options?: SyncOptions): StashLockData {
  const stashRoot = detectStashRoot(parsed.sourcePath);
  const syncedAt = (options?.now ?? new Date()).toISOString();
  return {
    id: parsed.id,
    source: "local",
    ref: parsed.ref,
    artifactUrl: parsed.sourcePath,
    contentDir: stashRoot,
    cacheDir: parsed.sourcePath,
    extractedDir: parsed.sourcePath,
    writable: options?.writable,
    syncedAt,
  };
}
