// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrateLegacySourceShape } from "./config/legacy-source-shape-shim";
import { ConfigError } from "./errors";
import { getConfigPath, getDefaultStashDir, getRegistryCacheDir, getRegistryIndexCacheDir } from "./paths";

// ── Constants ───────────────────────────────────────────────────────────────

// Moved to the platform leaf so paths.ts can use it without a common↔paths
// cycle (chunk-8 WI-8.6, DoD 11); re-exported here for the existing surface.
export { IS_WINDOWS } from "./platform";
export const MAX_LOCK_METADATA_BYTES = 64 * 1024;

export function isHttpUrl(value: string | undefined): boolean {
  return !!value && /^https?:\/\//.test(value);
}

/**
 * Returns `true` when `value` looks like a remote URL that a VCS or HTTP
 * fetch can access. Covers http/https, git@, ssh://, and git:// schemes.
 * Consolidates the repeated inline URL-detection pattern in source-manage.ts.
 */
export function isRemoteUrl(value: string | undefined): boolean {
  if (!value) return false;
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("git@") ||
    value.startsWith("ssh://") ||
    value.startsWith("git://")
  );
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function readTextFileDescriptorWithLimit(
  fd: number,
  maxBytes: number,
  label = "File",
  displayPath = "(open file)",
): string {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) throw new ConfigError(`${label} is not a regular file: ${displayPath}.`, "INVALID_CONFIG_FILE");
  if (stat.size > maxBytes) {
    throw new ConfigError(`${label} exceeds the ${maxBytes}-byte limit: ${displayPath}.`, "INVALID_CONFIG_FILE");
  }
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total <= maxBytes) {
    const bytesRead = fs.readSync(fd, buffer, total, maxBytes + 1 - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new ConfigError(`${label} exceeds the ${maxBytes}-byte limit: ${displayPath}.`, "INVALID_CONFIG_FILE");
  }
  return buffer.subarray(0, total).toString("utf8");
}

export function readTextFile(filePath: string, label = "File"): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new ConfigError(`${label} is not a regular file: ${filePath}.`, "INVALID_CONFIG_FILE");
    return fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Write content to a file atomically via a temp file + rename.
 * Prevents partial-write corruption on crash.
 * The temp file is opened with the target `mode` (default 0o600) from the
 * start, so it is never world-readable even briefly.
 *
 * `content` may be a string or a `Buffer`. Buffer callers (e.g. secrets, where
 * binary certs and CRLF/LF endings must round-trip byte-exact) get the same
 * fsync'd temp-file-plus-rename guarantees as string callers — there is a
 * single atomic-write implementation.
 *
 * Durability: fsync'd against the May 2026 config-clobber incident (#472).
 * On ext4 (data=ordered) and NVMe-with-TRIM, a power-loss inside the kernel
 * writeback window could leave the renamed file truncated to zero — defeating
 * the purpose of the atomic rename. We:
 *   1. fdatasync the temp fd before close, so the data is on disk before the
 *      rename observes it.
 *   2. fsync the parent directory after rename, so the directory entry change
 *      is durable too. Some filesystems (FAT, certain FUSE mounts) don't
 *      support directory fsync; we ignore EINVAL/ENOTSUP so atomic writes
 *      don't fail on those mounts. Windows does not support opening a
 *      directory for fsync, so the directory-sync step is skipped there.
 */
/**
 * Strip JavaScript-style comments from a JSON string (JSONC support).
 * Handles `//` line comments and `/* *​/` block comments while preserving
 * comment-like sequences inside quoted strings.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    if (inString) {
      if (text[i] === "\\") {
        result += text[i] + (text[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === '"') {
      inString = true;
      result += text[i];
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    result += text[i];
    i++;
  }
  return result;
}

/**
 * The mode to rewrite an existing USER-owned file with.
 *
 * {@link writeFileAtomic} creates its temp file with an explicit mode and
 * chmods it, so it needs one — and its 0600 default is right for akm's own
 * state but wrong for a user's asset, where rewriting must never change
 * permissions. Returns the file's current mode, or the umask-derived default
 * `fs.writeFileSync` would have produced for a new file.
 */
export function existingFileMode(filePath: string): number {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    // Absent (a new asset) or unreadable: fall back to the default create mode.
    try {
      return 0o666 & ~process.umask();
    } catch {
      return 0o644;
    }
  }
}

