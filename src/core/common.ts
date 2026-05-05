import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "./asset-spec";
import { ConfigError } from "./errors";
import { getConfigPath, getDefaultStashDir } from "./paths";

// ── Types ───────────────────────────────────────────────────────────────────

export type AkmAssetType = string;

// ── Constants ───────────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32";

export function isHttpUrl(value: string | undefined): boolean {
  return !!value && /^https?:\/\//.test(value);
}

export function filterNonEmptyStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

// ── Validators ──────────────────────────────────────────────────────────────

export function isAssetType(type: string): type is AkmAssetType {
  return Object.hasOwn(TYPE_DIRS, type);
}

// ── Utilities ───────────────────────────────────────────────────────────────

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
export function resolveStashDir(_options?: { readOnly?: boolean }): string {
  // 1. Env var override (for CI, scripts, testing)
  const envDir = process.env.AKM_STASH_DIR?.trim();
  if (envDir) {
    return validateStashDir(envDir);
  }

  // 2. Config file stashDir field
  const configStashDir = readStashDirFromConfig();
  if (configStashDir) return validateStashDir(configStashDir);

  // 3. Platform default — use it if it exists
  const defaultDir = getDefaultStashDir();
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
    const text = fs.readFileSync(configPath, "utf8");
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
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortExternal = (): void => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
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
    clearTimeout(timer);
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
    if (text.length > maxBytes) throw new ResponseTooLargeError(url, maxBytes, text.length);
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
