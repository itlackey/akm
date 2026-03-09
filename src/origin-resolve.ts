import path from "node:path"
import type { StashSource } from "./stash-source"
import { parseRegistryRef } from "./registry-resolve"

/**
 * Given an origin string (from an AssetRef) and the full list of stash
 * sources, return the subset of sources to search.
 *
 * Resolution order:
 *   1. undefined   → all sources (working → mounted → installed)
 *   2. "local"     → working stash only
 *   3. exact match → installed source whose registryId matches verbatim
 *   4. parsed match → parse origin as a registry ref, match by parsed ID
 *   5. path match  → mounted source whose path matches
 *   6. empty       → indicates a remote/uninstalled origin (caller decides)
 */
export function resolveSourcesForOrigin(
  origin: string | undefined,
  allSources: StashSource[],
): StashSource[] {
  if (!origin) return allSources

  if (origin === "local") {
    return allSources.filter((s) => s.kind === "working")
  }

  // Exact registryId match (e.g. origin is "npm:@scope/pkg")
  const byExactId = allSources.filter(
    (s) => s.kind === "installed" && s.registryId === origin,
  )
  if (byExactId.length > 0) return byExactId

  // Parse origin as a registry ref and match by parsed ID.
  // Allows shorthand: "owner/repo" matches "github:owner/repo",
  // "@scope/pkg" matches "npm:@scope/pkg".
  try {
    const parsed = parseRegistryRef(origin)
    const byParsedId = allSources.filter(
      (s) => s.kind === "installed" && s.registryId === parsed.id,
    )
    if (byParsedId.length > 0) return byParsedId
  } catch {
    // Not a valid registry ref — continue to path matching
  }

  // Mounted stash by resolved path
  const resolvedOrigin = path.resolve(origin)
  const byPath = allSources.filter(
    (s) => s.kind === "mounted" && path.resolve(s.path) === resolvedOrigin,
  )
  if (byPath.length > 0) return byPath

  // No match — origin may be remote/uninstalled
  return []
}

/**
 * Check whether an origin refers to something that could be fetched remotely
 * (i.e. it looks like a registry ref but isn't installed locally).
 */
export function isRemoteOrigin(
  origin: string,
  allSources: StashSource[],
): boolean {
  if (origin === "local") return false
  return resolveSourcesForOrigin(origin, allSources).length === 0
}