export function writeFileAtomic(target: string, content: string | Buffer, mode?: number): void {
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  const data = typeof content === "string" ? Buffer.from(content) : content;
  const fileMode = mode ?? 0o600;
  let fd: number | undefined;
  let tempOwned = false;
  let renamed = false;
  let failed = false;
  let failure: unknown;
  try {
    fd = fs.openSync(tmp, "wx", fileMode);
    tempOwned = true;
    if (process.platform !== "win32") fs.fchmodSync(fd, fileMode);
    let offset = 0;
    while (offset < data.byteLength) {
      const written = fs.writeSync(fd, data, offset, data.byteLength - offset);
      if (written <= 0) throw new Error(`Could not make progress writing atomic temp file ${tmp}.`);
      offset += written;
    }
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, target);
    renamed = true;
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (tempOwned && !renamed) {
      try {
        fs.unlinkSync(tmp);
      } catch (error) {
        if (!failed && !hasErrnoCode(error, "ENOENT")) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  if (failed) throw failure;

  if (process.platform !== "win32") {
    let dirFd: number;
    try {
      dirFd = fs.openSync(path.dirname(target), "r");
    } catch (error) {
      if (hasErrnoCode(error, "EINVAL") || hasErrnoCode(error, "ENOTSUP")) return;
      throw error;
    }
    try {
      try {
        fs.fsyncSync(dirFd);
      } catch (error) {
        if (!hasErrnoCode(error, "EINVAL") && !hasErrnoCode(error, "ENOTSUP")) throw error;
      }
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

/**
 * Resolve the stash directory using a three-level fallback chain:
 *   1. AKM_BUNDLE_DIR environment variable (override for CI/scripts)
 *   2. The configured default bundle path
 *   3. Platform default (~/akm or ~/Documents/akm on Windows)
 *
 * Throws if no valid stash directory is found.
 */
export function resolveStashDir(env: NodeJS.ProcessEnv = process.env): string {
  // 1. Env var override (for CI, scripts, testing)
  const envDir = env.AKM_BUNDLE_DIR?.trim();
  if (envDir) {
    return validateStashDir(envDir);
  }

  // 2. Configured default bundle path
  const configStashDir = readStashDirFromConfig();
  if (configStashDir) return validateStashDir(configStashDir);

  // 3. Platform default — use it if it exists
  const defaultDir = getDefaultStashDir(env);
  if (isValidDirectory(defaultDir)) {
    return defaultDir;
  }

  throw new ConfigError(
    `No bundle directory found. Run "akm bundle create" to create one at ${defaultDir}.`,
    "STASH_DIR_NOT_FOUND",
  );
}

function validateStashDir(raw: string): string {
  const stashDir = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(stashDir);
  } catch {
    throw new ConfigError(`Unable to read bundle directory at "${stashDir}".`, "STASH_DIR_UNREADABLE");
  }
  if (!stat.isDirectory()) {
    throw new ConfigError(`Bundle path must point to a directory: "${stashDir}".`, "STASH_DIR_NOT_A_DIRECTORY");
  }
  return stashDir;
}

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch (error) {
    // Genuinely absent — the caller's "not found" fallback applies. Any other
    // stat failure (e.g. EACCES) is not "doesn't exist"; treating it as such
    // produced the wrong message ("Run akm bundle create") for a directory
    // that exists but cannot be read.
    if (hasErrnoCode(error, "ENOENT")) return false;
    throw new ConfigError(`Unable to read bundle directory at "${dir}".`, "STASH_DIR_UNREADABLE");
  }
}

/**
 * Read the primary stash path directly from config.json without pulling in the
 * full config module, to avoid circular dependencies.
 *
 * Reads only the current `bundles`/`defaultBundle` shape. Unsupported older
 * keys are never interpreted as a second config architecture.
 */
function readStashDirFromConfig(): string | undefined {
  try {
    const configPath = getConfigPath();
    const text = readTextFile(configPath, "Config file");
    // The config loader accepts JSONC, so a commented config.json is valid and
    // in use. Parsing it raw here threw, the catch swallowed it, and every
    // caller silently fell back — operating on the wrong bundle or failing with
    // STASH_DIR_NOT_FOUND despite a perfectly good config.
    const parsed = JSON.parse(stripJsonComments(text));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const raw = migrateLegacySourceShape(parsed as Record<string, unknown>, configPath);
    // 0.9.0 config-shape cutover (spec §10.1): the primary stash is the
    // `defaultBundle`'s filesystem `path`. Read it directly (no config module
    // import) so the primary-stash location survives the stashDir → bundles
    // migration without a runtime rewire.
    const bundles = raw.bundles as Record<string, { path?: string; components?: unknown }> | undefined;
    const defaultBundle = raw.defaultBundle;
    const selectedBundle = typeof defaultBundle === "string" ? bundles?.[defaultBundle] : undefined;
    const selectedBundlePath = typeof selectedBundle?.path === "string" ? selectedBundle.path : undefined;
    if (bundles && typeof bundles === "object" && typeof defaultBundle === "string" && selectedBundlePath?.trim()) {
      const bundle = selectedBundle as { path: string; components?: unknown };
      const bundlePath = bundle.path.trim();
      if (bundle.components !== undefined) {
        if (typeof bundle.components !== "object" || bundle.components === null) {
          throw new ConfigError("A bundle components map must contain exactly one component.", "INVALID_CONFIG_FILE");
        }
        const components = Object.values(bundle.components);
        if (components.length !== 1) {
          throw new ConfigError("A bundle components map must contain exactly one component.", "INVALID_CONFIG_FILE");
        }
        const component = components[0];
        if (typeof component === "object" && component !== null) {
          const componentConfig = component as Record<string, unknown>;
          if (typeof componentConfig.root !== "string") return bundlePath;
          const bundleRoot = path.resolve(bundlePath);
          const componentRoot = path.resolve(bundleRoot, componentConfig.root);
          if (!isWithin(componentRoot, bundleRoot)) {
            throw new ConfigError(
              `Component root "${componentConfig.root}" escapes bundle "${defaultBundle}".`,
              "INVALID_CONFIG_FILE",
            );
          }
          return componentRoot;
        }
      }
      return bundlePath;
    }
  } catch (err) {
    // An unsupported-shape refusal must reach the caller; genuine missing/invalid
    // config (read or JSON-parse failure) falls through to the platform default.
    if (err instanceof ConfigError) throw err;
  }
  return undefined;
}

export function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

/** Locale-independent code-point ordering — a stable `Array.prototype.sort` comparator for strings (paths, names, ids). */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as Record<string, unknown>).code === code;
}

/**
 * True when `value` is a RELATIVE path that cannot leave its base directory:
 * no absolute form (POSIX `/`, Windows `\` or a `C:` drive prefix), no `~`
 * home expansion, and no `..` segment under either separator.
 *
 * This is the SYNTACTIC half of containment — cheap, string-only, usable at
 * authoring time before any directory exists. It is deliberately paired with
 * (never a substitute for) {@link isWithin}, which resolves symlinks against a
 * real base at use time. Workflow `exec` units run both: the parser and the
 * frozen-plan decoder reject uncontained spellings, and the executor re-checks
 * the resolved path before spawning.
 */
export function isContainedRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\") || value.startsWith("~")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[/\\]+/).includes("..");
}

