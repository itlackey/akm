// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * write-source — resolve a write target and publish writes to it.
 *
 * The only module that branches on `source.kind` for writes. It does two
 * things:
 *
 *  1. Resolve the destination: `--bundle` → `defaultWriteTarget` → working
 *     stash (`defaultBundle`). `writable` defaults to true on `filesystem` and
 *     `location`, and false on `git`; `website` / `npm` are never writable (the
 *     config loader rejects `writable: true` on them).
 *  2. Publish: write the file atomically inside the bundle root, and for a
 *     git-backed target commit exactly the operation's paths once at the
 *     boundary ({@link commitWriteTargetBoundary} → `saveGitStash`), pushing
 *     with `--force-with-lease` when the target is writable and has an
 *     upstream.
 *
 * Nothing commits per asset (issue #507). Callers write assets through
 * `writeAssets` (`src/core/assets/write.ts`) and plain files through
 * {@link writeSourceFile}, then fire {@link commitWriteTargetBoundary} once — or
 * wrap a custom mutation in {@link withWriteTargetMutation}, which does both
 * under the asset lease. An
 * accepted proposal commits its own paths ({@link commitAcceptedPaths}), on a
 * filesystem stash that is a git repository too. A process that accepts many
 * proposals collects them and commits once at its boundary (#1185).
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
import { listIgnoredExactPaths } from "../sources/providers/git-stash";
import type { AssetRef } from "./asset/resolve-ref";
import { conceptIdFromTypeName } from "./asset/resolve-ref";
import { assertWritableFile } from "./assets/files";
import { assertAdapterWrites, detectBundleAdapter } from "./assets/gate";
import { materialiseBundleDir } from "./bundle-at-dir";
import { existingFileMode, isWithin, resolveStashDir, safeRealpath, writeFileAtomic } from "./common";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry } from "./config/config";
import { bundleAtDir, resolveActiveConfiguredSources, resolveConfiguredSources } from "./config/config";
import { ConfigError, UsageError } from "./errors";
import { sanitizeCommitMessage } from "./git-message";
import { getLocationBundleRoot } from "./paths";
import { warn, warnOnce } from "./warn";
import { recordWrittenPath } from "./write-provenance";

// ── Types ───────────────────────────────────────────────────────────────────

/** Minimal source shape the write helpers need. */
export interface WriteTargetSource {
  /** Discriminator for write dispatch (`"filesystem"` | `"git"` | `"location"`). */
  readonly kind: string;
  /** Human-readable identifier surfaced in error messages. */
  readonly name: string;
  /** Absolute filesystem path the indexer walks. The asset is written here. */
  readonly path: string;
  /** Git repository root used only for the boundary commit. */
  readonly repoPath?: string;
  /** Bundle adapter that owns placement and authoring semantics. */
  readonly adapterId?: string;
  /** A location bundle's `location`: where its adapter finds it. `path` is then the root its entries are indexed under. */
  readonly location?: string;
}

/** The chosen source plus the persisted config entry that drove the choice. */
export interface ResolvedWriteTarget {
  /** Configured source name used when an API must re-resolve the destination. */
  selector?: string;
  /** Stable source identity. Durable state uses `source.name`. */
  source: WriteTargetSource;
  config: SourceConfigEntry;
}

// ── Write-target resolution ─────────────────────────────────────────────────

/** `writable` defaults to true on `filesystem` and `location`, and false on every other kind. */
export function resolveWritable(entry: Pick<SourceConfigEntry, "type" | "writable">): boolean {
  if (typeof entry.writable === "boolean") return entry.writable;
  return entry.type === "filesystem" || entry.type === "location";
}

/**
 * Whether a resolved source is write-activated. Only the primary stash and
 * sources explicitly marked `writable: true` are writable; registry-cached
 * (installed, read-only) sources are never written in place because
 * `akm update` overwrites them.
 */
export function isSourceWriteActivated(source: { writable?: boolean }): boolean {
  return source.writable === true;
}

/** The two kinds writes are defined for; scheduler state binds only to these. */
export function isWriteCapableSourceKind(kind: string): kind is "filesystem" | "git" {
  return kind === "filesystem" || kind === "git";
}

/** How a caller wants a write target resolved. */
export interface WriteTargetOptions {
  requireWritable?: boolean;
  /**
   * The flag that named the explicit target, spelled in the errors below
   * (default `--bundle`). A target that came from a ref's bundle qualifier rather than a flag passes
   * how the user knows it, such as "The task ref's bundle".
   */
  flag?: string;
}

/**
 * Throw when `name` is a configured bundle that is disabled. Callers run it
 * after a name failed to resolve against the active set, so a disabled bundle
 * is reported as disabled rather than as not configured.
 */
export function assertBundleNotDisabled(akmConfig: AkmConfig, name: string): void {
  if (resolveConfiguredSources(akmConfig).some((source) => source.name === name)) {
    throw new UsageError(`Bundle "${name}" is disabled.`, "INVALID_FLAG_VALUE");
  }
}

/**
 * Resolve the destination for a write: explicit `--bundle`, then
 * `defaultWriteTarget`, then the working stash (`defaultBundle`). There is no
 * fallback to the first writable source.
 */
export function resolveWriteTarget(
  akmConfig: AkmConfig,
  explicitTarget?: string,
  options: WriteTargetOptions = {},
): ResolvedWriteTarget {
  const configuredSources = resolveActiveConfiguredSources(akmConfig);
  const requireWritable = options.requireWritable !== false;
  const flag = options.flag ?? "--bundle";

  if (explicitTarget) {
    const match = configuredSources.find((s) => s.name === explicitTarget);
    if (!match) {
      assertBundleNotDisabled(akmConfig, explicitTarget);
      throw new UsageError(
        `${flag} must reference a source name from your config. No source named "${explicitTarget}" is configured. Run \`akm bundle list\` to see available sources.`,
        "INVALID_FLAG_VALUE",
      );
    }
    if (requireWritable && !resolveWritable({ type: match.type, writable: match.writable })) {
      throw new ConfigError(
        `source ${explicitTarget} is not writable`,
        "INVALID_CONFIG_FILE",
        `Set \`writable: true\` on the "${explicitTarget}" source in your config, or pass ${flag} to a different source.`,
      );
    }
    return adaptConfiguredSource(match);
  }

  if (akmConfig.defaultWriteTarget) {
    const match = configuredSources.find((s) => s.name === akmConfig.defaultWriteTarget);
    if (!match) {
      throw new ConfigError(
        `defaultWriteTarget "${akmConfig.defaultWriteTarget}" does not match any configured source.`,
        "INVALID_CONFIG_FILE",
        "Update `defaultWriteTarget` in your config (run `akm config get defaultWriteTarget`) or run `akm bundle list` to see configured sources.",
      );
    }
    if (requireWritable && !resolveWritable({ type: match.type, writable: match.writable })) {
      throw new ConfigError(
        `defaultWriteTarget "${akmConfig.defaultWriteTarget}" is not writable`,
        "INVALID_CONFIG_FILE",
        `Set \`writable: true\` on the "${akmConfig.defaultWriteTarget}" source in your config, or change \`defaultWriteTarget\` to a writable source.`,
      );
    }
    return adaptConfiguredSource(match);
  }

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
    const configuredBundleId = bundleAtDir(akmConfig, stashDir);
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
    const adapterId = detectBundleAdapter(stashDir);
    // The directory is a bundle no config entry names: the facade takes it by the id it is materialised under.
    const bundleId = materialiseBundleDir(stashDir, akmConfig, { adapterId });
    return {
      source: { kind: "filesystem", name: bundleId, path: stashDir, adapterId },
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

/**
 * Map a runtime {@link ConfiguredSource} onto a write target. A managed git
 * bundle's content root comes from the lock (`localRoot`) first — the same
 * resolver the indexer's read path uses, so a write lands exactly where a read
 * walks. Before the first lock row it falls back to the cache checkout and its
 * `content/` convention.
 */
function adaptConfiguredSource(runtime: ConfiguredSource): ResolvedWriteTarget {
  if (runtime.source.type === "location") {
    // Its adapter reads and writes it; the adapter allowlists decide which writes it takes.
    const { location } = runtime.source;
    return {
      selector: runtime.name,
      source: {
        kind: "location",
        name: runtime.name,
        path: safeRealpath(getLocationBundleRoot(runtime.name)),
        ...(runtime.adapterId ? { adapterId: runtime.adapterId } : {}),
        location,
      },
      config: {
        type: "location",
        name: runtime.name,
        location,
        ...(runtime.writable !== undefined ? { writable: runtime.writable } : {}),
      },
    };
  }
  if (!isWriteCapableSourceKind(runtime.type)) {
    throw new ConfigError(
      `write-source: source "${runtime.name}" has unsupported kind "${runtime.type}" for writes. ` +
        "Writes are only defined for `filesystem` and `git` sources.",
      "INVALID_CONFIG_FILE",
      'Use `kind: "filesystem"` or `kind: "git"` for writable sources.',
    );
  }
  const kind: "filesystem" | "git" = runtime.type;
  const lockRoot = kind === "git" ? lockContentRootFor(runtime.name, runtime.type) : undefined;
  const repoPath = lockRoot ?? pathFromConfiguredSource(runtime);
  if (!repoPath) {
    throw new ConfigError(
      `Source "${runtime.name}" has no resolvable on-disk path; writes are unsupported for this entry.`,
      "INVALID_CONFIG_FILE",
    );
  }
  const contentRoot = kind === "git" ? (lockRoot ?? resolveGitContentRoot(repoPath)) : repoPath;
  const root = path.resolve(contentRoot, runtime.root ?? ".");
  if (!isWithin(root, contentRoot)) {
    throw new ConfigError(`Root "${runtime.root}" escapes bundle "${runtime.name}".`, "INVALID_CONFIG_FILE");
  }
  const adapterId = runtime.adapterId ?? detectBundleAdapter(root);
  const config: SourceConfigEntry = {
    type: runtime.type,
    name: runtime.name,
    path: root,
    ...(runtime.writable !== undefined ? { writable: runtime.writable } : {}),
    ...(runtime.options ? { options: runtime.options } : {}),
  };
  return {
    selector: runtime.name,
    source: { kind, name: runtime.name, path: root, adapterId, ...(kind === "git" ? { repoPath } : {}) },
    config,
  };
}

/** Resolve the asset root inside a git checkout while preserving root-layout repos. */
export function resolveGitContentRoot(repoPath: string): string {
  const contentPath = path.join(repoPath, "content");
  // asset-io: bundle-root git checkout layout
  return fs.existsSync(contentPath) && fs.statSync(contentPath).isDirectory() ? contentPath : repoPath;
}

function pathFromConfiguredSource(runtime: ConfiguredSource): string | undefined {
  const spec = runtime.source;
  if (spec.type === "filesystem") return spec.path;
  if (spec.type === "git") {
    try {
      return getCachePaths(parseGitRepoUrl(spec.url).canonicalUrl).repoDir;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ── Preparing a target for mutation ─────────────────────────────────────────

/** What a write is, for the checks a target passes: an asset of a type, or a plain file (any bundle that takes writes). */
export interface WriteKind {
  /** The type of the asset the write creates or changes. Absent: an asset of any type the adapter writes. */
  assetType?: string;
  /** A plain file, not an asset: the adapter is not asked. */
  plain?: boolean;
}

/**
 * The read-only checks a write target must pass: the adapter takes AKM asset writes, and a git target is a
 * materialized checkout on a branch. Its repository root is resolved from the content root (which may be a
 * subdirectory) so the boundary commit uses repository-relative paths. Nothing is changed and nothing is fetched.
 */
function checkWriteTarget(
  target: ResolvedWriteTarget,
  kind: WriteKind = {},
): { target: ResolvedWriteTarget; repoPath?: string } {
  if (!kind.plain) assertAdapterWrites(target.source.name, kind.assetType);
  if (target.source.kind !== "git") return { target };

  const contentRoot = path.resolve(target.source.path);
  const rootResult = runGit(["-C", contentRoot, "rev-parse", "--show-toplevel"]);
  if (rootResult.status !== 0 || !rootResult.stdout.trim()) {
    throw new ConfigError(
      `Writable Git target "${target.source.name}" is not materialized as a Git checkout at ${contentRoot}; refusing to write without a commit boundary.`,
      "INVALID_CONFIG_FILE",
      `Run \`akm bundle update ${target.source.name}\` to materialize it, or point the bundle at a writable Git checkout.`,
    );
  }
  const repoPath = path.resolve(rootResult.stdout.trim());
  const branchResult = runGit(["-C", repoPath, "symbolic-ref", "--quiet", "HEAD"]);
  if (branchResult.status !== 0 || !branchResult.stdout.trim()) {
    throw new UsageError(
      `Writable Git target "${target.source.name}" is detached from a branch.`,
      "INVALID_FLAG_VALUE",
    );
  }
  return { target, repoPath };
}

/**
 * Whether a write to `explicitTarget` (or, with none, to where a write goes by default) would be accepted, and the
 * sentence why not when it would not. It runs the checks the write path runs, so it never disagrees with a save.
 * `name` is the bundle the write resolves to, or null when none resolves.
 */
export function inspectWriteTarget(
  akmConfig: AkmConfig,
  explicitTarget?: string,
): { name: string | null; blocker: string | null } {
  try {
    const resolved = resolveWriteTarget(akmConfig, explicitTarget);
    checkWriteTarget(resolved);
    return { name: resolved.source.name, blocker: null };
  } catch (error) {
    let name: string | null = null;
    try {
      name = resolveWriteTarget(akmConfig, explicitTarget, { requireWritable: false }).source.name;
    } catch {
      // Nothing resolves: the blocker above says why.
    }
    return { name, blocker: error instanceof Error ? error.message : String(error) };
  }
}

/** Validate a write target before a command mutates it: the read-only checks, then an advisory upstream check. */
export function prepareWriteTargetForMutation(target: ResolvedWriteTarget, kind: WriteKind = {}): ResolvedWriteTarget {
  const { repoPath } = checkWriteTarget(target, kind);
  if (repoPath === undefined) return target;
  const contentRoot = path.resolve(target.source.path);
  try {
    const upstream = inspectGitUpstream(repoPath);
    if (upstream.behind > 0) {
      warnOnce(
        `write-source:git-behind:${repoPath}`,
        `Writable Git target "${target.source.name}" is ${upstream.behind} commit(s) behind ${upstream.upstream}; writing anyway. Run \`akm bundle update ${target.source.name}\` to catch up.`,
      );
    }
    if (upstream.ahead > 0) {
      warnOnce(
        `write-source:git-ahead:${repoPath}`,
        `Writable Git target "${target.source.name}" has ${upstream.ahead} unpushed commit(s); writing another on top. Push or reconcile them when convenient.`,
      );
    }
  } catch (error) {
    // The upstream check is advisory (it fetches). Being offline must not stop
    // a local write; the push reports its own failure at the boundary.
    warnOnce(
      `write-source:git-upstream:${repoPath}`,
      `Could not check upstream for Git target "${target.source.name}" (${error instanceof Error ? error.message : String(error)}); writing anyway.`,
    );
  }
  return { ...target, source: { ...target.source, path: contentRoot, repoPath } };
}

// ── Writing assets ──────────────────────────────────────────────────────────

/** The gates an asset write passes: {@link assertPlainWritable}, and an adapter that writes assets of `type`. */
export function assertWritableSource(source: WriteTargetSource, config: SourceConfigEntry, type?: string): void {
  assertPlainWritable(source, config);
  assertAdapterWrites(source.name, type);
}

/** The gates of a plain file write: the source takes writes and is a kind akm writes, whatever its adapter. */
export function assertPlainWritable(source: WriteTargetSource, config: SourceConfigEntry): void {
  ensureWritable(source, config);
  assertSupportedKind(source);
}

/**
 * Write a plain text file (a file of no asset type: the Desktop Files view's) into `source` at `filePath` (already resolved
 * inside it, after {@link assertPlainWritable}), atomically: sibling temp file, fdatasync, rename, so a crash or a full disk
 * never leaves a half-written file where a good one was. Written as given; the Markdown policy of an asset (normalized
 * document, trailing line break, home-path advisory) is the adapter's, in `serialize` (`akm-format.ts`).
 */
export function writeSourceFile(source: WriteTargetSource, filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // asset-io: files-view a plain file, not an asset
  writeFileAtomic(filePath, content, existingFileMode(filePath));
  recordWriteTargetPath(source, filePath);
  // Run-scoped write provenance (#652).
  recordWrittenPath(filePath);
}

/** Refuse a write to a source that is not write-activated. */
export function ensureWritable(source: WriteTargetSource, config: SourceConfigEntry): void {
  if (resolveWritable(config)) return;
  throw new UsageError(
    `Source "${source.name}" is not writable. Set \`writable: true\` on the source config entry to enable writes.`,
    "INVALID_FLAG_VALUE",
  );
}

function assertSupportedKind(source: WriteTargetSource): void {
  if (isWriteCapableSourceKind(source.kind)) return;
  throw new ConfigError(
    `write-source: unsupported kind "${source.kind}" for source "${source.name}". ` +
      "Writes are only defined for `filesystem` and `git` sources.",
    "INVALID_CONFIG_FILE",
    'Set `kind: "filesystem"` (or `kind: "git"`) on the source, or add a parallel filesystem entry.',
  );
}

/** `[origin//]conceptId` for a commit subject, each component sanitized against CR/LF/NUL smuggling. */
export function formatRefForMessage(ref: AssetRef): string {
  const origin = ref.origin ? sanitizeCommitMessage(ref.origin) : "";
  const conceptId = conceptIdFromTypeName(sanitizeCommitMessage(ref.type), sanitizeCommitMessage(ref.name));
  return origin ? `${origin}//${conceptId}` : conceptId;
}

// ── Boundary commit ─────────────────────────────────────────────────────────

/**
 * Absolute paths written to a git target since its last boundary commit, keyed
 * by repository root. This is what lets the boundary `git add` exactly the
 * operation's files and nothing else in the checkout.
 */
const pendingGitPaths = new Map<string, Set<string>>();

function repoDirFor(source: WriteTargetSource): string {
  return path.resolve(source.repoPath ?? source.path);
}

/** Record a path the git target's next boundary commit must include. */
export function recordWriteTargetPath(source: WriteTargetSource, filePath: string): void {
  if (source.kind !== "git") return;
  const repoDir = repoDirFor(source);
  const pending = pendingGitPaths.get(repoDir) ?? new Set<string>();
  pending.add(path.resolve(filePath));
  pendingGitPaths.set(repoDir, pending);
}

/**
 * Refuse a write path outside the source root, or one that passes through a
 * symbolic link below it (a linked directory would redirect the write out of
 * the bundle). The source root itself may be a symlink.
 */
export function assertWritePathsInsideSource(source: WriteTargetSource, filePaths: readonly string[]): void {
  for (const filePath of filePaths) assertWritableFile(source.path, source.name, filePath);
}

/**
 * Run `mutate` under the shared asset-mutation lease, then commit exactly
 * `paths` on a git target (a no-op on filesystem targets). Every path must
 * stay inside the source root.
 */
export function withWriteTargetMutation<T>(
  target: ResolvedWriteTarget,
  paths: string[],
  options: { purpose: string; message: string },
  mutate: () => T,
): T {
  return withAssetMutationLeaseSync(options.purpose, () => {
    assertWritePathsInsideSource(target.source, paths);
    const result = mutate();
    commitWriteTargetBoundary(target, options.message, { paths });
    return result;
  });
}

/**
 * What a commit at a write boundary came to: the commit it made, or that it made none and why (`not-git`: the target
 * is not a Git repository; `ignored`: every path is ignored by `.gitignore` and stays local; `nothing-to-commit`: no
 * path or no change to commit; `failed`: git refused, with the `error`).
 */
export type CommitOutcome =
  | { committed: true; sha: string }
  | { committed: false; reason: "not-git" | "ignored" | "nothing-to-commit" | "failed"; error?: string };

/**
 * Commit a git target's recorded paths plus `options.paths` (absolute or
 * repository-relative) as one commit, and push it with `--force-with-lease`
 * when the target is writable, has an upstream, and `push !== false`. A no-op
 * for filesystem targets unless `filesystem` is set. Ignored paths stay local:
 * they are dropped from the commit with a warning rather than failing a write
 * that already landed.
 */
export function commitWriteTargetBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: { push?: boolean; paths?: string[]; filesystem?: boolean; body?: string[] },
): void {
  commitBoundary(target, message, options);
}

/** {@link commitWriteTargetBoundary}, reporting what the commit came to. */
function commitBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: { push?: boolean; paths?: string[]; filesystem?: boolean; body?: string[] },
): CommitOutcome {
  if (target.source.kind !== "git" && !options?.filesystem) return { committed: false, reason: "not-git" };
  const repoDir = repoDirFor(target.source);
  const recorded = pendingGitPaths.get(repoDir) ?? new Set<string>();
  pendingGitPaths.delete(repoDir);
  if (!isGitBackedStash(repoDir)) return { committed: false, reason: "not-git" };

  const toRepoRelative = (filePath: string): string =>
    (path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath).replaceAll(path.sep, "/");
  const paths = [...new Set([...(options?.paths ?? []), ...recorded].map(toRepoRelative))];
  if (paths.length === 0) return { committed: false, reason: "nothing-to-commit" };

  const ignored = new Set(listIgnoredExactPaths(repoDir, paths));
  if (ignored.size > 0) {
    warn(
      `warning: ${ignored.size} path(s) in "${target.source.name}" are ignored by .gitignore and stay local (not committed): ${[...ignored].join(", ")}`,
    );
  }
  const committable = paths.filter((filePath) => !ignored.has(filePath));
  if (committable.length === 0) return { committed: false, reason: "ignored" };

  try {
    const saved = saveGitStash(undefined, message, resolveWritable(target.config), {
      repoDir,
      paths: committable,
      ...(options?.body ? { body: options.body } : {}),
      ...(options?.push === undefined ? {} : { push: options.push }),
    });
    if (saved.reason) warn(`warning: "${target.source.name}" ${saved.reason}`);
    return saved.commit ? { committed: true, sha: saved.commit } : { committed: false, reason: "nothing-to-commit" };
  } catch (error) {
    if (error instanceof GitStashPushError) {
      const what = error.committedNow
        ? `Changes were committed as ${error.commit}`
        : `Nothing new to commit; earlier commits up to ${error.commit} are unpushed`;
      throw new Error(`${what}, but publication failed: ${error.message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Commit exactly the paths an accepted proposal wrote or removed, when the
 * target is a git repository: a filesystem stash with a `.git` too, which the
 * boundary commit skips, locally (the end-of-run sync pushes). A failed commit
 * only warns, since the accept already landed. Returns what the commit came to.
 */
export function commitAcceptedPaths(
  target: ResolvedWriteTarget,
  message: string,
  paths: string[],
  body?: string[],
): CommitOutcome {
  try {
    return commitBoundary(target, message, {
      paths,
      ...(body ? { body } : {}),
      filesystem: true,
      ...(target.source.kind === "git" ? {} : { push: false }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warn(`warning: could not commit the accept (${message}): ${detail}`);
    return { committed: false, reason: "failed", error: detail };
  }
}
