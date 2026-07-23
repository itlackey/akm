// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * write-source — the command-layer helper that performs asset writes.
 *
 * v1 architecture spec §2.6 / §2.7 / §10 step 5 (amended for 0.9.0): writing to
 * a source is *not* a SourceProvider interface concern. It's a small
 * command-layer helper that does a plain filesystem write for **every** kind.
 *
 * 0.9.0 amendment (issue #507): the per-asset git commit/push path is retired.
 * `writeAssetToSource` / `deleteAssetFromSource` no longer branch on `kind` for
 * commit behaviour — they only ever touch the filesystem. Git-backed targets
 * are committed in a SINGLE batch at the operation boundary via
 * {@link commitWriteTargetBoundary} (which delegates to `saveGitStash`). This
 * stages only operation-owned paths that still have a Git status entry as one
 * complete commit instead of one noisy, incomplete commit per asset.
 *
 * This module is still the **single dispatch point** for write/delete: callers
 * (remember, import, source-add, etc.) MUST go through `writeAssetToSource` /
 * `deleteAssetFromSource` rather than re-inlining a filesystem write, and they
 * fire {@link commitWriteTargetBoundary} once after a batch of mutations to a
 * writable git target.
 */

import fs from "node:fs";
import path from "node:path";
import { lockContentRootFor } from "../integrations/lockfile";
import { getCachePaths, listGitChangedPaths, parseGitRepoUrl, saveGitStash } from "../sources/providers/git";
import { assetPathForName, stashDirFor } from "./asset/asset-placement";
import type { AssetRef } from "./asset/resolve-ref";
import { displayRef } from "./asset/resolve-ref";
import { isWithin, resolveStashDir } from "./common";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry } from "./config/config";
import { resolveConfiguredSources } from "./config/config";
import { ConfigError, UsageError } from "./errors";
import { sanitizeCommitMessage } from "./git-message";
import { warn } from "./warn";

// Re-exported so existing `import { sanitizeCommitMessage } from
// "./core/write-source"` sites are unaffected by the KILL 6 sever (the
// helper moved to git-message.ts to break the write-source.ts → git.ts →
// git-stash.ts → write-source.ts 3-file import cycle).
export { sanitizeCommitMessage };

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal shape required by {@link writeAssetToSource}. Lets the helper run
 * against either the legacy {@link ConfiguredSource} runtime value (today's
 * code on `release/0.6.0`) or the post-Phase-3 simplified `SourceProvider`
 * interface — both expose a `kind`/`name`/`path` triple.
 *
 * `kind` is the branching discriminator for the helper. The set of supported
 * values is `"filesystem"` and `"git"`. Anything else throws `ConfigError`.
 */
export interface WriteTargetSource {
  /** Discriminator for write dispatch (`"filesystem"` | `"git"`). */
  readonly kind: string;
  /** Human-readable identifier surfaced in error messages. */
  readonly name: string;
  /** Absolute filesystem path the indexer walks. The asset is written here. */
  readonly path: string;
  /** Git repository root used only for sync/commit boundaries. */
  readonly repoPath?: string;
}

/**
 * Source kinds that the loader is allowed to mark `writable: true`. Anything
 * else is rejected at config load (per locked decision 4) — see
 * {@link assertWritableAllowedForKind}.
 */
const REJECTED_WRITABLE_KINDS: ReadonlySet<string> = new Set(["website", "npm"]);

const pendingGitPaths = new Map<string, Set<string>>();

function gitTargetKey(source: WriteTargetSource): string {
  return `${path.resolve(source.repoPath ?? source.path)}\0${path.resolve(source.path)}`;
}

/** Register a successful direct mutation for the target's exact-path boundary commit. */
export function recordWriteTargetPath(source: WriteTargetSource, filePath: string): void {
  if (source.kind !== "git") return;
  const key = gitTargetKey(source);
  const paths = pendingGitPaths.get(key) ?? new Set<string>();
  paths.add(path.resolve(filePath));
  pendingGitPaths.set(key, paths);
}

function takeGitTargetPaths(source: WriteTargetSource): string[] {
  const key = gitTargetKey(source);
  const absolutePaths = pendingGitPaths.get(key);
  pendingGitPaths.delete(key);
  if (!absolutePaths) return [];
  const repoDir = path.resolve(source.repoPath ?? source.path);
  return [...absolutePaths]
    .map((filePath) => path.relative(repoDir, filePath).replaceAll(path.sep, "/"))
    .filter((filePath) => filePath && filePath !== ".." && !filePath.startsWith("../"));
}

