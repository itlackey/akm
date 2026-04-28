/**
 * write-source — the only place in the codebase that branches on `source.kind`.
 *
 * v1 architecture spec §2.6 / §2.7 / §10 step 5: writing to a source is *not*
 * a SourceProvider interface concern. It's a small command-layer helper that
 * does a plain filesystem write, plus a git-specific commit (and optional
 * push) when the source is backed by a git working tree.
 *
 * If a third kind ever needs special write handling, it gets added here. For
 * v1 there are exactly two cases. Adding more parallel scoring systems for
 * different provider kinds is explicitly disallowed by CLAUDE.md.
 *
 * This module is the **single dispatch point** for `kind`-branching write
 * logic. Callers (remember, import, source-add, etc.) MUST go through
 * `writeAssetToSource` / `deleteAssetFromSource` rather than re-inlining the
 * filesystem-write + git-commit dance.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCachePaths, parseGitRepoUrl } from "../sources/providers/git";
import type { AssetRef } from "./asset-ref";
import { makeAssetRef } from "./asset-ref";
import { resolveAssetPathFromName, TYPE_DIRS } from "./asset-spec";
import { isWithin, resolveStashDir } from "./common";
import type { AkmConfig, ConfiguredSource, SourceConfigEntry } from "./config";
import { resolveConfiguredSources } from "./config";
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
 *   2. Performs a plain filesystem write to `path.join(source.path, …)`.
 *
 * For sources of `kind === "git"`, additionally:
 *
 *   3. `git -C <path> add <file>`
 *   4. `git -C <path> commit -m "Update <ref>"`
 *   5. `git -C <path> push` when `config.options.pushOnCommit` is truthy.
 *
 * Any other `kind` reaching this helper is a configuration bug — the loader
 * rejects unsupported writable kinds — so we throw {@link ConfigError}.
 */
export async function writeAssetToSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
  content: string,
): Promise<{ path: string; ref: string }> {
  ensureWritable(source, config);

  const filePath = resolveAssetFilePath(source, ref);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  fs.writeFileSync(filePath, normalized, "utf8");

  await runKindSpecificCommit(source, config, filePath, `Update ${formatRefForMessage(ref)}`);

  return { path: filePath, ref: makeAssetRef(ref.type, ref.name, ref.origin) };
}

/**
 * Delete the asset at `ref` from `source`. Symmetric to
 * {@link writeAssetToSource}: same writable check, same git-commit-and-push
 * convenience for `kind === "git"`.
 */
export async function deleteAssetFromSource(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  ref: AssetRef,
): Promise<{ path: string; ref: string }> {
  ensureWritable(source, config);

  const filePath = resolveAssetFilePath(source, ref);
  if (!fs.existsSync(filePath)) {
    throw new UsageError(
      `Asset "${formatRefForMessage(ref)}" not found in source "${source.name}" (expected at ${filePath}).`,
      "MISSING_REQUIRED_ARGUMENT",
    );
  }
  fs.unlinkSync(filePath);

  await runKindSpecificCommit(source, config, filePath, `Remove ${formatRefForMessage(ref)}`);

  return { path: filePath, ref: makeAssetRef(ref.type, ref.name, ref.origin) };
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
    if (match) return adaptConfiguredSource(match);
    // Fall through if the named target no longer exists — surface a clear error.
    throw new ConfigError(
      `defaultWriteTarget "${akmConfig.defaultWriteTarget}" does not match any configured source.`,
      "INVALID_CONFIG_FILE",
      "Update `defaultWriteTarget` in your config (run `akm config get defaultWriteTarget`) or run `akm list` to see configured sources.",
    );
  }

  // 3. Working stash (config.stashDir / resolveStashDir()).
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

async function runKindSpecificCommit(
  source: WriteTargetSource,
  config: SourceConfigEntry,
  filePath: string,
  message: string,
): Promise<void> {
  if (source.kind === "filesystem") {
    return; // No commit step.
  }
  if (source.kind === "git") {
    runGitCommit(source.path, filePath, message);
    if (config.options?.pushOnCommit) {
      runGitPush(source.path);
    }
    return;
  }
  // Reject any other kind reaching the helper. The config loader is the
  // first line of defence (assertWritableAllowedForKind), but we throw here
  // so external callers that bypass the loader still get a clear error.
  throw new ConfigError(
    `write-source: unsupported kind "${source.kind}" for source "${source.name}". ` +
      "Writes are only defined for `filesystem` and `git` sources.",
    "INVALID_CONFIG_FILE",
    'Set `kind: "filesystem"` (or `kind: "git"`) on the source, or add a parallel filesystem entry.',
  );
}

function runGitCommit(repoDir: string, filePath: string, message: string): void {
  // Stage the specific file rather than `add -A` so unrelated working-tree
  // changes don't get folded into the asset commit.
  const relPath = path.relative(repoDir, filePath) || filePath;
  const addResult = spawnSync("git", ["-C", repoDir, "add", "--", relPath], { encoding: "utf8" });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr?.trim() || "unknown error"}`);
  }

  // Defense in depth: sanitize the commit subject one more time at the spawn
  // boundary. Callers should already pass sanitized strings (via
  // formatRefForMessage / saveGitStash), but this guards against future
  // refactors that forget. Empty after sanitize falls back to a safe stub.
  const safeMessage = sanitizeCommitMessage(message) || "akm update";

  // Provide a fallback identity so fresh CI/test environments without
  // user.name/user.email configured can always commit.
  const commitResult = spawnSync(
    "git",
    ["-C", repoDir, "-c", "user.name=akm", "-c", "user.email=akm@local", "commit", "-m", safeMessage],
    { encoding: "utf8" },
  );
  if (commitResult.status !== 0) {
    // `nothing to commit` is a no-op success — the file may have matched the
    // existing tree exactly. Surface other errors verbatim.
    const stderr = commitResult.stderr ?? "";
    if (
      /nothing to commit|no changes added/i.test(stderr) ||
      /nothing to commit|no changes added/i.test(commitResult.stdout ?? "")
    ) {
      return;
    }
    throw new Error(`git commit failed: ${stderr.trim() || "unknown error"}`);
  }
}

function runGitPush(repoDir: string): void {
  const pushResult = spawnSync("git", ["-C", repoDir, "push"], { encoding: "utf8", timeout: 120_000 });
  if (pushResult.status !== 0) {
    throw new Error(`git push failed: ${pushResult.stderr?.trim() || "unknown error"}`);
  }
}

function formatRefForMessage(ref: AssetRef): string {
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
  // filesystem and git produce writable sources at v1.
  const kind = runtime.type === "filesystem" || runtime.type === "git" ? runtime.type : runtime.type;

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