export function isWithin(candidate: string, root: string): boolean {
  return isContainedResolvedPath(safeRealpath(candidate), safeRealpath(root));
}

/**
 * True when `filePath` sits inside akm's OWN resolved registry-cache
 * directories (`<cache>/registry`, `<cache>/registry-index` —
 * {@link getRegistryCacheDir}/{@link getRegistryIndexCacheDir}), the
 * read-only installed-source/registry-index copies that lint (and `--fix`)
 * must never touch.
 *
 * This is the single source of truth for that exclusion — it replaces what
 * used to be three independent unanchored substring checks
 * (`posixPath.includes("/.cache/") || posixPath.includes("/registry/")`).
 * That check matched ANY path merely containing the literal text `.cache` or
 * `registry` anywhere in it — a normal XDG `~/.cache/...` user bundle, or a
 * CI workspace checked out under a `.cache`-named directory, tripped it and
 * silently got zero lint findings. Using {@link isWithin} (realpath +
 * containment, not a string search) fixes that while still excluding the
 * real cache content the check was meant to skip.
 */
export function isAkmRegistryCachePath(filePath: string): boolean {
  return isWithin(filePath, getRegistryCacheDir()) || isWithin(filePath, getRegistryIndexCacheDir());
}

/**
 * {@link isWithin} for callers that must not block the event loop (e.g. the
 * workflow exec dispatch path, which runs once per fan-out unit). Same
 * comparison, same normalization, same nearest-existing-ancestor fallback —
 * only the realpath syscalls are awaited.
 */