// ── Portability advisory (review 13, D1) ────────────────────────────────────

/**
 * Matches an absolute host **home** path — `/home/<user>` or `/Users/<user>` —
 * requiring at least one user segment after the prefix. A bare `/home/` or
 * `/Users/` (no user segment) does NOT match. The user segment stops at the
 * first path separator, whitespace, or common delimiter so we capture just the
 * `/home/<user>` prefix rather than the whole path.
 *
 * Deliberately conservative: it does not exempt fenced code blocks, so content
 * that legitimately *documents* a system path (e.g. a tutorial) can produce a
 * false positive. That is accepted — the advisory is non-fatal and correctness
 * (never missing a real leak) is preferred over cleverness here.
 */
const ABSOLUTE_HOME_PATH_RE = /\/(?:home|Users)\/[^\s/"'`)\]}<>|:;,]+/g;

/**
 * Return the distinct `/home/<user>` / `/Users/<user>` prefixes embedded in
 * `content`, in first-seen order. Empty when the content is portable.
 *
 * Used by {@link writeAssetToSource} to emit a write-time advisory: absolute
 * host home paths make the stash non-portable and leak the local username.
 */
export function findAbsoluteHomePaths(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(ABSOLUTE_HOME_PATH_RE)) {
    seen.add(match[0]);
  }
  return [...seen];
}

// ── Public helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the effective `writable` flag for a source config entry, applying
 * the v1 default policy from spec §5.4:
 *
 *  - `filesystem` → `true` by default
 *  - everything else → `false` by default
 *
 * Users can opt out for `filesystem` via `writable: false`. They cannot opt
 * **in** for `website` / `npm` — that combination is rejected at config load
 * (see {@link assertWritableAllowedForKind}).
 */
export function resolveWritable(entry: Pick<SourceConfigEntry, "type" | "writable">): boolean {
  if (typeof entry.writable === "boolean") return entry.writable;
  return entry.type === "filesystem";
}

/**
 * Reject `writable: true` on `website` / `npm` sources at config-load time.
 * Per locked decision 4 (§6 of the v1 implementation plan): `sync()` would
 * clobber writes on the next refresh, so allowing writes here is a footgun.
 *
 * Throws {@link ConfigError} when the combination is rejected.
 */
export function assertWritableAllowedForKind(entry: Pick<SourceConfigEntry, "type" | "writable" | "name">): void {
  if (entry.writable !== true) return;
  if (REJECTED_WRITABLE_KINDS.has(entry.type)) {
    const label = entry.name ? ` "${entry.name}"` : "";
    throw new ConfigError(
      `writable: true is only supported on filesystem and git sources (got "${entry.type}" on source${label}).`,
      "INVALID_CONFIG_FILE",
      "To author into a checked-out package, add the same path as a separate filesystem source.",
    );
  }
}

/**
 * Write a textual asset (`content`) into `source` at the path implied by
 * `ref`. Always:
 *
 *   1. Refuses if `config.writable` is not truthy (per §5.4).
 *   2. Rejects unsupported kinds (anything but `filesystem` / `git`).
 *   3. Performs a plain filesystem write to `path.join(source.path, …)`.
 *
 * No commit runs here — for **every** kind. Git-backed targets are committed in
 * one batch at the operation boundary via {@link commitWriteTargetBoundary}
 * (0.9.0 amendment, issue #507). The caller fires that boundary commit once
 * after a batch of mutations to a writable git target.
 */
export async function writeAssetToSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
  content: string,
): Promise<{ path: string; ref: string }> {
  ensureWritable(source, config);
  assertSupportedKind(source);

  const filePath = resolveAssetFilePath(source, ref);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  fs.writeFileSync(filePath, normalized, "utf8");
  recordWriteTargetPath(source, filePath);

  // Non-fatal portability advisory (review 13, D1): flag absolute host home
  // paths in the written content. These make the stash non-portable and leak
  // the local username. We warn AFTER the write so the advisory never blocks it.
  const hostPaths = findAbsoluteHomePaths(normalized);
  if (hostPaths.length > 0) {
    warn(
      `warning: asset "${formatRefForMessage(ref)}" embeds absolute host path(s): ${hostPaths.join(", ")}. ` +
        "These make the stash non-portable and leak the local username — prefer $HOME or ~ relative references.",
    );
  }

  return { path: filePath, ref: displayRef({ type: ref.type, name: ref.name, bundleId: ref.origin }) };
}

