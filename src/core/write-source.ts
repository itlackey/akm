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
 * commits only operation-owned exact paths as one complete commit instead of
 * one noisy, incomplete commit per asset.
 *
 * This module is still the **single dispatch point** for write/delete: callers
 * (remember, import, source-add, etc.) MUST go through `writeAssetToSource` /
 * `deleteAssetFromSource` rather than re-inlining a filesystem write, and they
 * fire {@link commitWriteTargetBoundary} once after a batch of mutations to a
 * writable git target.
 */

import fs from "node:fs";
import path from "node:path";
import { withAssetMutationLeaseSync } from "../indexer/index-writer-lock";
import { lockContentRootFor } from "../integrations/lockfile";
import {
  GitStashPushError,
  getCachePaths,
  inspectGitUpstream,
  isGitBackedStash,
  parseGitRepoUrl,
  runGit,
  saveGitStash,
} from "../sources/providers/git";
import {
  assertGitExactPathsClean,
  assertNoIgnoredExactPaths,
  type GitExactPathSnapshots,
  type GitExactPathState,
  listIgnoredExactPaths,
  reconcileGitExactPathIndex,
} from "../sources/providers/git-stash";
import { detectAdapterId } from "./adapter/detect-adapter";
import { ensureAkmMarkdownType } from "./asset/akm-markdown";
import { assetPathForName, stashDirFor } from "./asset/asset-placement";
import type { AssetRef } from "./asset/resolve-ref";
import { conceptIdFromTypeName, displayRef } from "./asset/resolve-ref";
import { deriveBundleId } from "./bundle-id";
import { existingFileMode, isWithin, resolveStashDir, writeFileAtomic } from "./common";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry } from "./config/config";
import { bundleKeyForContentRoot, resolveActiveConfiguredSources, resolveConfiguredSources } from "./config/config";
import { ConfigError, UsageError } from "./errors";
import { sanitizeCommitMessage } from "./git-message";
import { warn, warnOnce } from "./warn";
import { recordWrittenPath } from "./write-provenance";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal source shape required by {@link writeAssetToSource}.
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
  /** Bundle adapter that owns placement and authoring semantics. */
  readonly adapterId?: string;
}

/**
 * Source kinds that the loader is allowed to mark `writable: true`. Anything
 * else is rejected at config load (per locked decision 4) — see
 * {@link assertWritableAllowedForKind}.
 */
const REJECTED_WRITABLE_KINDS: ReadonlySet<string> = new Set(["website", "npm"]);

interface PendingGitMutation {
  baseHead: string | null;
  snapshots: GitExactPathSnapshots;
}

const pendingGitMutations = new Map<string, PendingGitMutation>();
const EMPTY_GIT_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_PUSH_TIMEOUT_MS = 120_000;

function gitTargetKey(source: WriteTargetSource): string {
  return `${path.resolve(source.repoPath ?? source.path)}\0${path.resolve(source.path)}`;
}

/** Record the exact post-mutation blob for the target's boundary commit. */
export function recordWriteTargetPath(source: WriteTargetSource, filePath: string): void {
  if (source.kind !== "git") return;
  const repoDir = path.resolve(source.repoPath ?? source.path);
  if (!isGitBackedStash(repoDir)) return;
  const key = gitTargetKey(source);
  const pending = pendingGitMutations.get(key) ?? {
    baseHead: readOptionalGitHead(repoDir),
    snapshots: {},
  };
  const snapshot = captureGitPathSnapshot({ source, config: { type: "git" } }, filePath);
  pending.snapshots[snapshot.path] = snapshot.state;
  pendingGitMutations.set(key, pending);
}

function repoRelativeGitPath(source: WriteTargetSource, filePath: string): string {
  const repoDir = path.resolve(source.repoPath ?? source.path);
  const absolutePath = path.resolve(filePath);
  const [relativePath] = normalizePublicationPaths([path.relative(repoDir, absolutePath).replaceAll(path.sep, "/")]);
  return relativePath as string;
}

/** Reject dirty or ignored exact paths before a direct transaction mutation. */
export function assertWriteTargetPathsClean(source: WriteTargetSource, filePaths: string[]): void {
  if (source.kind !== "git") return;
  const repoDir = path.resolve(source.repoPath ?? source.path);
  if (!isGitBackedStash(repoDir)) return;
  const key = gitTargetKey(source);
  const pending = pendingGitMutations.get(key);
  for (const filePath of filePaths) {
    const relativePath = repoRelativeGitPath(source, filePath);
    if (pending && Object.hasOwn(pending.snapshots, relativePath)) {
      preflightGitPathMutation(source, filePath);
    } else {
      assertGitExactPathsClean(repoDir, [relativePath]);
    }
  }
}

export interface WriteTargetPublicationPlan {
  readonly target: ResolvedWriteTarget;
  readonly paths: readonly string[];
  readonly publish: boolean;
  readonly expectedBaseHead?: string | null;
}

export interface WriteTargetMutationOptions {
  ignored: "reject" | "local-only";
  purpose: string;
  message: string;
}

