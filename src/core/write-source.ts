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
 * stages `.akm/` + sibling assets together as one complete commit instead of
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
import { getCachePaths, parseGitRepoUrl, saveGitStash } from "../sources/providers/git";
import type { AssetRef } from "./asset/asset-ref";
import { makeAssetRef } from "./asset/asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "./asset/asset-spec";
import { isWithin, resolveStashDir } from "./common";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry } from "./config/config";
import { resolveConfiguredSources } from "./config/config";
import { ConfigError, UsageError } from "./errors";

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
}

/**
 * Source kinds that the loader is allowed to mark `writable: true`. Anything
 * else is rejected at config load (per locked decision 4) — see
 * {@link assertWritableAllowedForKind}.
 */
const REJECTED_WRITABLE_KINDS: ReadonlySet<string> = new Set(["website", "npm"]);

/**
 * Maximum length of a sanitized git commit message. Git itself imposes no
 * fixed limit, but message strings come from refs and `--message` flags that
 * can be supplied by users or upstream config. A 4096-char clamp keeps audit
 * trails readable and prevents pathological payloads from bloating the log
 * stream a downstream consumer parses.
 */
const COMMIT_MESSAGE_MAX_LENGTH = 4096;

/**
 * Sanitize a string before passing it as `git commit -m <message>`.
 *
 * Defenses, in order:
 *   1. Strip NUL bytes (`\0`) — git rejects them anyway, but we never want
 *      them in argv.
 *   2. Replace any CR/LF (`\r`, `\n`) and other ASCII control chars with a
 *      single space. This collapses newline-injection attempts that would
 *      otherwise turn a single-line commit subject into a forged trailer
 *      block.
 *   3. Collapse runs of whitespace into a single space and trim.
 *   4. Clamp to {@link COMMIT_MESSAGE_MAX_LENGTH} characters.
 *
 * If the result is empty after sanitization the caller should substitute a
 * default — this helper returns `""` rather than throwing because not every
 * callsite has a sensible "invalid input" exit code, and "empty" is a
 * recoverable signal.
 */
export function sanitizeCommitMessage(input: string): string {
  if (typeof input !== "string") return "";
  // 1. Strip NULs outright.
  let out = input.replace(/\0/g, "");
  // 2. Replace CR/LF + other C0 control characters (0x00-0x1F, 0x7F) with a
  //    space. Tab (0x09) is included intentionally — commit subjects should
  //    be a single visual line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
  out = out.replace(/[\x00-\x1F\x7F]/g, " ");
  // 3. Collapse whitespace runs and trim.
  out = out.replace(/\s+/g, " ").trim();
  // 4. Clamp length.
  if (out.length > COMMIT_MESSAGE_MAX_LENGTH) {
    out = out.slice(0, COMMIT_MESSAGE_MAX_LENGTH).trimEnd();
  }
  return out;
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

  return { path: filePath, ref: makeAssetRef(ref.type, ref.name, ref.origin) };
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

  return { path: filePath, ref: makeAssetRef(ref.type, ref.name, ref.origin) };
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
 * For a git target it delegates to `saveGitStash(name, message, writable, …)`,
 * which stages `.akm/` + sibling assets together (`git add -A`), commits once,
 * and pushes when the target is writable, has a remote, and `push !== false`.
 *
 * The push intent honours a deprecated `options.pushOnCommit` on the source
 * config (mapped onto the batch push gate) when `push` is not explicitly set.
 */
export function commitWriteTargetBoundary(
  target: ResolvedWriteTarget,
  message: string,
  options?: { push?: boolean },
): void {
  if (target.source.kind !== "git") return;

  warnIfPushOnCommit(target.config);

  // Map the deprecated per-asset `pushOnCommit` intent onto the batch push gate
  // when the caller did not pass an explicit push toggle. `saveGitStash` still
  // gates the actual push on writable + remote, so this only ever opts *in*.
  const push = options?.push ?? (target.config.options?.pushOnCommit === true ? true : undefined);

  const writable = resolveWritable(target.config);
  // Commit against the already-resolved repo directory (target.source.path)
  // rather than re-resolving the stash by name through config. The write helper
  // resolved this exact path; the boundary commit must operate on the SAME
  // directory so the staged batch matches what was just written.
  saveGitStash(undefined, message, writable, {
    repoDir: target.source.path,
    ...(push === undefined ? {} : { push }),
  });
}

/**
 * Emit a one-time deprecation warning the first time a source config carrying
 * `options.pushOnCommit` is encountered. The field still parses (for old
 * configs) but its per-asset push-on-commit behaviour is retired; its intent is
 * now honoured via the batch push gate (writable + remote + push toggle).
 */
let pushOnCommitWarned = false;
function warnIfPushOnCommit(config: SourceConfigEntry): void {
  if (config.options?.pushOnCommit === undefined) return;
  if (pushOnCommitWarned) return;
  pushOnCommitWarned = true;
  const label = config.name ? ` on source "${config.name}"` : "";
  process.stderr.write(
    `warning: \`options.pushOnCommit\`${label} is deprecated (0.9.0) and no longer commits per asset. ` +
      "akm now commits writes in a single batch at the operation boundary and pushes when the target is " +
      "writable with a remote. Remove the option or rely on sync push instead.\n",
  );
}

// ── Write-target resolution (locked decision 3) ─────────────────────────────

/**
 * Result of {@link resolveWriteTarget}: the chosen source plus the persisted
 * config entry that drove the decision. Callers pass both straight into
 * {@link writeAssetToSource}.
 */
export interface ResolvedWriteTarget {
  source: WriteTargetSource;
  config: SourceConfigEntry;
}

/**
 * Resolve the destination for a write per locked decision 3:
 *
 *   1. Explicit `--target <name>` (when supplied)
 *   2. `config.defaultWriteTarget`
 *   3. `config.stashDir` (the working stash created by `akm init`)
 *   4. `ConfigError("no writable source configured; run `akm init`")`
 *
 * The legacy `first-writable-in-source-array-order` fallback is *not* used —
 * see plan §6 decision 3 for the rationale.
 */
export function resolveWriteTarget(akmConfig: AkmConfig, explicitTarget?: string): ResolvedWriteTarget {
  const configuredSources = resolveConfiguredSources(akmConfig);

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
    if (!effectiveWritable) {
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
      if (!effectiveWritable) {
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
  const typeDir = TYPE_DIRS[ref.type];
  if (!typeDir) {
    throw new UsageError(`Unknown asset type "${ref.type}". Cannot resolve a write path.`, "INVALID_FLAG_VALUE");
  }
  const typeRoot = path.join(source.path, typeDir);
  const assetPath = resolveAssetPathFromName(ref.type, typeRoot, ref.name);
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
  const writePath = pathFromConfiguredSource(runtime);
  if (!writePath) {
    throw new ConfigError(
      `Source "${runtime.name}" has no resolvable on-disk path; writes are unsupported for this entry.`,
      "INVALID_CONFIG_FILE",
    );
  }
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

  const config: SourceConfigEntry = {
    type: runtime.type,
    name: runtime.name,
    ...(writePath !== undefined ? { path: writePath } : {}),
    ...(runtime.writable !== undefined ? { writable: runtime.writable } : {}),
    ...(runtime.options ? { options: runtime.options } : {}),
  };

  return {
    source: { kind, name: runtime.name, path: writePath },
    config,
  };
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
