/**
 * Tar archive extraction and integrity verification utilities.
 *
 * These helpers are security-critical: they validate archive entries to
 * prevent path traversal, run a post-extraction scan for symlink escapes,
 * and verify integrity hashes (SRI or hex shasum) before extraction.
 *
 * Extracted from `registry-install.ts` and shared by all syncable
 * providers that fetch tarballs (currently `NpmStashProvider` and the
 * registry index builder).
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../common";
import type { StashSource } from "../config";
import { warn } from "../warn";

/**
 * Verify an archive's integrity against a known hash. Throws and removes
 * the archive when verification fails.
 *
 * Supports SRI hashes (sha256-/sha512-) and hex SHA-1 from npm.
 * Skips verification for git/github sources (revisions are commit SHAs,
 * not content hashes).
 */
export function verifyArchiveIntegrity(
  archivePath: string,
  expected: string | undefined,
  source?: StashSource["type"],
): void {
  if (!expected) return;

  // For GitHub and git sources, resolvedRevision is a commit SHA, not a content hash.
  // Content integrity cannot be verified from a commit hash, so skip verification.
  if (source === "github" || source === "git") return;

  const fileBuffer = fs.readFileSync(archivePath);

  // SRI hash format: sha256-<base64> or sha512-<base64>
  if (expected.startsWith("sha256-") || expected.startsWith("sha512-")) {
    const dashIndex = expected.indexOf("-");
    const algorithm = expected.slice(0, dashIndex);
    const expectedBase64 = expected.slice(dashIndex + 1);
    const actualBase64 = createHash(algorithm).update(fileBuffer).digest("base64");
    if (actualBase64 !== expectedBase64) {
      fs.unlinkSync(archivePath);
      throw new Error(
        `Integrity check failed for ${archivePath}: expected ${algorithm} digest ${expectedBase64}, got ${actualBase64}`,
      );
    }
    return;
  }

  // Hex shasum (SHA-1 from npm)
  if (/^[0-9a-f]{40}$/i.test(expected)) {
    const actualHex = createHash("sha1").update(fileBuffer).digest("hex");
    if (actualHex.toLowerCase() !== expected.toLowerCase()) {
      fs.unlinkSync(archivePath);
      throw new Error(`Integrity check failed for ${archivePath}: expected sha1 ${expected}, got ${actualHex}`);
    }
    return;
  }

  // Unrecognized format — warn and skip verification
  warn("Unrecognized integrity format: %s — verification skipped", expected);
}

/**
 * Extract a tar.gz archive into `destinationDir`, validating entries first
 * (no absolute paths, no `..` traversal, no NUL bytes), invoking tar with
 * `--no-same-owner --strip-components=1`, and finally scanning the extracted
 * tree for symlinks that would escape the destination.
 */
export function extractTarGzSecure(archivePath: string, destinationDir: string): void {
  const listResult = spawnSync("tar", ["tzf", archivePath], { encoding: "utf8" });
  if (listResult.status !== 0) {
    const err = listResult.stderr?.trim() || listResult.error?.message || "unknown error";
    throw new Error(`Failed to inspect archive ${archivePath}: ${err}`);
  }

  validateTarEntries(listResult.stdout);

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  const extractResult = spawnSync(
    "tar",
    ["xzf", archivePath, "--no-same-owner", "--strip-components=1", "-C", destinationDir],
    { encoding: "utf8" },
  );
  if (extractResult.status !== 0) {
    const err = extractResult.stderr?.trim() || extractResult.error?.message || "unknown error";
    throw new Error(`Failed to extract archive ${archivePath}: ${err}`);
  }

  // Post-extraction scan: verify all extracted files are within destinationDir
  // This mitigates TOCTOU between validateTarEntries (list) and tar extract.
  scanExtractedFiles(destinationDir, destinationDir);
}

function scanExtractedFiles(dir: string, root: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    // Check for ".." segments in names (e.g. symlink tricks or crafted filenames)
    if (entry.name.includes("..")) {
      throw new Error(`Post-extraction scan: suspicious entry name: ${fullPath}`);
    }
    // Resolve symlinks to detect escapes outside the destination directory
    if (entry.isSymbolicLink()) {
      const target = fs.realpathSync(fullPath);
      if (!isWithin(target, root)) {
        throw new Error(`Post-extraction scan: symlink escapes destination directory: ${fullPath} -> ${target}`);
      }
    }
    if (entry.isDirectory()) {
      scanExtractedFiles(fullPath, root);
    }
  }
}

/**
 * Validate the line-oriented `tar tzf` listing for unsafe entries.
 *
 * Rejects:
 *   - empty/NUL-containing entries
 *   - absolute paths
 *   - parent traversal (`..` / `../`)
 *   - any entry that would still escape after `--strip-components=1`
 */
export function validateTarEntries(listOutput: string): void {
  const lines = listOutput.split(/\r?\n/).filter(Boolean);
  for (const rawLine of lines) {
    const entry = rawLine.trim();
    if (!entry || entry.includes("\0")) {
      throw new Error(`Archive contains an invalid entry: ${JSON.stringify(rawLine)}`);
    }
    if (entry.startsWith("/")) {
      throw new Error(`Archive contains an absolute path entry: ${entry}`);
    }

    const normalized = path.posix.normalize(entry);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Archive contains a path traversal entry: ${entry}`);
    }

    const parts = normalized.split("/").filter(Boolean);
    const stripped = parts.slice(1).join("/");
    if (!stripped) continue;
    const normalizedStripped = path.posix.normalize(stripped);
    if (
      normalizedStripped === ".." ||
      normalizedStripped.startsWith("../") ||
      path.posix.isAbsolute(normalizedStripped)
    ) {
      throw new Error(`Archive contains an unsafe entry after strip-components: ${entry}`);
    }
  }
}