export async function isWithinAsync(candidate: string, root: string): Promise<boolean> {
  return isContainedResolvedPath(await safeRealpathAsync(candidate), await safeRealpathAsync(root));
}

/** The containment comparison shared by {@link isWithin} and {@link isWithinAsync}. */
function isContainedResolvedPath(resolvedCandidate: string, resolvedRoot: string): boolean {
  const rel = path.relative(
    normalizeFsPathForComparison(resolvedRoot),
    normalizeFsPathForComparison(resolvedCandidate),
  );
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  // Compare the first SEGMENT, not a string prefix: `..data` and `...v2` are
  // legal directory names, and only a leading `..` segment means the candidate
  // climbed out of the root. Both separators, because `path.relative` answers
  // in the host's spelling while callers may hold either.
  return rel.split(/[/\\]+/)[0] !== "..";
}

/**
 * Resolve symlinks on `p`, walking up to the closest existing ancestor when
 * `p` itself does not exist.  This ensures that comparisons between an
 * existing directory and a not-yet-created child path inside it are
 * consistent even when the directory hierarchy contains symlinks (e.g.
 * macOS /tmp → /private/tmp, or a HOME that is itself a symlink).
 */
export function safeRealpath(p: string): string {
  const resolved = path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist — resolve symlinks on the nearest existing ancestor
    // and reconstruct the full path from there.
    const suffix: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding an existing entry.
        return resolved;
      }
      suffix.unshift(path.basename(current));
      current = parent;
      try {
        const realParent = fs.realpathSync(current);
        return path.join(realParent, ...suffix);
      } catch {
        // parent also doesn't exist; keep walking up
      }
    }
  }
}

/** {@link safeRealpath}'s async twin — awaited syscalls, identical walk-up. */
export async function safeRealpathAsync(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return await fs.promises.realpath(resolved);
  } catch {
    const suffix: string[] = [];
    let current = resolved;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.unshift(path.basename(current));
      current = parent;
      try {
        return path.join(await fs.promises.realpath(current), ...suffix);
      } catch {
        // parent also doesn't exist; keep walking up
      }
    }
  }
}

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Fetch with an AbortController timeout.
 * Defaults to 30 seconds if no timeout is specified.
 *
 * SCOPE — connection + response-header phase only. `timeoutMs` bounds the time
 * until `fetch` RESOLVES (i.e. until the status line + headers arrive); the
 * timer is cleared once the `Response` is returned. It does NOT bound the time
 * spent streaming the response BODY: a server can dribble body bytes forever
 * under any per-byte limit. Callers that read the body MUST bound it
 * themselves — pass `{ bodyTimeoutMs, signal }` to {@link readBodyWithByteCap}
 * (in-memory reads) or use a capped streaming writer for downloads. That is the
 * sanctioned "body-deadline mechanism"; a bounded header timeout here plus a
 * bounded body read there gives a bounded TOTAL window.
 *
 * External `signal`: a caller-supplied `AbortSignal` aborts the in-flight
 * request with the caller's own `reason`. The bridged listener is removed in
 * `finally`, so once this function returns the caller's signal no longer
 * governs the returned `Response`'s body stream — pass the SAME `signal` to the
 * body-read helper so cancellation continues to apply to the body phase with
 * the caller's reason. (A timeout and an external abort can never overwrite
 * each other: whichever fires first aborts the controller, and a second
 * `controller.abort()` is a no-op that preserves the first reason.)
 */
export async function fetchWithTimeout(
  url: string,
  opts?: RequestInit,
  timeoutMs: number | null = 30_000,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      if (timer) clearTimeout(timer);
      controller.abort(signal.reason);
    } else {
      signal.addEventListener("abort", abortExternal, { once: true });
    }
  }
  try {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error(`Request aborted: ${url}`);
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      if (signal?.aborted) {
        throw new Error(`Request aborted: ${url}`);
      }
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener("abort", abortExternal);
    if (timer) clearTimeout(timer);
  }
}