/** Preflight one operation's complete exact-path set before its first mutation. */
export function planWriteTargetPublication(
  target: ResolvedWriteTarget,
  filePaths: string[],
  options: { ignored: "reject" | "local-only" },
): WriteTargetPublicationPlan {
  const paths = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))];
  assertNoWritePathDescendantSymlinks(target.source, paths);
  if (target.source.kind !== "git") return { target, paths, publish: false };
  const repoDir = path.resolve(target.source.repoPath ?? target.source.path);
  if (!isGitBackedStash(repoDir)) return { target, paths, publish: false };
  const expectedBaseHead = readOptionalGitHead(repoDir);
  const relativePaths = paths.map((filePath) => repoRelativeGitPath(target.source, filePath));
  const ignored = new Set(listIgnoredExactPaths(repoDir, relativePaths));
  if (ignored.size > 0) {
    if (options.ignored === "reject") {
      throw new UsageError(
        `Exact Git publication path is ignored: ${[...ignored][0]}. Update .gitignore or choose a tracked destination before writing.`,
      );
    }
  }
  const unignoredPaths = paths.filter((_, index) => !ignored.has(relativePaths[index] as string));
  assertWriteTargetPathsClean(target.source, unignoredPaths);
  // Not re-verified against `expectedBaseHead` here: any drift during the
  // ignored/clean-path checks above is caught by the SAME expectedBaseHead
  // comparison `beginWriteTargetMutation` runs immediately before the first
  // mutation (its documented contract, and every real caller calls it right
  // after this function returns) -- checking it again here a few lines
  // earlier for the exact same value only duplicated that check, not added
  // a new one. `publishWriteTargetPlan` independently re-checks a third time
  // after the actual mutation, which is a genuinely different point in time
  // and stays.
  return { target, paths, publish: ignored.size === 0, expectedBaseHead };
}

