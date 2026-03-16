import fs from "node:fs";
import path from "node:path";
import { isWithin } from "./common";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IncludeConfig {
  baseDir: string;
  include: string[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Keys to check in package.json for akm include configuration. */
const INCLUDE_CONFIG_KEYS = ["akm", "agentikit"] as const;

function readPackageJsonAt(dirPath: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(path.join(dirPath, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function extractIncludeList(pkg: Record<string, unknown> | undefined): string[] | undefined {
  if (!pkg) return undefined;
  for (const key of INCLUDE_CONFIG_KEYS) {
    const config = pkg[key];
    if (typeof config !== "object" || config === null || Array.isArray(config)) continue;
    const { include } = config as Record<string, unknown>;
    if (!Array.isArray(include)) continue;
    const list = include
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
    if (list.length > 0) return list;
  }
  return undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Walk up the directory tree from `startDir` to `boundary` (inclusive) looking
 * for a package.json that declares an `akm.include` or `agentikit.include` list.
 * Returns the first config found, or `undefined` if none is found within the
 * boundary.
 */
export function findNearestIncludeConfig(startDir: string, boundary: string): IncludeConfig | undefined {
  let current = path.resolve(startDir);
  const resolvedBoundary = path.resolve(boundary);

  while (isWithin(current, resolvedBoundary)) {
    const pkg = readPackageJsonAt(current);
    const include = extractIncludeList(pkg);
    if (include && include.length > 0) {
      return { baseDir: current, include };
    }
    if (current === resolvedBoundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

/**
 * Copy each glob/path in `includeGlobs` from `sourceDir` to `destDir`.
 *
 * Uses `isWithin()` to prevent path-traversal attacks: any entry that escapes
 * `sourceDir` throws immediately rather than silently being skipped.
 *
 * @throws {Error} if an include path escapes `sourceDir` or does not exist on disk.
 */
export function copyIncludedPaths(includeGlobs: string[], sourceDir: string, destDir: string): void {
  for (const entry of includeGlobs) {
    const resolvedSource = path.resolve(sourceDir, entry);
    if (!isWithin(resolvedSource, sourceDir)) {
      throw new Error(`Path in akm.include escapes the package root: ${entry}`);
    }
    if (!fs.existsSync(resolvedSource)) {
      throw new Error(`Path in akm.include does not exist: ${entry}`);
    }
    if (path.basename(resolvedSource) === ".git") {
      continue;
    }
    const relativePath = path.relative(sourceDir, resolvedSource);
    if (!relativePath || relativePath === ".") {
      copyDirectoryContents(sourceDir, destDir);
      continue;
    }
    copyPath(resolvedSource, path.join(destDir, relativePath));
  }
}

// ── Private helpers ─────────────────────────────────────────────────────────

function copyDirectoryContents(sourceDir: string, destinationDir: string): void {
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    copyPath(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name));
  }
}

function copyPath(sourcePath: string, destinationPath: string): void {
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, destinationPath, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(sourcePath, destinationPath);
}