/**
 * Cap on how long a retry loop will wait between attempts, even when a
 * server-supplied `Retry-After` claims a longer delay. Prevents an
 * attacker-controlled or misconfigured server from parking a caller
 * indefinitely.
 */
export const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

export function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Jittered exponential backoff, capped at `maxDelayMs`. */
export function backoffDelay(attempt: number, baseDelay = 500, maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS): number {
  return Math.min(maxDelayMs, baseDelay * 2 ** attempt * (0.5 + Math.random() * 0.5));
}

/**
 * Determine the delay before the next retry attempt.
 *
 * Honors a server-supplied `Retry-After` header in both its numeric-seconds
 * and HTTP-date forms, but always clamps the result to `maxDelayMs` — an
 * unclamped `Retry-After` lets an attacker/misconfigured server park a
 * caller for an arbitrarily long time. Falls back to jittered exponential
 * backoff when the header is absent or unparseable.
 */
export function computeRetryDelay(
  response: Response,
  attempt: number,
  options?: { baseDelay?: number; maxDelayMs?: number },
): number {
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const baseDelay = options?.baseDelay ?? 500;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds >= 0 ? Math.min(maxDelayMs, seconds * 1_000) : backoffDelay(attempt, baseDelay, maxDelayMs);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(maxDelayMs, Math.max(0, date - Date.now()));
  }
  return backoffDelay(attempt, baseDelay, maxDelayMs);
}

/**
 * Fetch with retry and exponential backoff.
 * Retries on network errors, 429, and 5xx responses.
 * Honors Retry-After header, capped at `maxDelayMs`.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: { timeout?: number; retries?: number; baseDelay?: number; maxDelayMs?: number },
): Promise<Response> {
  const maxRetries = options?.retries ?? 3;
  const baseDelay = options?.baseDelay ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  const timeout = options?.timeout ?? 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeout, init?.signal ?? undefined);
      if (attempt < maxRetries && shouldRetry(response.status)) {
        const delay = computeRetryDelay(response, attempt, { baseDelay, maxDelayMs });
        await response.body?.cancel().catch(() => undefined);
        await abortableDelay(delay, init?.signal);
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      // A caller-supplied abort is terminal: never keep retrying past it.
      if (init?.signal?.aborted) throw err;
      await abortableDelay(backoffDelay(attempt, baseDelay, maxDelayMs), init?.signal);
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

/**
 * Sleep, but wake immediately if `signal` aborts.
 *
 * A server-supplied `Retry-After` is honored verbatim and can be arbitrarily
 * large. Sleeping it out with a bare `setTimeout` ignored the caller's abort
 * signal entirely, so a single `429` could park an operation far past any
 * deadline its caller believed it had imposed — the request timeout bounds
 * only the request, never the wait between attempts. Callers using this for
 * a retry delay should pass a `maxDelayMs`-capped `ms` (see
 * {@link computeRetryDelay}) to bound the wait itself.
 */
export function abortableDelay(ms: number, signal?: AbortSignal | null, abortMessage = "Aborted"): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error(abortMessage));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error(abortMessage));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Read stdin as UTF-8 text if something is piped in. Returns `undefined`
 * when stdin is a TTY (no pipe) or when the piped content is empty.
 */
export function tryReadStdinText(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  const input = fs.readFileSync(0, "utf8");
  return input.length > 0 ? input : undefined;
}

/**
 * Default byte cap for untrusted network responses (10 MB).
 *
 * Applies to website scraping, registry index fetches, and any other
 * response that is read into memory from a source the CLI does not fully
 * control. A compromised or malicious endpoint that streams an unbounded
 * response would otherwise exhaust RAM — this cap ensures the process
 * aborts with a clean error instead of crashing.
 */
export const DEFAULT_RESPONSE_BYTE_CAP = 10 * 1024 * 1024;

/**
 * Thrown by {@link readBodyWithByteCap} and its helpers when a response
 * body exceeds the caller's byte cap. Callers can catch this specifically
 * to surface a targeted error to the user.
 */
