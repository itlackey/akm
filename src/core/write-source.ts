// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * write-source — resolve a write target and publish writes to it.
 *
 * The only module that branches on `source.kind` for writes. It does two
 * things:
 *
 *  1. Resolve the destination: `--target` → `defaultWriteTarget` → working
 *     stash (`defaultBundle`). `writable` defaults to true on `filesystem` and
 *     false on `git`; `website` / `npm` are never writable (the config loader
 *     rejects `writable: true` on them).
 *  2. Publish: write the file atomically inside the bundle root, and for a
 *     git-backed target commit exactly the operation's paths once at the
 *     boundary ({@link commitWriteTargetBoundary} → `saveGitStash`), pushing
 *     with `--force-with-lease` when the target is writable and has an
 *     upstream.
 *
 * Nothing commits per asset (issue #507). Callers write and delete through
 * {@link writeAssetToSource} / {@link deleteAssetFromSource}, then fire
 * {@link commitWriteTargetBoundary} once — or wrap a custom mutation in
 * {@link withWriteTargetMutation}, which does both under the asset lease.
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
import { assertGitExactPathsClean, listIgnoredExactPaths } from "../sources/providers/git-stash";
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

/** Minimal source shape the write helpers need. */
export interface WriteTargetSource {
  /** Discriminator for write dispatch (`"filesystem"` | `"git"`). */
  readonly kind: string;
  /** Human-readable identifier surfaced in error messages. */
  readonly name: string;
  /** Absolute filesystem path the indexer walks. The asset is written here. */
  readonly path: string;
  /** Git repository root used only for the boundary commit. */
  readonly repoPath?: string;
  /** Bundle adapter that owns placement and authoring semantics. */
  readonly adapterId?: string;
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

/** `writable` defaults to true on `filesystem` and false on every other kind. */
export function resolveWritable(entry: Pick<SourceConfigEntry, "type" | "writable">): boolean {
  if (typeof entry.writable === "boolean") return entry.writable;
  return entry.type === "filesystem";
}

/** The two kinds writes are defined for; scheduler state binds only to these. */
export function isWriteCapableSourceKind(kind: string): kind is "filesystem" | "git" {
  return kind === "filesystem" || kind === "git";
}

/**
 * Resolve the destination for a write: explicit `--target`, then
 * `defaultWriteTarget`, then the working stash (`defaultBundle`). There is no
 * fallback to the first writable source.
 */
export function resolveWriteTarget(
  akmConfig: AkmConfig,
  explicitTarget?: string,
  options: { requireWritable?: boolean } = {},
): ResolvedWriteTarget {
  const allConfiguredSources = resolveConfiguredSources(akmConfig);
  const configuredSources = resolveActiveConfiguredSources(akmConfig);
  const requireWritable = options.requireWritable !== false;

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
    if (requireWritable && !resolveWritable({ type: match.type, writable: match.writable })) {
      throw new ConfigError(
        `source ${explicitTarget} is not writable`,
        "INVALID_CONFIG_FILE",
        `Set \`writable: true\` on the "${explicitTarget}" source in your config, or pass --target to a different source.`,
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

/**
 * Map a runtime {@link ConfiguredSource} onto a write target. A managed git
 * bundle's content root comes from the lock (`localRoot`) first — the same
 * resolver the indexer's read path uses, so a write lands exactly where a read
 * walks. Before the first lock row it falls back to the cache checkout and its
 * `content/` convention.
 */
function adaptConfiguredSource(runtime: ConfiguredSource): ResolvedWriteTarget {
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
    source: { kind, name: runtime.name, path: componentRoot, adapterId, ...(kind === "git" ? { repoPath } : {}) },
    config,
  };
}

/** Resolve the asset root inside a git checkout while preserving root-layout repos. */
export function resolveGitContentRoot(repoPath: string): string {
  const contentPath = path.join(repoPath, "content");
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

/** Refuse AKM asset writes into a bundle whose adapter owns a different layout. */
export function assertAkmAssetWrite(source: WriteTargetSource, allowedAdapters: readonly string[] = ["akm"]): void {
  if (!source.adapterId || allowedAdapters.includes(source.adapterId)) return;
  throw new UsageError(
    `Bundle "${source.name}" uses adapter "${source.adapterId}", which does not support AKM asset writes.`,
    "INVALID_FLAG_VALUE",
  );
}

/**
 * Validate a write target before a command mutates it. A git target must be a
 * materialized checkout on a branch; its repository root is resolved from the
 * content root (which may be a subdirectory) so the boundary commit uses
 * repository-relative paths. Being ahead of or behind upstream only warns.
 */
export function prepareWriteTargetForMutation(
  target: ResolvedWriteTarget,
  options: { allowedAdapters?: readonly string[] } = {},
): ResolvedWriteTarget {
  assertAkmAssetWrite(target.source, options.allowedAdapters);
  if (target.source.kind !== "git") return target;

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

/**
 * Write a textual asset into `source` at the path implied by `ref`: refuses a
 * non-writable config, rejects any kind but `filesystem` / `git`, then writes
 * atomically inside the bundle root. No commit runs here for any kind; a git
 * target records the path for {@link commitWriteTargetBoundary}.
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Atomic: sibling temp file, fdatasync, rename — a crash or a full disk never
  // leaves a half-written asset where a good one was.
  writeFileAtomic(filePath, normalized, existingFileMode(filePath));
  recordWriteTargetPath(source, filePath);
  // Run-scoped write provenance (#652).
  recordWrittenPath(filePath);

  // Non-fatal portability advisory, after the write so it never blocks it.
  const hostPaths = findAbsoluteHomePaths(normalized);
  if (hostPaths.length > 0) {
    warn(
      `warning: asset "${formatRefForMessage(ref)}" embeds absolute host path(s): ${hostPaths.join(", ")}. ` +
        "These make the stash non-portable and leak the local username — prefer $HOME or ~ relative references.",
    );
  }
  return { path: filePath, ref: displayRef({ type: ref.type, name: ref.name, bundleId: ref.origin }) };
}

/** Delete the asset at `ref` from `source`. Same gates as {@link writeAssetToSource}, no commit. */
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
  fs.unlinkSync(filePath);
  recordWriteTargetPath(source, filePath);
  recordWrittenPath(filePath);
  return { path: filePath, ref: displayRef({ type: ref.type, name: ref.name, bundleId: ref.origin }) };
}

function ensureWritable(source: WriteTargetSource, config: SourceConfigEntry): void {
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

/** MS-DOS device names Windows reserves in every directory, with or without an extension. */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** The on-disk path for `ref` inside `source`, refusing anything that escapes the type directory. */
function resolveAssetFilePath(source: WriteTargetSource, ref: AssetRef): string {
  const basename = path.posix.basename(ref.name.replaceAll("\\", "/")).replace(/\.md$/i, "").toLowerCase();
  if (basename === "index" || basename === "log") {
    warnOnce(
      `write-source:reserved-basename:${basename}`,
      `Concept name "${basename}" collides with a reserved word some tooling treats specially; writing it anyway.`,
    );
  }
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

/**
 * Matches an absolute host home path (`/home/<user>`, `/Users/<user>`) with at
 * least one user segment. Deliberately does not exempt fenced code, so content
 * that documents such a path can trip it; the advisory is non-fatal.
 */
const ABSOLUTE_HOME_PATH_RE = /\/(?:home|Users)\/[^\s/"'`)\]}<>|:;,]+/g;

/** Distinct `/home/<user>` / `/Users/<user>` prefixes in `content`, first-seen order. */
export function findAbsoluteHomePaths(content: string): string[] {
  const seen = new Set<string>();
  for (const match of content.matchAll(ABSOLUTE_HOME_PATH_RE)) seen.add(match[0]);
  return [...seen];
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

/** Refuse to overwrite exact paths that carry staged or unstaged user work. */
export function assertWriteTargetPathsClean(source: WriteTargetSource, filePaths: string[]): void {
  if (source.kind !== "git") return;
  const repoDir = repoDirFor(source);
  if (!isGitBackedStash(repoDir)) return;
  assertGitExactPathsClean(
    repoDir,
    filePaths.map((filePath) => path.relative(repoDir, path.resolve(filePath)).replaceAll(path.sep, "/")),
  );
}

function lstatOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Refuse a write path outside the source root, or one that passes through a
 * symbolic link below it (a linked directory would redirect the write out of
 * the bundle). The source root itself may be a symlink.
 */
function assertWritePathsInsideSource(source: WriteTargetSource, filePaths: readonly string[]): void {
  const lexicalRoot = path.resolve(source.path);
  const canonicalRoot = fs.realpathSync(lexicalRoot);
  for (const filePath of filePaths) {
    const relative = path.relative(lexicalRoot, path.resolve(filePath));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new UsageError(`Write path resolves outside source "${source.name}".`, "PATH_ESCAPE_VIOLATION");
    }
    let current = canonicalRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const stat = lstatOrNull(current);
      if (!stat) break;
      if (stat.isSymbolicLink()) {
        throw new UsageError(`Write path contains a symbolic link below source "${source.name}": ${relative}`);
      }
    }
  }
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
 * Commit a git target's recorded paths plus `options.paths` (absolute or
 * repository-relative) as one commit, and push it with `--force-with-lease`
 * when the target is writable, has an upstream, and `push !== false`. A no-op
 * for filesystem targets. Ignored paths stay local: they are dropped from the
 * commit with a warning rather than failing a write that already landed.
 */
export function commitWriteTargetBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: { push?: boolean; paths?: string[] },
): void {
  if (target.source.kind !== "git") return;
  const repoDir = repoDirFor(target.source);
  const recorded = pendingGitPaths.get(repoDir) ?? new Set<string>();
  pendingGitPaths.delete(repoDir);
  if (!isGitBackedStash(repoDir)) return;

  const toRepoRelative = (filePath: string): string =>
    (path.isAbsolute(filePath) ? path.relative(repoDir, filePath) : filePath).replaceAll(path.sep, "/");
  const paths = [...new Set([...(options?.paths ?? []), ...recorded].map(toRepoRelative))];
  if (paths.length === 0) return;

  const ignored = new Set(listIgnoredExactPaths(repoDir, paths));
  if (ignored.size > 0) {
    warn(
      `warning: ${ignored.size} path(s) in "${target.source.name}" are ignored by .gitignore and stay local (not committed): ${[...ignored].join(", ")}`,
    );
  }
  const committable = paths.filter((filePath) => !ignored.has(filePath));
  if (committable.length === 0) return;

  try {
    saveGitStash(undefined, message, resolveWritable(target.config), {
      repoDir,
      paths: committable,
      ...(options?.push === undefined ? {} : { push: options.push }),
    });
  } catch (error) {
    if (error instanceof GitStashPushError) {
      throw new Error(`Changes were committed as ${error.commit}, but publication failed: ${error.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}
