// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./errors";
import { getConfigPath, getDefaultStashDir } from "./paths";

// ── Constants ───────────────────────────────────────────────────────────────

// Moved to the platform leaf so paths.ts can use it without a common↔paths
// cycle (chunk-8 WI-8.6, DoD 11); re-exported here for the existing surface.
export { IS_WINDOWS } from "./platform";
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
export const MAX_LOCAL_METADATA_BYTES = 1024 * 1024;
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

export function readTextFileWithLimit(filePath: string, maxBytes: number, label = "File"): string {
  const fd = fs.openSync(filePath, "r");
  try {
    return readTextFileDescriptorWithLimit(fd, maxBytes, label, filePath);
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
 *      don't fail on exotic mounts.
 */
export function writeFileAtomic(target: string, content: string | Buffer, mode?: number): void {
  const tmp = `${target}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  const fd = fs.openSync(tmp, "w", mode ?? 0o600);
  try {
    fs.writeSync(fd, typeof content === "string" ? Buffer.from(content) : content);
    try {
      fs.fdatasyncSync(fd);
    } catch {
      // Best-effort: some pseudo-filesystems lack fdatasync. Fall through
      // to closeSync — the rename below still preserves atomicity even if
      // the data isn't durable, and the calling code's retry will recover.
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  try {
    const dirFd = fs.openSync(path.dirname(target), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported on FAT, some FUSE mounts, and Windows
    // (where directories cannot be opened for read like POSIX). Silently
    // ignore so writeFileAtomic remains portable.
  }
}

/**
 * Resolve the stash directory using a three-level fallback chain:
 *   1. AKM_STASH_DIR environment variable (override for CI/scripts)
 *   2. stashDir field in config.json
 *   3. Platform default (~/akm or ~/Documents/akm on Windows)
 *
 * Pure read: never writes to disk. The legacy `readOnly` option is accepted
 * (and ignored) for one release cycle so older callers continue to compile;
 * it can be removed in the next minor bump.
 *
 * Throws if no valid stash directory is found.
 */
export function resolveStashDir(_options?: { readOnly?: boolean }, env: NodeJS.ProcessEnv = process.env): string {
  // 1. Env var override (for CI, scripts, testing)
  const envDir = env.AKM_STASH_DIR?.trim();
  if (envDir) {
    return validateStashDir(envDir);
  }

  // 2. Config file stashDir field
  const configStashDir = readStashDirFromConfig();
  if (configStashDir) return validateStashDir(configStashDir);

  // 3. Platform default — use it if it exists
  const defaultDir = getDefaultStashDir(env);
  if (isValidDirectory(defaultDir)) {
    return defaultDir;
  }

  throw new ConfigError(
    `No stash directory found. Run "akm init" to create one at ${defaultDir}, ` +
      `or set stashDir in ${getConfigPath()}.`,
    "STASH_DIR_NOT_FOUND",
  );
}

function validateStashDir(raw: string): string {
  const stashDir = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(stashDir);
  } catch {
    throw new ConfigError(`Unable to read stash directory at "${stashDir}".`, "STASH_DIR_UNREADABLE");
  }
  if (!stat.isDirectory()) {
    throw new ConfigError(`Stash path must point to a directory: "${stashDir}".`, "STASH_DIR_NOT_A_DIRECTORY");
  }
  return stashDir;
}

function isValidDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read stashDir directly from config.json without pulling in the full config
 * module, to avoid circular dependencies.
 */
function readStashDirFromConfig(): string | undefined {
  try {
    const configPath = getConfigPath();
    const text = readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file");
    const raw = JSON.parse(text);
    if (typeof raw === "object" && raw !== null && typeof raw.stashDir === "string" && raw.stashDir.trim()) {
      return raw.stashDir.trim();
    }
  } catch {
    // Config doesn't exist or is invalid — fall through
  }
  return undefined;
}

export function toPosix(input: string): string {
  return input.replace(/\\/g, "/");
}

export function hasErrnoCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return (error as Record<string, unknown>).code === code;
}

export function isWithin(candidate: string, root: string): boolean {
  const resolvedRoot = safeRealpath(root);
  const resolvedCandidate = safeRealpath(candidate);
  const normalizedRoot = normalizeFsPathForComparison(resolvedRoot);
  const normalizedCandidate = normalizeFsPathForComparison(resolvedCandidate);
  const rel = path.relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Fetch with an AbortController timeout.
 * Defaults to 30 seconds if no timeout is specified.
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
 * Fetch with retry and exponential backoff.
 * Retries on network errors, 429, and 5xx responses.
 * Honors Retry-After header for 429 responses.
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: { timeout?: number; retries?: number; baseDelay?: number },
): Promise<Response> {
  const maxRetries = options?.retries ?? 3;
  const baseDelay = options?.baseDelay ?? 500;
  const timeout = options?.timeout ?? 30_000;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, init, timeout);
      if (attempt < maxRetries && shouldRetry(response.status)) {
        const retryAfter = parseRetryAfter(response);
        const delay = retryAfter ?? baseDelay * 2 ** attempt * (0.5 + Math.random() * 0.5);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries) throw err;
      const delay = baseDelay * 2 ** attempt * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("fetchWithRetry: unreachable");
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
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
 * Read a Response body as a UTF-8 string with a byte-count cap.
 *
 * Streams the body so we abort as soon as the cap is exceeded, without
 * buffering the full response first. If the server sent a
 * `Content-Length` larger than the cap, we refuse before reading any
 * bytes. `response.body` is consumed and cancelled on cap breach.
 *
 * `maxBytes` defaults to {@link DEFAULT_RESPONSE_BYTE_CAP} (10 MB).
 */
export async function readBodyWithByteCap(response: Response, maxBytes = DEFAULT_RESPONSE_BYTE_CAP): Promise<string> {
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
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ResponseTooLargeError(url, maxBytes, total);
      }
      chunks.push(value);
    }
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
): Promise<T> {
  const text = await readBodyWithByteCap(response, maxBytes);
  return JSON.parse(text) as T;
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  return Number.isNaN(seconds) ? undefined : seconds * 1000;
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

// ── Generic data utilities ───────────────────────────────────────────────────

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
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