export class ResponseTooLargeError extends Error {
  readonly url: string;
  readonly maxBytes: number;
  readonly observedBytes: number | null;
  constructor(url: string, maxBytes: number, observedBytes: number | null) {
    const observed = observedBytes === null ? "unknown" : `${observedBytes} bytes`;
    super(`Response body exceeded ${maxBytes} bytes (observed: ${observed}): ${url}`);
    this.name = "ResponseTooLargeError";
    this.url = url;
    this.maxBytes = maxBytes;
    this.observedBytes = observedBytes;
  }
}

/**
 * Thrown by {@link readBodyWithByteCap} / {@link readChunkWithDeadline} (and the
 * capped disk writer) when streaming a response body exceeds the caller's
 * overall body-read deadline. Distinct from a connection/header timeout
 * (`fetchWithTimeout`) — this is the body-phase bound.
 */
export class BodyReadTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`Response body read exceeded ${timeoutMs}ms: ${url}`);
    this.name = "BodyReadTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Body-phase limits paired with {@link fetchWithTimeout} (which bounds only the
 * connection/header phase). Callers reading an untrusted body pass these so a
 * server dribbling bytes forever, or a caller cancellation, is bounded.
 */
export interface BodyReadLimits {
  /** Overall wall-clock budget (ms) for streaming the whole body. */
  bodyTimeoutMs?: number;
  /** Caller signal; aborting it rejects the in-progress read with its reason. */
  signal?: AbortSignal;
}

function bodyAbortError(signal: AbortSignal | undefined, url: string): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(`Response body read aborted: ${url}`);
}

/**
 * Read one chunk from `reader`, rejecting if the overall body deadline passes
 * or `signal` aborts first. `deadlineAt` is an absolute epoch-ms instant (null
 * = no deadline). Only races the pending `read()` so a stalled body cannot
 * block forever; the CALLER cancels the reader on rejection. Throws
 * {@link BodyReadTimeoutError} on deadline, or the signal's reason (or an
 * AbortError) on external abort.
 */