/**
 * Delete the asset at `ref` from `source`. Symmetric to
 * {@link writeAssetToSource}: same writable check, same unsupported-kind guard,
 * a plain `unlink` with no commit. Git-backed targets are committed once at the
 * operation boundary via {@link commitWriteTargetBoundary}.
 */
export async function deleteAssetFromSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
): Promise<{ path: string; ref: string }> {
  ensureWritable(source, config);
  assertSupportedKind(source);

  const filePath = resolveAssetFilePath(source, ref);
  if (!fs.existsSync(filePath)) {
    throw new UsageError(
      `Asset "${formatRefForMessage(ref)}" not found in source "${source.name}" (expected at ${filePath}).`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  fs.unlinkSync(filePath);
  recordWriteTargetPath(source, filePath);

  return { path: filePath, ref: displayRef({ type: ref.type, name: ref.name, bundleId: ref.origin }) };
}

/**
 * Fire the one-shot batch-at-boundary commit for a resolved write target.
 *
 * 0.9.0 (issue #507): replaces the retired per-asset git commit. Callers invoke
 * this EXACTLY ONCE after a batch of writes/deletes to a resolved write target.
 * It is a no-op for any non-git target (plain filesystem sources and the
 * primary stash stay non-committing here — the primary stash is committed by
 * the existing improve auto-sync boundary).
 *
 * For a git target it delegates to `saveGitStash(name, message, writable, …)`
 * with the exact paths recorded by the write/delete helpers (plus any explicit
 * caller paths), commits once, and pushes when the target is writable, has a
 * remote, and `push !== false`.
 *
 * The deprecated `options.pushOnCommit` on the source config is now fully
 * IGNORED (Decision 6, WI-9.6b): it neither sets nor suppresses `push`. Only a
 * one-time deprecation warning remains (see {@link warnIfPushOnCommit}).
 */
export function commitWriteTargetBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: { push?: boolean; paths?: string[] },
): void {
  if (target.source.kind !== "git") return;

  warnIfPushOnCommit(target.config);

  const push = options?.push;

  const writable = resolveWritable(target.config);
  const repoDir = target.source.repoPath ?? target.source.path;
  const changedPaths = new Set(listGitChangedPaths(repoDir));
  const paths = [...new Set([...(options?.paths ?? []), ...takeGitTargetPaths(target.source)])]
    .map((filePath) => filePath.replaceAll(path.sep, "/"))
    .filter((filePath) => changedPaths.has(filePath));
  // Assets may live under <repo>/content, but git synchronization always runs
  // against the repository root.
  saveGitStash(undefined, message, writable, {
    repoDir,
    paths,
    ...(push === undefined ? {} : { push }),
  });
}

/**
 * Emit a one-time deprecation warning the first time a source config carrying
 * `options.pushOnCommit` is encountered. The field still parses (for old
 * configs) but is now FULLY IGNORED (Decision 6, WI-9.6b): it no longer maps
 * onto the batch push gate in any way (neither opts in nor opts out). The
 * field will be REMOVED in 0.10.
 */
let pushOnCommitWarned = false;
function warnIfPushOnCommit(config: SourceConfigEntry): void {
  if (config.options?.pushOnCommit === undefined) return;
  if (pushOnCommitWarned) return;
  pushOnCommitWarned = true;
  const label = config.name ? ` on source "${config.name}"` : "";
  process.stderr.write(
    `warning: \`options.pushOnCommit\`${label} is deprecated (0.9.0) and now fully ignored — it no longer ` +
      "affects push behaviour in any way. akm commits writes in a single batch at the operation boundary and " +
      "pushes when the target is writable with a remote and push isn't explicitly disabled. Remove the option " +
      "or rely on sync push instead; it will be REMOVED in 0.10.\n",
  );
}

// ── Write-target resolution (locked decision 3) ─────────────────────────────

/**
 * Result of {@link resolveWriteTarget}: the chosen source plus the persisted
 * config entry that drove the decision. Callers pass both straight into
 * {@link writeAssetToSource}.
 */
export interface ResolvedWriteTarget {
  /** Configured source name used when an API must re-resolve the destination. */
  selector?: string;
  /** Stable source identity. Durable state uses `source.name`. */
  source: WriteTargetSource;
  config: SourceConfigEntry;
}

/** Enumerate enabled writable targets, deduplicated by materialized content root. */
export function resolveWritableTargets(akmConfig: AkmConfig): ResolvedWriteTarget[] {
  const byRoot = new Map<string, ResolvedWriteTarget>();
  for (const runtime of resolveConfiguredSources(akmConfig)) {
    if (runtime.enabled === false || !resolveWritable({ type: runtime.type, writable: runtime.writable })) continue;
    const target = adaptConfiguredSource(runtime);
    const root = path.resolve(target.source.path);
    const existing = byRoot.get(root);
    if (!existing || target.source.name === akmConfig.defaultWriteTarget) byRoot.set(root, target);
  }
  if (byRoot.size === 0) {
    try {
      const stashDir = resolveStashDir({ readOnly: true });
      byRoot.set(path.resolve(stashDir), {
        source: { kind: "filesystem", name: "stash", path: stashDir },
        config: { type: "filesystem", path: stashDir, name: "stash", writable: true },
      });
    } catch {
      // No active working stash; configured writable targets above are complete.
    }
  }
  return [...byRoot.values()];
}

/**
 * Resolve the destination for a write per locked decision 3:
 *
 *   1. Explicit `--target <name>` (when supplied)
 *   2. `config.defaultWriteTarget`
 *   3. `config.defaultBundle`'s path (the working stash created by `akm init`)
 *   4. `ConfigError("no writable source configured; run `akm init`")`
 *
 * The legacy `first-writable-in-source-array-order` fallback is *not* used —
 * see plan §6 decision 3 for the rationale.
 */
export function resolveWriteTarget(
  akmConfig: AkmConfig,
  explicitTarget?: string,
  options: { requireWritable?: boolean } = {},
): ResolvedWriteTarget {
  const configuredSources = resolveConfiguredSources(akmConfig);
  const requireWritable = options.requireWritable !== false;

  // 1. Explicit --target wins.
  if (explicitTarget) {
    const match = configuredSources.find((s) => s.name === explicitTarget);
    if (!match) {
      throw new UsageError(
        `--target must reference a source name from your config. No source named "${explicitTarget}" is configured. Run \`akm list\` to see available sources.`,
        "INVALID_FLAG_VALUE",
      );
    }
    // Up-front writable check so an explicit --target fails fast with a
    // ConfigError (rather than the generic UsageError ensureWritable would
    // raise after we've already started building paths). Resolve the
    // effective writable flag (filesystem defaults to true; everything else
    // defaults to false) so unset values are interpreted correctly.
    const effectiveWritable = resolveWritable({ type: match.type, writable: match.writable });
    if (requireWritable && !effectiveWritable) {
      throw new ConfigError(
        `source ${explicitTarget} is not writable`,
        "INVALID_CONFIG_FILE",
        `Set \`writable: true\` on the "${explicitTarget}" source in your config, or pass --target to a different source.`,
      );
    }
    return adaptConfiguredSource(match);
  }

  // 2. config.defaultWriteTarget.
  if (akmConfig.defaultWriteTarget) {
    const match = configuredSources.find((s) => s.name === akmConfig.defaultWriteTarget);
    if (match) {
      // BUG-H3: mirror the --target writability gate so a misconfigured
      // defaultWriteTarget pointed at a non-writable kind (website/npm) or
      // an explicit `writable: false` filesystem entry fails fast with a
      // ConfigError, rather than surfacing as a generic UsageError after
      // path-building has already begun.
      const effectiveWritable = resolveWritable({ type: match.type, writable: match.writable });
      if (requireWritable && !effectiveWritable) {
        throw new ConfigError(
          `defaultWriteTarget "${akmConfig.defaultWriteTarget}" is not writable`,
          "INVALID_CONFIG_FILE",
          `Set \`writable: true\` on the "${akmConfig.defaultWriteTarget}" source in your config, or change \`defaultWriteTarget\` to a writable source.`,
        );
      }
      return adaptConfiguredSource(match);
    }
    // Fall through if the named target no longer exists — surface a clear error.
    throw new ConfigError(
      `defaultWriteTarget "${akmConfig.defaultWriteTarget}" does not match any configured source.`,
      "INVALID_CONFIG_FILE",
      "Update `defaultWriteTarget` in your config (run `akm config get defaultWriteTarget`) or run `akm list` to see configured sources.",
    );
  }

  // 3. Working stash (config.stashDir / resolveStashDir()).
  //
  // The primary stash stays `kind: "filesystem"` on purpose, even when it is a
  // git repo on disk (recognized elsewhere via isGitBackedStash). Returning
  // `kind: "git"` here would fire the boundary commit on every write through
  // this resolver, double-committing the primary stash which is already
  // committed in a single batch at operation boundaries (e.g. the end-of-run
  // improve auto-sync via saveGitStash). Per-write stays non-committing.
  try {
    const stashDir = resolveStashDir({ readOnly: true });
    const defaultBundleSource = akmConfig.defaultBundle
      ? configuredSources.find((source) => source.name === akmConfig.defaultBundle && source.type === "filesystem")
      : undefined;
    if (defaultBundleSource) {
      const target = adaptConfiguredSource(defaultBundleSource);
      if (path.resolve(target.source.path) === path.resolve(stashDir)) {
        if (requireWritable && !resolveWritable(target.config)) {
          throw new ConfigError(
            `defaultBundle "${akmConfig.defaultBundle}" is not writable`,
            "INVALID_CONFIG_FILE",
            `Set \`writable: true\` on the "${akmConfig.defaultBundle}" bundle, or set \`defaultWriteTarget\` to a writable source.`,
          );
        }
        return { ...target, selector: undefined };
      }
    }
    return {
      source: { kind: "filesystem", name: "stash", path: stashDir },
      config: { type: "filesystem", path: stashDir, name: "stash", writable: true },
    };
  } catch {
    // Fall through to the final ConfigError below.
  }

  // 4. Nothing usable.
  throw new ConfigError(
    "no writable source configured; run `akm init`",
    "STASH_DIR_NOT_FOUND",
    "Run `akm init` to create a working stash, or set `defaultWriteTarget` in your config.",
  );
}

// ── Internals ───────────────────────────────────────────────────────────────

function ensureWritable(source: WriteTargetSource, config: SourceConfigEntry): void {
  // Apply the same default-resolution rule as resolveWritable so callers can
  // pass through a SourceConfigEntry with an absent `writable` field.
  const writable = resolveWritable(config);
  if (!writable) {
    throw new UsageError(
      `Source "${source.name}" is not writable. Set \`writable: true\` on the source config entry to enable writes.`,
      "INVALID_FLAG_VALUE",
    );
  }
}

function resolveAssetFilePath(source: WriteTargetSource, ref: AssetRef): string {
  const typeDir = stashDirFor(ref.type);
  if (!typeDir) {
    throw new UsageError(`Unknown asset type "${ref.type}". Cannot resolve a write path.`, "INVALID_FLAG_VALUE");
  }
  const typeRoot = path.join(source.path, typeDir);
  const assetPath = assetPathForName(ref.type, typeRoot, ref.name);
  if (!isWithin(assetPath, typeRoot)) {
    throw new UsageError(
      `Resolved asset path escapes its source: "${ref.name}" in source "${source.name}".`,
      "PATH_ESCAPE_VIOLATION",
    );
  }
  return assetPath;
}

/**
 * Reject any kind reaching the write/delete helpers other than the two
 * supported writable kinds. The config loader is the first line of defence
 * (assertWritableAllowedForKind), but we throw here so external callers that
 * bypass the loader still get a clear error.
 */
function assertSupportedKind(source: WriteTargetSource): void {
  if (source.kind === "filesystem" || source.kind === "git") return;
  throw new ConfigError(
    `write-source: unsupported kind "${source.kind}" for source "${source.name}". ` +
      "Writes are only defined for `filesystem` and `git` sources.",
    "INVALID_CONFIG_FILE",
    'Set `kind: "filesystem"` (or `kind: "git"`) on the source, or add a parallel filesystem entry.',
  );
}

export function formatRefForMessage(ref: AssetRef): string {
  // Sanitize each component independently. `ref.origin` originates from user
  // config and could contain CR/LF that would otherwise be smuggled into the
  // commit subject and forge trailers downstream. `ref.type` and `ref.name`
  // are also sanitized defensively — the asset-spec validator should already
  // reject control bytes there, but a single sanitizer at the boundary keeps
  // the contract explicit and centralized.
  const origin = ref.origin ? sanitizeCommitMessage(ref.origin) : "";
  const type = sanitizeCommitMessage(ref.type);
  const name = sanitizeCommitMessage(ref.name);
  return origin ? `${origin}//${type}:${name}` : `${type}:${name}`;
}

/**
 * Derive a {@link WriteTargetSource} + persisted {@link SourceConfigEntry}
 * from the runtime {@link ConfiguredSource} representation used elsewhere in
 * the codebase. The mapping is:
 *
 *   ConfiguredSource.type     → WriteTargetSource.kind
 *   ConfiguredSource.name     → WriteTargetSource.name
 *   ConfiguredSource.source.* → WriteTargetSource.path  (via parseSourceSpec)
 *
 * Legacy aliases (`context-hub`, `github`) have already been normalised to
 * `git` by the config loader, so this mapping is straightforward.
 */
function adaptConfiguredSource(runtime: ConfiguredSource): ResolvedWriteTarget {
  // Map the runtime kind to the write helper's `kind` discriminator. Only
  // filesystem and git produce writable sources at v1; any other kind
  // reaching this point is a config-loader bug (assertWritableAllowedForKind
  // should have rejected it). Throw a ConfigError rather than silently
  // forwarding an unsupported kind.
  if (runtime.type !== "filesystem" && runtime.type !== "git") {
    throw new ConfigError(
      `write-source: source "${runtime.name}" has unsupported kind "${runtime.type}" for writes. ` +
        "Writes are only defined for `filesystem` and `git` sources.",
      "INVALID_CONFIG_FILE",
      'Use `kind: "filesystem"` or `kind: "git"` for writable sources.',
    );
  }
  const kind: "filesystem" | "git" = runtime.type;

  // §10.2 lock-first (BEHAVIOR FIX): a managed git bundle's resolved content
  // root lives in the lock (`localRoot`), NOT the desired config. Resolve there
  // FIRST — via the SAME shared resolver the indexer READ path uses — so a write
  // lands in exactly the directory a read walks; git sync/commit then runs
  // against that same root. When no lock row records a localRoot (a git bundle
  // migrated from a `sources[]` url), fall back to the derived cache repoDir +
  // content/-subdir convention — the identical chain the read path applies.
  const lockRoot = kind === "git" ? lockContentRootFor(runtime.name, runtime.type) : undefined;
  const repoPath = lockRoot ?? pathFromConfiguredSource(runtime);
  if (!repoPath) {
    throw new ConfigError(
      `Source "${runtime.name}" has no resolvable on-disk path; writes are unsupported for this entry.`,
      "INVALID_CONFIG_FILE",
    );
  }

  const config: SourceConfigEntry = {
    type: runtime.type,
    name: runtime.name,
    path: repoPath,
    ...(runtime.writable !== undefined ? { writable: runtime.writable } : {}),
    ...(runtime.options ? { options: runtime.options } : {}),
  };

  return {
    selector: runtime.name,
    source: {
      kind,
      name: runtime.name,
      path: kind === "git" ? (lockRoot ?? resolveGitContentRoot(repoPath)) : repoPath,
      ...(kind === "git" ? { repoPath } : {}),
    },
    config,
  };
}

/** Resolve the asset root inside a git checkout while preserving root-layout repos. */
export function resolveGitContentRoot(repoPath: string): string {
  const contentPath = path.join(repoPath, "content");
  return fs.existsSync(contentPath) && fs.statSync(contentPath).isDirectory() ? contentPath : repoPath;
}

function pathFromConfiguredSource(runtime: ConfiguredSource): string | undefined {
  // ConfiguredSource.source is the parsed SourceSpec (filesystem|git|website|npm).
  // For writable kinds we only ever care about a local on-disk path: filesystem
  // sources expose it directly; git sources resolve through the cache mirror
  // (handled by the existing source provider). For v1 the helper trusts
  // callers to materialise the cache path beforehand and does not re-clone.
  const spec = runtime.source;
  if (spec.type === "filesystem") return spec.path;
  // For git sources we fall back to the cached repo directory the provider
  // already materialised. The lookup is intentionally lazy — we only import
  // it when needed to keep the helper's import graph small.
  if (spec.type === "git") {
    try {
      const repo = parseGitRepoUrl(spec.url);
      return getCachePaths(repo.canonicalUrl).repoDir;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
