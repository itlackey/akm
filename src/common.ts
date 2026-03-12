import fs from "node:fs";
import path from "node:path";
import { TYPE_DIRS } from "./asset-spec";
import { ConfigError } from "./errors";
import { getConfigPath, getDefaultStashDir } from "./paths";

// ── Types ───────────────────────────────────────────────────────────────────

export type AgentikitAssetType = "skill" | "command" | "agent" | "knowledge" | "script";

// ── Constants ───────────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32";

// ── Validators ──────────────────────────────────────────────────────────────

export function isAssetType(type: string): type is AgentikitAssetType {
  return type in TYPE_DIRS;
}

// ── Utilities ───────────────────────────────────────────────────────────────

/**
 * Resolve the stash directory using a three-level fallback chain:
 *   1. AKM_STASH_DIR environment variable (override for CI/scripts)
 *   2. stashDir field in config.json
 *   3. Platform default (~/akm or ~/Documents/akm on Windows)
 *
 * Throws if no valid stash directory is found.
 */
export function resolveStashDir(options?: { readOnly?: boolean }): string {
  // 1. Env var override (for CI, scripts, testing)
  const envDir = process.env.AKM_STASH_DIR?.trim();
  if (envDir) {
    const resolved = validateStashDir(envDir);
    if (!options?.readOnly) persistStashDirToConfig(resolved);
    return resolved;
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
  );
}

function validateStashDir(raw: string): string {
  const stashDir = path.resolve(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(stashDir);
  } catch {
    throw new ConfigError(`Unable to read stash directory at "${stashDir}".`);
  }
  if (!stat.isDirectory()) {
    throw new ConfigError(`Stash path must point to a directory: "${stashDir}".`);
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

/**
 * Persist stashDir to config.json if not already set, so users can
 * transition away from relying on the AKM_STASH_DIR env var.
 */
function persistStashDirToConfig(stashDir: string): void {
  try {
    const configPath = getConfigPath();
    let raw: Record<string, unknown> = {};
    try {
      const text = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        raw = parsed;
      }
    } catch {
      // No existing config or invalid — start fresh
    }

    if (!raw.stashDir) {
      raw.stashDir = stashDir;
      const dir = path.dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${configPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
      fs.renameSync(tmpPath, configPath);
    }
  } catch {
    // Non-fatal: best-effort persistence
  }
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

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

function normalizeFsPathForComparison(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/**
 * Fetch with an AbortController timeout.
 * Defaults to 30 seconds if no timeout is specified.
 */
export async function fetchWithTimeout(url: string, opts?: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
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

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = parseInt(header, 10);
  return Number.isNaN(seconds) ? undefined : seconds * 1000;
}