export async function readChunkWithDeadline<T>(
  reader: ReadableStreamDefaultReader<T>,
  deadlineAt: number | null,
  signal: AbortSignal | undefined,
  url: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>;
  if (signal?.aborted) throw bodyAbortError(signal, url);
  const remaining = deadlineAt === null ? null : deadlineAt - Date.now();
  if (remaining !== null && remaining <= 0) throw new BodyReadTimeoutError(url, timeoutMs);
  if (remaining === null && !signal) return reader.read();
  return new Promise<ReadResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(bodyAbortError(signal, url));
    };
    if (remaining !== null) {
      timer = setTimeout(() => {
        cleanup();
        reject(new BodyReadTimeoutError(url, timeoutMs));
      }, remaining);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

/**
 * Read a Response body as a UTF-8 string with a byte-count cap.
 *
 * Streams the body so we abort as soon as the cap is exceeded, without
 * buffering the full response first. If the server sent a
 * `Content-Length` larger than the cap, we refuse before reading any
 * bytes. `response.body` is consumed and cancelled on cap breach.
 *
 * `maxBytes` defaults to {@link DEFAULT_RESPONSE_BYTE_CAP} (10 MB). `limits`
 * bounds the body PHASE (duration + caller abort) that `fetchWithTimeout` does
 * not cover; pass the same `signal` you gave `fetchWithTimeout` so caller
 * cancellation keeps applying while the body streams.
 */
export async function readBodyWithByteCap(
  response: Response,
  maxBytes = DEFAULT_RESPONSE_BYTE_CAP,
  limits?: BodyReadLimits,
): Promise<string> {
  const url = response.url || "(unknown URL)";
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Don't even start reading.
      await response.body?.cancel?.().catch(() => undefined);
      throw new ResponseTooLargeError(url, maxBytes, declared);
    }
  }

  const body = response.body;
  if (!body) {
    // No streaming body available (e.g., some mock environments). Fall
    // back to text() but still enforce the cap post-hoc.
    const text = await response.text();
    const byteLength = Buffer.byteLength(text, "utf8");
    if (byteLength > maxBytes) throw new ResponseTooLargeError(url, maxBytes, byteLength);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const bodyTimeoutMs = limits?.bodyTimeoutMs;
  const deadlineAt = bodyTimeoutMs != null ? Date.now() + bodyTimeoutMs : null;
  try {
    while (true) {
      const { done, value } = await readChunkWithDeadline(reader, deadlineAt, limits?.signal, url, bodyTimeoutMs ?? 0);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError(url, maxBytes, total);
      chunks.push(value);
    }
  } catch (err) {
    // Cancel the underlying stream on ANY failure (cap breach, body-read
    // timeout, or caller abort) so the socket is released, not just on cap.
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock?.();
  }

  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Parse a Response body as JSON with a byte-count cap. A cheap wrapper
 * around {@link readBodyWithByteCap}; prefer this for registry index
 * fetches, GitHub API responses, and any other untrusted JSON source.
 */
export async function jsonWithByteCap<T = unknown>(
  response: Response,
  maxBytes = DEFAULT_RESPONSE_BYTE_CAP,
  limits?: BodyReadLimits,
): Promise<T> {
  const text = await readBodyWithByteCap(response, maxBytes, limits);
  return JSON.parse(text) as T;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Date / timestamp utilities ───────────────────────────────────────────────

/**
 * Return today's date in ISO-8601 format (`YYYY-MM-DD`).
 * Consolidates the `new Date().toISOString().slice(0, 10)` pattern that
 * appears at multiple call sites.
 */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD` in LOCAL time — deliberately not {@link todayIso}, which is
 * UTC and can differ near midnight. This is the spelling the `updated:`
 * frontmatter stampers share (`core/asset/akm-markdown.ts` on write,
 * `commands/lint/base-linter.ts` on `--fix`), so the field's format has one
 * definition even though the two stampers pick different instants (now vs
 * file mtime).
 */
export function localDateStamp(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Return a filesystem-safe timestamp string derived from the current instant.
 * Colons and dots are replaced with hyphens so the result is safe as a
 * filename component on all platforms (e.g. `2024-01-15T10-30-00-000Z`).
 */
export function timestampForFilename(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ── String coercion ──────────────────────────────────────────────────────────

/**
 * Return the trimmed string value if non-empty, otherwise `undefined`.
 * Consolidates `toStringOrUndefined` (frontmatter.ts), `asNonEmptyString`
 * (config.ts), and `firstString` (memory-improve.ts) — all had the same
 * "return a string or undefined" contract with minor semantic differences.
 */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ── env-file assignment scanning ─────────────────────────────────────────────

/** Matches a `KEY=value` assignment line, capturing only the key. */
export const ENV_ASSIGN_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/** Scan lines and return KEY names in file order, without duplicates. */
export function scanEnvKeyNames(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(ENV_ASSIGN_LINE_RE);
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** True when `value` contains no lone/unpaired UTF-16 surrogate (every surrogate is part of a valid pair). */
export function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

// ── Generic data utilities ───────────────────────────────────────────────────

/**
 * Narrow an unknown value to a plain-ish record: an `object` that is neither
 * `null` nor an `Array`. Does not distinguish a literal `{}` from a `Date`,
 * `Map`, or class instance — callers that need that distinction use a
 * stricter predicate instead.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `JSON.parse` that returns `undefined` instead of throwing. */
export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Coerce an unknown value to a filtered, trimmed string array.
 * Non-strings and empty/whitespace-only entries are dropped.
 */
export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

/**
 * Group an array of values by a string key derived from each element.
 * Returns a `Map` so insertion order within each group is preserved.
 */
/**
 * Return true if a process with the given PID is currently alive.
 * Uses `process.kill(pid, 0)` which does not deliver a signal but
 * throws ESRCH when the process does not exist.
 *
 * EPERM means the process EXISTS but belongs to another uid, so it must be
 * reported alive. Treating it as dead let a lock held by a live process in a
 * shared data dir (agent sandboxes, containers, service accounts — a
 * configuration managed-db.ts explicitly supports) be reclaimed as stale.
 *
 * `pid` is `unknown` because callers reading it out of untrusted on-disk
 * JSON (e.g. a lease file) cannot guarantee it parsed as a valid PID; a
 * non-positive-integer value is reported dead without ever reaching
 * `process.kill`.
 */
export function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/**
 * Convert a number of days to milliseconds. Consolidates the
 * `N * 24 * 60 * 60 * 1000` pattern used throughout the cooldown logic.
 */
export function daysToMs(days: number): number {
  return days * 86_400_000;
}

export function groupBy<T>(values: T[], keyFn: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFn(value);
    const existing = groups.get(key);
    if (existing) existing.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}
