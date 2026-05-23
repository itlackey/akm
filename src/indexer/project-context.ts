/**
 * Project-context resolution for search ranking.
 *
 * Extracts meaningful identifier tokens from the current working directory
 * so the ranking pipeline can boost assets that are relevant to the active
 * project. Token extraction tries, in order:
 *
 *   1. `.git/config` remote-origin URL basename (strips `.git` extension)
 *   2. `package.json` `name` field (last `/`-separated segment, minus common
 *      framework suffixes)
 *   3. Basename of the directory returned by `resolveWorkflowScopeAnchor`
 *   4. `null` — no meaningful project context (home dir, /tmp, etc.)
 *
 * Tokens are lowercased, split on `[-_/]`, then filtered through a noise-word
 * blocklist. A maximum of 5 tokens is kept.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkflowScopeAnchor } from "../workflows/scope-key.js";

// Words that appear in almost every project name and carry no discriminating
// signal for ranking. Filtered out after token splitting.
const TOKEN_BLOCKLIST = new Set([
  "my",
  "the",
  "app",
  "lib",
  "sdk",
  "api",
  "cli",
  "tool",
  "kit",
  "core",
  "main",
  "index",
  "src",
  "test",
]);

// Common suffixes stripped from package.json `name` before tokenisation so
// that e.g. `akm-cli` contributes `akm` rather than `akm` + `cli` (which is
// in the blocklist anyway, but explicit stripping keeps the raw name shorter).
const STRIP_SUFFIXES = ["-cli", "-app", "-lib", "-sdk", "-plugin"];

const MAX_TOKENS = 5;

// Paths that are definitely NOT a meaningful project root (home dir, tmp).
// When `resolveWorkflowScopeAnchor` returns one of these we return `null`.
function isNoiseRoot(dir: string): boolean {
  const homedir = os.homedir();
  const normalized = dir.replace(/\/+$/, "");
  if (normalized === homedir || normalized === homedir.replace(/\/+$/, "")) return true;
  // /tmp or /tmp/… (any depth)
  if (normalized === "/tmp" || normalized.startsWith("/tmp/")) return true;
  // Windows-style temp
  const tmpdir = os.tmpdir();
  if (normalized === tmpdir || normalized.startsWith(tmpdir + path.sep)) return true;
  return false;
}

export interface ProjectContext {
  /** Lowercase project identifier tokens, e.g. `Set { "akm" }` for the akm repo. */
  tokens: Set<string>;
}

/**
 * Filesystem abstraction injected during tests so callers can supply fixture
 * files without touching the real FS.
 */
export interface FsOverride {
  readFileSync(filePath: string, encoding: BufferEncoding): string;
}

/**
 * Resolve the project context for the given working directory.
 *
 * @param cwd       - Directory to inspect. Defaults to `process.cwd()`.
 * @param fsOverride - Optional FS override for unit testing.
 * @returns `ProjectContext` with a non-empty `tokens` set, or `null` when no
 *          meaningful context can be derived (home dir, /tmp, extraction failed).
 */
export function resolveProjectContext(cwd?: string, fsOverride?: FsOverride): ProjectContext | null {
  const effectiveCwd = cwd ?? process.cwd();
  const readFile = fsOverride?.readFileSync ?? ((p: string, enc: BufferEncoding) => fs.readFileSync(p, enc));

  // Attempt 1 — git remote-origin URL
  const gitConfigPath = path.join(effectiveCwd, ".git", "config");
  const gitTokens = tryExtractGitTokens(gitConfigPath, readFile);
  if (gitTokens !== null && gitTokens.size > 0) {
    return { tokens: gitTokens };
  }

  // Attempt 2 — package.json name
  const pkgJsonPath = path.join(effectiveCwd, "package.json");
  const pkgTokens = tryExtractPackageJsonTokens(pkgJsonPath, readFile);
  if (pkgTokens !== null && pkgTokens.size > 0) {
    return { tokens: pkgTokens };
  }

  // Attempt 3 — workflow scope anchor basename
  try {
    const anchor = resolveWorkflowScopeAnchor(effectiveCwd);
    if (isNoiseRoot(anchor)) return null;
    const baseName = path.basename(anchor);
    const tokens = tokenize(baseName);
    if (tokens.size > 0) {
      return { tokens };
    }
  } catch {
    // Ignore errors from scope anchor resolution (e.g. during testing).
  }

  return null;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Parse `.git/config` for the `[remote "origin"]` section and extract the
 * repo name from the `url =` line.
 *
 *   url = git@github.com:itlackey/akm.git   → "akm"
 *   url = https://github.com/itlackey/akm   → "akm"
 */
function tryExtractGitTokens(
  gitConfigPath: string,
  readFile: (p: string, enc: BufferEncoding) => string,
): Set<string> | null {
  try {
    const content = readFile(gitConfigPath, "utf-8");
    const urlMatch = extractRemoteOriginUrl(content);
    if (!urlMatch) return null;

    // Strip .git extension, then take the last path segment.
    const withoutGit = urlMatch.replace(/\.git$/, "");
    const segments = withoutGit.replace(/\/$/, "").split(/[/:]/).filter(Boolean);
    const repoName = segments[segments.length - 1] ?? "";
    const tokens = tokenize(repoName);
    return tokens.size > 0 ? tokens : null;
  } catch {
    return null;
  }
}

/**
 * Extracts the `url =` value from the `[remote "origin"]` section of a git
 * config file. Returns `null` when the section or key is absent.
 */
function extractRemoteOriginUrl(content: string): string | null {
  // Split into sections delimited by `[...]` headers.
  const lines = content.split(/\r?\n/);
  let inOrigin = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      // New section header
      inOrigin = /^\[remote\s+"origin"\]$/i.test(trimmed);
      continue;
    }
    if (inOrigin) {
      const m = trimmed.match(/^url\s*=\s*(.+)$/i);
      if (m) return m[1].trim();
    }
  }
  return null;
}

/**
 * Read `package.json` and extract the `name` field as tokens.
 */
function tryExtractPackageJsonTokens(
  pkgPath: string,
  readFile: (p: string, enc: BufferEncoding) => string,
): Set<string> | null {
  try {
    const content = readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.name !== "string" || !parsed.name) return null;

    // For scoped packages (@org/pkg-name) take the last `/`-separated segment.
    const rawName = parsed.name.split("/").pop() ?? parsed.name;

    // Strip common framework suffixes before tokenising.
    let strippedName = rawName;
    for (const suffix of STRIP_SUFFIXES) {
      if (strippedName.endsWith(suffix)) {
        strippedName = strippedName.slice(0, -suffix.length);
        break; // only strip one suffix
      }
    }

    const tokens = tokenize(strippedName);
    return tokens.size > 0 ? tokens : null;
  } catch {
    return null;
  }
}

/**
 * Split a raw name string into lowercase tokens, then filter through the
 * blocklist and cap at `MAX_TOKENS`.
 *
 *   "akm-cli"   → Set { "akm" }
 *   "my-app"    → Set {}  (all tokens blocked)
 *   "openpalm"  → Set { "openpalm" }
 */
function tokenize(raw: string): Set<string> {
  const parts = raw
    .toLowerCase()
    .split(/[-_/]+/)
    .filter(Boolean)
    .filter((t) => !TOKEN_BLOCKLIST.has(t))
    .slice(0, MAX_TOKENS);
  return new Set(parts);
}