function assertNoWritePathDescendantSymlinks(source: WriteTargetSource, filePaths: readonly string[]): void {
  const lexicalRoot = path.resolve(source.path);
  const canonicalRoot = fs.realpathSync(lexicalRoot);
  for (const filePath of filePaths) {
    const relative = path.relative(lexicalRoot, filePath);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new UsageError(`Write path resolves outside source "${source.name}".`, "PATH_ESCAPE_VIOLATION");
    }
    let current = canonicalRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) {
          throw new UsageError(`Write path contains a symbolic link below source "${source.name}": ${relative}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

function assertWriteTargetPlanBase(target: ResolvedWriteTarget, expectedBaseHead: string | null): void {
  const repoDir = path.resolve(target.source.repoPath ?? target.source.path);
  if (readOptionalGitHead(repoDir) !== expectedBaseHead) {
    throw new UsageError(`Git target "${target.source.name}" advanced after exact-path preflight.`);
  }
}

/** Revalidate a publication plan immediately before its first mutation. */
export function beginWriteTargetMutation(plan: WriteTargetPublicationPlan): void {
  if (plan.expectedBaseHead === undefined) return;
  assertWriteTargetPlanBase(plan.target, plan.expectedBaseHead);
}

/** Publish exactly the paths bound by {@link planWriteTargetPublication}. */
export function publishWriteTargetPlan(
  plan: WriteTargetPublicationPlan,
  message: string,
  expectedSnapshots?: GitPathSnapshots,
): void {
  if (!plan.publish) return;
  if (plan.expectedBaseHead === undefined) {
    throw new UsageError(`Git publication plan for "${plan.target.source.name}" has no preflight base.`);
  }
  assertWriteTargetPlanBase(plan.target, plan.expectedBaseHead);
  for (const filePath of plan.paths) recordWriteTargetPath(plan.target.source, filePath);
  commitWriteTargetBoundary(plan.target, message, {
    paths: [...plan.paths],
    expectedBaseHead: plan.expectedBaseHead,
    ...(expectedSnapshots ? { expectedSnapshots } : {}),
  });
}

/** Hold the shared asset lease from exact-path preflight through publication. */
export function withWriteTargetMutation<T>(
  target: ResolvedWriteTarget,
  paths: string[],
  options: WriteTargetMutationOptions,
  mutate: () => T,
): T {
  return withAssetMutationLeaseSync(options.purpose, () => {
    const plan = planWriteTargetPublication(target, paths, { ignored: options.ignored });
    beginWriteTargetMutation(plan);
    const result = mutate();
    const expectedSnapshots = captureIntendedWriteTargetState(plan);
    publishWriteTargetPlan(plan, options.message, expectedSnapshots);
    return result;
  });
}

function captureIntendedWriteTargetState(plan: WriteTargetPublicationPlan): GitPathSnapshots | undefined {
  if (plan.expectedBaseHead === undefined) return undefined;
  const snapshots: GitPathSnapshots = {};
  for (const filePath of plan.paths) {
    const snapshot = captureGitPathSnapshot(plan.target, filePath);
    snapshots[snapshot.path] = snapshot.state;
  }
  return snapshots;
}

function readOptionalGitHead(repoDir: string): string | null {
  const result = runGit(["-C", repoDir, "rev-parse", "--verify", "HEAD"]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function preflightGitPathMutation(
  source: WriteTargetSource,
  filePath: string,
): { key: string; created: boolean } | undefined {
  if (source.kind !== "git") return undefined;
  const repoDir = path.resolve(source.repoPath ?? source.path);
  if (!isGitBackedStash(repoDir)) return undefined;
  const relativePath = repoRelativeGitPath(source, filePath);
  const key = gitTargetKey(source);
  let pending = pendingGitMutations.get(key);
  const created = pending === undefined;
  if (!pending) {
    pending = { baseHead: readOptionalGitHead(repoDir), snapshots: {} };
    pendingGitMutations.set(key, pending);
  }
  try {
    if (readOptionalGitHead(repoDir) !== pending.baseHead) {
      throw new UsageError(`Git target "${source.name}" advanced before its exact-path mutation.`);
    }

    if (!Object.hasOwn(pending.snapshots, relativePath)) {
      assertGitExactPathsClean(repoDir, [relativePath]);
      return { key, created };
    }

    assertNoIgnoredExactPaths(repoDir, [relativePath]);
    const index = runGit([
      "--literal-pathspecs",
      "-C",
      repoDir,
      "diff",
      "--cached",
      "--quiet",
      pending.baseHead ?? EMPTY_GIT_TREE,
      "--",
      relativePath,
    ]);
    if (index.status === 1) {
      throw new UsageError(
        `Exact Git operation path has staged work: ${relativePath}. Commit, stash, or discard that path before retrying.`,
      );
    }
    if (index.status !== 0) {
      throw new Error(`Cannot inspect Git index for exact operation path ${relativePath}: ${index.stderr.trim()}`);
    }
    const current = captureGitPathSnapshot({ source, config: { type: "git" } }, filePath);
    if (!sameGitPathState(current.state, pending.snapshots[relativePath] ?? null)) {
      throw new UsageError(
        `Exact Git operation path changed after AKM wrote it: ${relativePath}. Commit, stash, or discard that path before retrying.`,
      );
    }
    return { key, created };
  } catch (error) {
    if (created && Object.keys(pending.snapshots).length === 0) pendingGitMutations.delete(key);
    throw error;
  }
}

function discardEmptyGitPreflight(preflight: { key: string; created: boolean } | undefined): void {
  if (!preflight?.created) return;
  const pending = pendingGitMutations.get(preflight.key);
  if (pending && Object.keys(pending.snapshots).length === 0) pendingGitMutations.delete(preflight.key);
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
  assertAkmAssetWrite(source);

  const filePath = resolveAssetFilePath(source, ref);
  const authored = filePath.toLowerCase().endsWith(".md") ? ensureAkmMarkdownType(content, ref.type) : content;
  const normalized = authored.endsWith("\n") ? authored : `${authored}\n`;
  const preflight = preflightGitPathMutation(source, filePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Atomic: truncate-and-rewrite left a window in which a crash, a full disk,
    // or a concurrent reader saw a half-written or empty asset — destroying user
    // content that was fine a moment earlier. writeFileAtomic writes a sibling
    // temp file, fdatasyncs it, and renames over the target.
    writeFileAtomic(filePath, normalized, existingFileMode(filePath));
    recordWriteTargetPath(source, filePath);
    // #652: run-scoped write provenance — the canonical asset write is the
    // single largest contributor to an improve run's written-path set.
    recordWrittenPath(filePath);
  } catch (error) {
    discardEmptyGitPreflight(preflight);
    throw error;
  }

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
  assertAkmAssetWrite(source);

  const filePath = resolveAssetFilePath(source, ref);
  if (!fs.existsSync(filePath)) {
    throw new UsageError(
      `Asset "${formatRefForMessage(ref)}" not found in source "${source.name}" (expected at ${filePath}).`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  const preflight = preflightGitPathMutation(source, filePath);
  try {
    fs.unlinkSync(filePath);
    recordWriteTargetPath(source, filePath);
    // #652: a removal is journaled exactly like a write — the stager stages the
    // final on-disk state, so a deleted path lands as a staged deletion.
    recordWrittenPath(filePath);
  } catch (error) {
    discardEmptyGitPreflight(preflight);
    throw error;
  }

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
 */
export function commitWriteTargetBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: {
    push?: boolean;
    paths?: string[];
    transactionId?: string;
    expectedBaseHead?: string | null;
    expectedSnapshots?: GitPathSnapshots;
  },
): void {
  if (target.source.kind !== "git") return;

  const push = options?.push;

  const writable = resolveWritable(target.config);
  const repoDir = path.resolve(target.source.repoPath ?? target.source.path);
  const key = gitTargetKey(target.source);
  const pending = pendingGitMutations.get(key);
  const expectedBaseHead =
    options?.expectedBaseHead !== undefined
      ? options.expectedBaseHead
      : pending
        ? pending.baseHead
        : readOptionalGitHead(repoDir);
  const normalizeBoundaryPath = (filePath: string): string => {
    const relativePath = path.isAbsolute(filePath)
      ? path.relative(repoDir, path.resolve(filePath)).replaceAll(path.sep, "/")
      : filePath.replaceAll(path.sep, "/");
    return normalizePublicationPaths([relativePath])[0] as string;
  };
  const providedSnapshots = new Map(
    Object.entries(options?.expectedSnapshots ?? {}).map(([filePath, state]) => [
      normalizeBoundaryPath(filePath),
      state,
    ]),
  );
  const paths = normalizePublicationPaths([
    ...(options?.paths ?? []).map(normalizeBoundaryPath),
    ...Object.keys(pending?.snapshots ?? {}),
  ]);
  const expectedSnapshots: GitPathSnapshots = {};
  for (const filePath of paths) {
    if (providedSnapshots.has(filePath)) {
      expectedSnapshots[filePath] = providedSnapshots.get(filePath) ?? null;
    } else if (pending && Object.hasOwn(pending.snapshots, filePath)) {
      expectedSnapshots[filePath] = pending.snapshots[filePath] ?? null;
    } else {
      expectedSnapshots[filePath] = captureGitPathSnapshot(target, path.join(repoDir, filePath)).state;
    }
  }
  if (
    options?.expectedBaseHead !== undefined &&
    pending !== undefined &&
    options.expectedBaseHead !== pending.baseHead
  ) {
    throw new Error(`Git boundary base does not match the recorded exact-path mutation base.`);
  }
  // Assets may live under <repo>/content, but git synchronization always runs
  // against the repository root.
  try {
    saveGitStash(undefined, message, writable, {
      repoDir,
      paths,
      expectedSnapshots,
      expectedBaseHead,
      ...(push === undefined ? {} : { push }),
      ...(options?.transactionId === undefined ? {} : { transactionId: options.transactionId }),
    });
    pendingGitMutations.delete(key);
  } catch (error) {
    const currentHead = readOptionalGitHead(repoDir);
    if (pending && currentHead !== pending.baseHead) pendingGitMutations.delete(key);
    if (error instanceof GitStashPushError) {
      throw new Error(`Changes were committed as ${error.commit}, but publication failed: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** Durable identity needed to commit and publish one transaction safely. */
export interface GitPublication {
  repoPath: string;
  baseHead: string;
  branch?: string;
  remote?: string;
  mergeRef?: string;
  remoteUrl?: string;
  pushUrls?: string[];
  upstream?: string;
  upstreamHead?: string;
  commit?: string | null;
}

interface GitPublicationIdentity {
  repoPath: string;
  branch?: string;
  remote?: string;
  mergeRef?: string;
  remoteUrl?: string;
  pushUrls?: string[];
  upstream?: string;
}

export type GitPathState = GitExactPathState;
export type GitPathSnapshots = GitExactPathSnapshots;

function sameGitPathState(left: GitPathState | null, right: GitPathState | null): boolean {
  return left === null ? right === null : right !== null && left.oid === right.oid && left.mode === right.mode;
}

/** Capture the exact checkout/upstream identity before a durable mutation starts. */
export function captureGitPublication(target: ResolvedWriteTarget): GitPublication | undefined {
  if (target.source.kind !== "git") return undefined;
  const identity = readGitPublicationIdentity(target);
  const head = runGit(["-C", identity.repoPath, "rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) {
    throw new Error(`Cannot read Git HEAD for target "${target.source.name}".`);
  }
  const baseHead = head.stdout.trim();
  let upstreamHead: string | undefined;
  if (identity.upstream) {
    const upstream = runGit(["-C", identity.repoPath, "rev-parse", identity.upstream]);
    if (upstream.status !== 0 || !upstream.stdout.trim()) {
      throw new Error(`Cannot read Git upstream for target "${target.source.name}".`);
    }
    upstreamHead = upstream.stdout.trim();
    if (baseHead !== upstreamHead) {
      throw new Error(`Writable Git target "${target.source.name}" changed after mutation preflight.`);
    }
  }
  return { ...identity, baseHead, ...(upstreamHead ? { upstreamHead } : {}) };
}

/** Capture one repo-relative path exactly as Git will stage it. */
export function captureGitPathSnapshot(
  target: ResolvedWriteTarget,
  filePath: string,
): { path: string; state: GitPathState | null } {
  if (target.source.kind !== "git") throw new Error(`Target "${target.source.name}" is not Git-backed.`);
  const repoPath = path.resolve(target.source.repoPath ?? target.source.path);
  const absolutePath = path.resolve(filePath);
  const relativePath = path.relative(repoPath, absolutePath).replaceAll(path.sep, "/");
  const [normalizedPath] = normalizePublicationPaths([relativePath]);
  return {
    path: normalizedPath as string,
    state: captureGitPathState(repoPath, absolutePath, normalizedPath as string),
  };
}

function captureGitPathState(repoPath: string, absolutePath: string, relativePath: string): GitPathState | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let mode: GitPathState["mode"];
  let oidResult: ReturnType<typeof runGit>;
  if (stat.isSymbolicLink()) {
    mode = "120000";
    oidResult = runGit(["-C", repoPath, "hash-object", "--stdin"], { input: fs.readlinkSync(absolutePath) });
  } else if (stat.isFile()) {
    mode = stat.mode & 0o111 ? "100755" : "100644";
    oidResult = runGit(["-C", repoPath, "hash-object", `--path=${relativePath}`, "--", absolutePath]);
  } else {
    throw new Error(`Git publication path is not a file: ${relativePath}`);
  }
  if (oidResult.status !== 0 || !oidResult.stdout.trim()) {
    throw new Error(`Cannot snapshot Git publication path: ${relativePath}`);
  }
  return { oid: oidResult.stdout.trim(), mode };
}

/** Create or recover the one transaction-owned commit without pushing it. */
export function ensureGitTransactionCommit(
  target: ResolvedWriteTarget,
  publication: GitPublication,
  options: { transactionId: string; message: string; paths: string[]; snapshots: GitPathSnapshots },
): string | null {
  const paths = normalizePublicationPaths(options.paths);
  validateGitWorktreeSnapshots(target, paths, options.snapshots);
  if (publication.commit !== undefined) {
    if (publication.commit !== null) {
      validateGitTransactionCommit(
        target,
        publication,
        publication.commit,
        options.transactionId,
        paths,
        options.snapshots,
      );
      reconcileGitExactPathIndex(publication.repoPath, publication.baseHead, publication.commit, paths);
    }
    return publication.commit;
  }

  const existing = findGitTransactionCommit(publication.repoPath, publication.baseHead, options.transactionId);
  if (existing) {
    validateGitTransactionCommit(target, publication, existing, options.transactionId, paths, options.snapshots);
    reconcileGitExactPathIndex(publication.repoPath, publication.baseHead, existing, paths);
    return existing;
  }

  const head = readGitHead(publication.repoPath, target.source.name);
  if (head !== publication.baseHead) {
    throw new Error(
      `Cannot publish Git transaction ${options.transactionId}: target "${target.source.name}" advanced before its commit was recorded.`,
    );
  }
  commitWriteTargetBoundary(target, options.message, {
    paths,
    push: false,
    transactionId: options.transactionId,
    expectedBaseHead: publication.baseHead,
    expectedSnapshots: options.snapshots,
  });
  const committed = findGitTransactionCommit(publication.repoPath, publication.baseHead, options.transactionId);
  if (!committed) {
    if (readGitHead(publication.repoPath, target.source.name) === publication.baseHead) {
      validateGitCommitSnapshots(publication.repoPath, publication.baseHead, paths, options.snapshots);
      return null;
    }
    throw new Error(`Cannot identify the Git commit for transaction ${options.transactionId}.`);
  }
  validateGitTransactionCommit(target, publication, committed, options.transactionId, paths, options.snapshots);
  reconcileGitExactPathIndex(publication.repoPath, publication.baseHead, committed, paths);
  return committed;
}

/**
 * Kind-neutral snapshot capture for one mutated path.
 *
 * Returns `undefined` for kinds with no publication model, so command layers
 * never branch on `source.kind` themselves — the same fail-soft contract
 * {@link captureGitPublication} and {@link commitWriteTargetBoundary} already
 * use. `captureGitPathSnapshot` throws for non-git targets, which is what
 * forced callers to guard; this absorbs that guard.
 */
export function captureWriteTargetPathSnapshot(
  target: ResolvedWriteTarget,
  filePath: string,
): { path: string; state: GitPathState | null } | undefined {
  if (target.source.kind !== "git") return undefined;
  return captureGitPathSnapshot(target, filePath);
}

/**
 * Kind-neutral commit + publish for one transaction boundary.
 *
 * A no-op (returns `undefined`) for kinds with no publication model. For a
 * publication-backed target this absorbs BOTH the kind test and the
 * "transaction lacks durable publication identity" invariant, so callers hold
 * no provider knowledge. `onCommitRecorded` fires between the ensure and the
 * push, letting a caller persist the commit and advance its own journal phase
 * without inspecting the target.
 *
 * `missingPublicationError` lets a caller keep its own error CLASS for the
 * missing-identity case. The two call sites disagreed historically —
 * consolidate threw `ConfigError` (exit 78), proposal a plain `Error`
 * (exit 70) — and collapsing them here would silently change one command's
 * exit code. The guard moves; the classification stays with the caller.
 */
export function publishWriteTargetTransaction(
  target: ResolvedWriteTarget,
  publication: GitPublication | undefined,
  options: {
    transactionId: string;
    message: string;
    paths: string[];
    snapshots: GitPathSnapshots;
    onCommitRecorded?: (commit: string | null) => void;
    missingPublicationError?: (targetName: string) => Error;
  },
): { commit: string | null } | undefined {
  if (target.source.kind !== "git") return undefined;
  if (!publication) {
    throw (
      options.missingPublicationError?.(target.source.name) ??
      new Error(`Proposal transaction ${options.transactionId} has no Git publication identity.`)
    );
  }
  const commit = ensureGitTransactionCommit(target, publication, {
    transactionId: options.transactionId,
    message: options.message,
    paths: options.paths,
    snapshots: options.snapshots,
  });
  options.onCommitRecorded?.(commit);
  publishGitTransactionCommit(target, publication, options.transactionId, options.paths, options.snapshots);
  return { commit };
}

/** Push only the recorded transaction commit, never later local descendants. */
export function publishGitTransactionCommit(
  target: ResolvedWriteTarget,
  publication: GitPublication,
  transactionId: string,
  paths: string[],
  snapshots: GitPathSnapshots,
): void {
  if (publication.commit === undefined) {
    throw new Error(`Git transaction ${transactionId} has no recorded publication decision.`);
  }
  if (publication.commit === null) return;
  validateGitTransactionCommit(
    target,
    publication,
    publication.commit,
    transactionId,
    normalizePublicationPaths(paths),
    snapshots,
  );
  if (!publication.remote || !publication.mergeRef) return;

  if (!publication.upstream) throw new Error(`Git transaction ${transactionId} has no recorded upstream.`);
  if (
    runGit(["-C", publication.repoPath, "merge-base", "--is-ancestor", publication.commit, publication.upstream])
      .status === 0
  ) {
    return;
  }
  if (
    runGit(["-C", publication.repoPath, "merge-base", "--is-ancestor", publication.upstream, publication.commit])
      .status !== 0
  ) {
    throw new Error(`Cannot publish Git transaction ${transactionId}: upstream history diverged.`);
  }
  if (!publication.upstreamHead) {
    throw new Error(`Git transaction ${transactionId} has no recorded upstream lease.`);
  }
  const pushed = runGit(
    [
      "-C",
      publication.repoPath,
      "push",
      `--force-with-lease=${publication.mergeRef}:${publication.upstreamHead}`,
      publication.remote,
      `${publication.commit}:${publication.mergeRef}`,
    ],
    { timeout: GIT_PUSH_TIMEOUT_MS },
  );
  if (pushed.status !== 0) {
    throw new Error(`git push failed for target "${target.source.name}": ${pushed.stderr.trim()}`);
  }
}

function readGitPublicationIdentity(target: ResolvedWriteTarget): GitPublicationIdentity {
  const repoPath = path.resolve(target.source.repoPath ?? target.source.path);
  const branchResult = runGit(["-C", repoPath, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() : undefined;
  const remotes = runGit(["-C", repoPath, "remote"]);
  if (remotes.status !== 0) throw new Error(`Cannot inspect Git remotes for target "${target.source.name}".`);
  if (!remotes.stdout.trim()) return { repoPath, ...(branch ? { branch } : {}) };
  if (!branch) throw new Error(`Writable Git target "${target.source.name}" is detached from a branch.`);

  const remoteResult = runGit(["-C", repoPath, "config", "--get", `branch.${branch}.remote`]);
  const mergeResult = runGit(["-C", repoPath, "config", "--get", `branch.${branch}.merge`]);
  if (remoteResult.status !== 0 || mergeResult.status !== 0) {
    throw new Error(`Writable Git target "${target.source.name}" has no configured upstream branch.`);
  }
  const remote = remoteResult.stdout.trim();
  const mergeRef = mergeResult.stdout.trim();
  const upstreamResult = runGit(["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstreamResult.status !== 0 || !upstreamResult.stdout.trim()) {
    throw new Error(`Cannot read Git upstream for target "${target.source.name}".`);
  }
  const urlResult = runGit(["-C", repoPath, "remote", "get-url", remote]);
  if (urlResult.status !== 0 || !urlResult.stdout.trim()) {
    throw new Error(`Cannot read Git remote "${remote}" for target "${target.source.name}".`);
  }
  const pushUrlsResult = runGit(["-C", repoPath, "remote", "get-url", "--push", "--all", remote]);
  if (pushUrlsResult.status !== 0 || !pushUrlsResult.stdout.trim()) {
    throw new Error(`Cannot read Git push URL for target "${target.source.name}".`);
  }
  return {
    repoPath,
    branch,
    remote,
    mergeRef,
    remoteUrl: urlResult.stdout.trim(),
    pushUrls: pushUrlsResult.stdout
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean),
    upstream: upstreamResult.stdout.trim(),
  };
}

function normalizePublicationPaths(paths: string[]): string[] {
  const normalized = new Set<string>();
  for (const filePath of paths) {
    const candidate = filePath.replaceAll(path.sep, "/");
    if (
      !candidate ||
      candidate.includes("\0") ||
      path.isAbsolute(filePath) ||
      path.posix.isAbsolute(candidate) ||
      candidate === "." ||
      candidate === ".." ||
      candidate.startsWith("../") ||
      path.posix.normalize(candidate) !== candidate
    ) {
      throw new Error("Git publication contains an unsafe path.");
    }
    normalized.add(candidate);
  }
  return [...normalized];
}

function readGitHead(repoPath: string, targetName: string): string {
  const result = runGit(["-C", repoPath, "rev-parse", "HEAD"]);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(`Cannot read Git HEAD for target "${targetName}".`);
  return result.stdout.trim();
}

function findGitTransactionCommit(repoPath: string, baseHead: string, transactionId: string): string | undefined {
  const result = runGit([
    "-C",
    repoPath,
    "log",
    "--format=%H",
    "--fixed-strings",
    `--grep=AKM-Transaction: ${transactionId}`,
    `${baseHead}..HEAD`,
  ]);
  if (result.status !== 0) throw new Error(`Cannot inspect Git transaction ${transactionId}.`);
  const matches = result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (matches.length > 1) throw new Error(`Git transaction ${transactionId} has multiple candidate commits.`);
  return matches[0];
}

function validateGitTransactionCommit(
  target: ResolvedWriteTarget,
  publication: GitPublication,
  commit: string,
  transactionId: string,
  expectedPaths: string[],
  snapshots: GitPathSnapshots,
): void {
  const parent = runGit(["-C", publication.repoPath, "rev-list", "--parents", "-n", "1", commit]);
  const ancestry = parent.stdout.trim().split(/\s+/);
  if (parent.status !== 0 || ancestry.length !== 2 || ancestry[1] !== publication.baseHead) {
    throw new Error(`Git commit ${commit} is not the direct transaction commit for "${target.source.name}".`);
  }
  const message = runGit(["-C", publication.repoPath, "show", "-s", "--format=%B", commit]);
  if (
    message.status !== 0 ||
    !message.stdout.split(/\r?\n/).some((line) => line.trim() === `AKM-Transaction: ${transactionId}`)
  ) {
    throw new Error(`Git commit ${commit} is not owned by transaction ${transactionId}.`);
  }
  const changed = runGit([
    "-C",
    publication.repoPath,
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-z",
    "--no-renames",
    "-r",
    commit,
  ]);
  const expected = new Set(expectedPaths);
  const changedPaths = changed.stdout.split("\0").filter(Boolean);
  if (changed.status !== 0 || changedPaths.length === 0 || changedPaths.some((filePath) => !expected.has(filePath))) {
    throw new Error(`Git commit ${commit} contains paths outside transaction ${transactionId}.`);
  }
  validateGitCommitSnapshots(publication.repoPath, commit, expectedPaths, snapshots);
  if (runGit(["-C", publication.repoPath, "merge-base", "--is-ancestor", commit, "HEAD"]).status !== 0) {
    throw new Error(`Git commit ${commit} is no longer on the target branch.`);
  }
}

function validateGitWorktreeSnapshots(
  target: ResolvedWriteTarget,
  expectedPaths: string[],
  snapshots: GitPathSnapshots,
): void {
  for (const expectedPath of expectedPaths) {
    if (!Object.hasOwn(snapshots, expectedPath)) {
      throw new Error(`Git publication lacks a snapshot for ${expectedPath}.`);
    }
    const current = captureGitPathSnapshot(
      target,
      path.join(target.source.repoPath ?? target.source.path, expectedPath),
    );
    if (!sameGitPathState(current.state, snapshots[expectedPath] ?? null)) {
      throw new Error(`Git publication path diverged after mutation: ${expectedPath}.`);
    }
  }
}

function validateGitCommitSnapshots(
  repoPath: string,
  commit: string,
  expectedPaths: string[],
  snapshots: GitPathSnapshots,
): void {
  for (const expectedPath of expectedPaths) {
    if (!Object.hasOwn(snapshots, expectedPath)) {
      throw new Error(`Git publication lacks a snapshot for ${expectedPath}.`);
    }
    const expected = snapshots[expectedPath];
    const tree = runGit(["-C", repoPath, "ls-tree", commit, "--", expectedPath]);
    if (tree.status !== 0) throw new Error(`Cannot inspect committed Git path: ${expectedPath}.`);
    const match = tree.stdout.trim().match(/^(\d+)\s+blob\s+([0-9a-f]+)\t/);
    if (expected === null) {
      if (tree.stdout.trim()) throw new Error(`Git transaction unexpectedly retained ${expectedPath}.`);
    } else if (expected === undefined || !match || match[1] !== expected.mode || match[2] !== expected.oid) {
      throw new Error(`Git transaction committed unexpected content for ${expectedPath}.`);
    }
  }
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

/**
 * Validate and normalize a write target before a command mutates it.
 *
 * Git bundle locks record the materialized content root, which can be a
 * subdirectory of the checkout. Resolve the actual repository boundary from
 * that root so scoped commits use repository-relative paths. Extracted or
 * unmaterialized Git caches are not writable checkouts and must fail before a
 * command writes files into them.
 */
export function prepareWriteTargetForMutation(
  target: ResolvedWriteTarget,
  options: { allowedAdapters?: readonly string[]; allowAhead?: boolean } = {},
): ResolvedWriteTarget {
  assertAkmAssetWrite(target.source, options.allowedAdapters);
  if (target.source.kind !== "git") return target;

  const contentRoot = path.resolve(target.source.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(contentRoot);
  } catch {
    throw gitTargetNotMaterialized(target, contentRoot);
  }
  if (!stat.isDirectory()) throw gitTargetNotMaterialized(target, contentRoot);

  const rootResult = runGit(["-C", contentRoot, "rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0 || !rootResult.stdout.trim()) {
    throw gitTargetNotMaterialized(target, contentRoot);
  }

  const repoPath = path.resolve(rootResult.stdout.trim());
  const gitDirResult = runGit(["-C", repoPath, "rev-parse", "--git-dir"]);
  if (gitDirResult.status !== 0 || !gitDirResult.stdout.trim()) {
    throw gitTargetNotMaterialized(target, contentRoot);
  }
  const gitDir = path.resolve(repoPath, gitDirResult.stdout.trim());
  let realContentRoot: string;
  let realRepoPath: string;
  try {
    realContentRoot = fs.realpathSync(contentRoot);
    realRepoPath = fs.realpathSync(repoPath);
    fs.accessSync(realContentRoot, fs.constants.W_OK);
    fs.accessSync(gitDir, fs.constants.W_OK);
  } catch {
    throw new ConfigError(
      `Writable Git target "${target.source.name}" is not writable at ${contentRoot}.`,
      "INVALID_CONFIG_FILE",
      `Fix the checkout permissions or choose a different --target.`,
    );
  }
  if (!isWithin(realContentRoot, realRepoPath)) {
    throw new ConfigError(
      `Writable Git target "${target.source.name}" resolves outside its checkout: ${contentRoot}.`,
      "INVALID_CONFIG_FILE",
    );
  }

  const statusResult = runGit(["-C", repoPath, "status", "--porcelain"]);
  if (statusResult.status !== 0 || statusResult.error) {
    throw gitTargetNotMaterialized(target, contentRoot);
  }
  const branchResult = runGit(["-C", repoPath, "symbolic-ref", "--quiet", "HEAD"]);
  if (branchResult.status !== 0 || !branchResult.stdout.trim()) {
    throw new UsageError(
      `Writable Git target "${target.source.name}" is detached from a branch.`,
      "INVALID_FLAG_VALUE",
    );
  }

  const upstream = inspectGitUpstream(repoPath);
  if (upstream.behind > 0) {
    warnOnce(
      `write-source:git-behind:${realRepoPath}`,
      `Writable Git target "${target.source.name}" is ${upstream.behind} commit(s) behind ${upstream.upstream}; writing anyway. Run \`akm bundle update ${target.source.name}\` to catch up.`,
    );
  }
  if (upstream.ahead > 0) {
    warnOnce(
      `write-source:git-ahead:${realRepoPath}`,
      `Writable Git target "${target.source.name}" has ${upstream.ahead} unpushed commit(s); writing another on top. Push or reconcile them when convenient.`,
    );
  }

  return {
    ...target,
    source: { ...target.source, path: contentRoot, repoPath },
  };
}

function gitTargetNotMaterialized(target: ResolvedWriteTarget, contentRoot: string): ConfigError {
  return new ConfigError(
    `Writable Git target "${target.source.name}" is not materialized as a Git checkout at ${contentRoot}; refusing to write without a commit boundary.`,
    "INVALID_CONFIG_FILE",
    `Run \`akm bundle update ${target.source.name}\` to materialize it, or point the bundle at a writable Git checkout.`,
  );
}

/**
 * Resolve the destination for a write per locked decision 3:
 *
 *   1. Explicit `--target <name>` (when supplied)
 *   2. `config.defaultWriteTarget`
 *   3. `config.defaultBundle`'s path (the working stash created by `akm bundle create`)
 *   4. `ConfigError("no writable source configured; run `akm bundle create`")`
 *
 * The legacy `first-writable-in-source-array-order` fallback is *not* used —
 * see plan §6 decision 3 for the rationale.
 */
export function resolveWriteTarget(
  akmConfig: AkmConfig,
  explicitTarget?: string,
  options: { requireWritable?: boolean } = {},
): ResolvedWriteTarget {
  const allConfiguredSources = resolveConfiguredSources(akmConfig);
  const configuredSources = resolveActiveConfiguredSources(akmConfig);
  const requireWritable = options.requireWritable !== false;

  // 1. Explicit --target wins.
  if (explicitTarget) {
    const match = configuredSources.find((s) => s.name === explicitTarget);
    if (!match) {
      if (allConfiguredSources.some((source) => source.name === explicitTarget)) {
        throw new UsageError(`Bundle "${explicitTarget}" is disabled.`, "INVALID_FLAG_VALUE");
      }
      throw new UsageError(
        `--target must reference a source name from your config. No source named "${explicitTarget}" is configured. Run \`akm bundle list\` to see available sources.`,
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
      "Update `defaultWriteTarget` in your config (run `akm config get defaultWriteTarget`) or run `akm bundle list` to see configured sources.",
    );
  }

  // 3. Configured default bundle.
  return resolveWorkingStashTarget(akmConfig, options);
}

/** Resolve the implicit working stash without consulting `defaultWriteTarget`. */
export function resolveWorkingStashTarget(
  akmConfig: AkmConfig,
  options: { requireWritable?: boolean } = {},
): ResolvedWriteTarget {
  const allConfiguredSources = resolveConfiguredSources(akmConfig);
  const configuredSources = resolveActiveConfiguredSources(akmConfig);
  const requireWritable = options.requireWritable !== false;
  if (process.env.AKM_BUNDLE_DIR?.trim()) {
    const stashDir = resolveStashDir();
    const configuredBundleId = bundleKeyForContentRoot(akmConfig, stashDir);
    const configured = configuredSources.find((source) => source.name === configuredBundleId);
    if (configured) {
      const target = adaptConfiguredSource(configured);
      if (requireWritable && !resolveWritable(target.config)) {
        throw new ConfigError(`Bundle "${configured.name}" is not writable.`, "INVALID_CONFIG_FILE");
      }
      return { ...target, selector: undefined };
    }
    if (allConfiguredSources.some((source) => source.name === configuredBundleId)) {
      throw new ConfigError("The AKM_BUNDLE_DIR source is disabled in config.", "INVALID_CONFIG_FILE");
    }
    const bundleId = deriveBundleId(undefined, stashDir, new Set(Object.keys(akmConfig.bundles ?? {})));
    return {
      source: { kind: "filesystem", name: bundleId, path: stashDir, adapterId: detectAdapterId(stashDir) },
      config: { type: "filesystem", name: bundleId, path: stashDir, writable: true },
    };
  }
  const defaultBundleSource = akmConfig.defaultBundle
    ? configuredSources.find((source) => source.name === akmConfig.defaultBundle)
    : undefined;
  if (!defaultBundleSource || !akmConfig.defaultBundle) {
    throw new ConfigError("No default bundle is configured.", "INVALID_CONFIG_FILE");
  }
  const target = adaptConfiguredSource(defaultBundleSource);
  if (requireWritable && !resolveWritable(target.config)) {
    throw new ConfigError(
      `defaultBundle "${akmConfig.defaultBundle}" is not writable`,
      "INVALID_CONFIG_FILE",
      `Set \`writable: true\` on the "${akmConfig.defaultBundle}" bundle, or set \`defaultWriteTarget\` to a writable source.`,
    );
  }
  return { ...target, selector: undefined };
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

/**
 * MS-DOS device names Windows still reserves in every directory, with or
 * without an extension (CON, PRN, AUX, NUL, COM1-9, LPT1-9).
 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function resolveAssetFilePath(source: WriteTargetSource, ref: AssetRef): string {
  const basename = path.posix.basename(ref.name.replaceAll("\\", "/")).replace(/\.md$/i, "").toLowerCase();
  if (basename === "index" || basename === "log") {
    warnOnce(
      `write-source:reserved-basename:${basename}`,
      `Concept name "${basename}" collides with a reserved word some tooling treats specially; writing it anyway.`,
    );
  }
  // Windows resolves these names as DEVICES no matter the directory or the
  // extension, so `CON.md` is not a file — a write goes to the console and a
  // read blocks on console input. Rejected on every platform so a stash stays
  // portable: an asset authored on Linux must not become unopenable when the
  // same bundle is used on Windows.
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(basename)) {
    warnOnce(
      `write-source:windows-device-name:${basename}`,
      `Asset name "${basename}" is a reserved Windows device name; writing it anyway, but this bundle will not be portable to Windows.`,
    );
  }
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

export function assertAkmAssetWrite(source: WriteTargetSource, allowedAdapters: readonly string[] = ["akm"]): void {
  if (!source.adapterId || allowedAdapters.includes(source.adapterId)) return;
  throw new UsageError(
    `Bundle "${source.name}" uses adapter "${source.adapterId}", which does not support AKM asset writes.`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * The write-capable source kinds. Writes (and therefore scheduler state,
 * which only ever binds to a writable source) are defined only for these
 * two kinds; anything else throws `ConfigError`.
 */
export function isWriteCapableSourceKind(kind: string): kind is "filesystem" | "git" {
  return kind === "filesystem" || kind === "git";
}

/**
 * Reject any kind reaching the write/delete helpers other than the two
 * supported writable kinds. The config loader is the first line of defence
 * (assertWritableAllowedForKind), but we throw here so external callers that
 * bypass the loader still get a clear error.
 */
function assertSupportedKind(source: WriteTargetSource): void {
  if (isWriteCapableSourceKind(source.kind)) return;
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
  // 0.9.0 (Q-02): the retired `type:name` colon grammar is gone — emit the
  // slash conceptId (`workflows/name`), qualified with `origin//` when the
  // ref carries one. Mirrors the `displayRef`/`conceptIdFromTypeName` rule
  // used elsewhere in this file (see `resolveAssetFilePath` callers above).
  const conceptId = conceptIdFromTypeName(type, name);
  return origin ? `${origin}//${conceptId}` : conceptId;
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
 */
function adaptConfiguredSource(runtime: ConfiguredSource): ResolvedWriteTarget {
  // Map the runtime kind to the write helper's `kind` discriminator. Only
  // filesystem and git produce writable sources at v1; any other kind
  // reaching this point is a config-loader bug (assertWritableAllowedForKind
  // should have rejected it). Throw a ConfigError rather than silently
  // forwarding an unsupported kind.
  if (!isWriteCapableSourceKind(runtime.type)) {
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
  // against that same root. Before the first lock row exists, fall back to the
  // derived cache repoDir + content/-subdir convention used by the read path.
  const lockRoot = kind === "git" ? lockContentRootFor(runtime.name, runtime.type) : undefined;
  const repoPath = lockRoot ?? pathFromConfiguredSource(runtime);
  if (!repoPath) {
    throw new ConfigError(
      `Source "${runtime.name}" has no resolvable on-disk path; writes are unsupported for this entry.`,
      "INVALID_CONFIG_FILE",
    );
  }

  const contentRoot = kind === "git" ? (lockRoot ?? resolveGitContentRoot(repoPath)) : repoPath;
  const componentRoot = path.resolve(contentRoot, runtime.componentRoot ?? ".");
  if (!isWithin(componentRoot, contentRoot)) {
    throw new ConfigError(
      `Component root "${runtime.componentRoot}" escapes bundle "${runtime.name}".`,
      "INVALID_CONFIG_FILE",
    );
  }
  const adapterId = runtime.adapterId ?? detectAdapterId(componentRoot);

  const config: SourceConfigEntry = {
    type: runtime.type,
    name: runtime.name,
    path: componentRoot,
    ...(runtime.writable !== undefined ? { writable: runtime.writable } : {}),
    ...(runtime.options ? { options: runtime.options } : {}),
  };

  return {
    selector: runtime.name,
    source: {
      kind,
      name: runtime.name,
      path: componentRoot,
      adapterId,
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
