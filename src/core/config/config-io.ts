// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pure I/O helpers for AKM config files.
 *
 * No knowledge of the AkmConfig shape — these functions just read JSON(C) text
 * from disk and write JSON text back atomically. Validation and migration live
 * in `./config.ts` and `./config-migrate.ts`.
 *
 * Split out so the load path is testable without touching the filesystem
 * (`parseConfigText` is pure), and so a single atomic write path serves
 * `saveConfig`, the migrate command, and the setup wizard (#464.c).
 */
import fs from "node:fs";
import path from "node:path";
import { sleepSync } from "../../runtime";
import { MAX_CONFIG_FILE_BYTES, readTextFileWithLimit, writeFileAtomic } from "../common";
import { ConfigError } from "../errors";
import { createLockPayload, probeLock, reclaimStaleLock, releaseLock, tryAcquireLockSync } from "../file-lock";
import { getCacheDir, getConfigDir } from "../paths";

/**
 * Read the raw text of a config file. Returns `undefined` when the file does
 * not exist (legitimate cold-start). Other I/O errors propagate.
 */
export function readConfigText(configPath: string): string | undefined {
  try {
    return readTextFileWithLimit(configPath, MAX_CONFIG_FILE_BYTES, "Config file");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * Parse JSON(C) config text into a plain object. Strips `//` and `/* *​/`
 * comments before parsing.
 *
 * Throws {@link ConfigError} when the text is unparseable or when the root is
 * not a JSON object. Per #458, malformed config text is NOT silently rescued —
 * the caller must surface the parse error.
 */
export function parseConfigText(text: string, sourcePath?: string): Record<string, unknown> {
  const stripped = stripJsonComments(text);
  const where = sourcePath ? ` at ${sourcePath}` : "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `Failed to parse config JSON${where}: ${detail}`,
      "INVALID_CONFIG_FILE",
      "Edit the file to fix the JSON syntax error. Comments (// and /* */) are allowed; trailing commas are not.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `Config file${where} must contain a JSON object at the root, got ${describeJsonRoot(parsed)}.`,
      "INVALID_CONFIG_FILE",
    );
  }

  return parsed as Record<string, unknown>;
}

function describeJsonRoot(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return "a boolean";
  return typeof value;
}

/**
 * Atomically write a config object to disk as pretty-printed JSON. Routes
 * through {@link writeFileAtomic} so partial writes can never corrupt the
 * config file (#464.c).
 */
export function writeConfigAtomic(configPath: string, config: Record<string, unknown>): void {
  writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

/** Maximum number of timestamped config backups to retain (#459). */
const MAX_CONFIG_BACKUPS = 5;

/**
 * Snapshot the current config file to `<cacheDir>/config-backups/`. Writes
 * both a timestamped copy and a `config.latest.json` pointer, then prunes the
 * timestamped set to {@link MAX_CONFIG_BACKUPS} most-recent entries.
 *
 * No-op when the source file does not exist (cold-start safe).
 *
 * Returns the written backup paths (the timestamped copy plus the
 * `config.latest.json` pointer), or `undefined` when there was nothing to
 * back up. Callers use the timestamped path to print the real backup
 * location instead of a generic display string.
 */
export interface ConfigBackupResult {
  /** Absolute path to the timestamped `config-<timestamp>.json` snapshot. */
  timestamped: string;
  /** Absolute path to the rolling `config.latest.json` pointer. */
  latest: string;
}

export function backupExistingConfig(configPath: string, now = new Date()): ConfigBackupResult | undefined {
  if (!fs.existsSync(configPath)) return undefined;

  const backupDir = path.join(getCacheDir(), "config-backups");
  // 08-F4: lock the backup dir owner-only up front (0700) — matching the
  // env.ts/secret.ts convention — so no other local user can traverse in during
  // the copy→chmod window. chmod again to tighten a dir from an older version.
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);

  const timestamp = now.toISOString().replace(/[.:]/g, "-");
  let sequence = 0;
  let timestamped: string;
  while (true) {
    timestamped = path.join(backupDir, `config-${timestamp}${sequence === 0 ? "" : `-${sequence}`}.json`);
    try {
      fs.copyFileSync(configPath, timestamped, fs.constants.COPYFILE_EXCL);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      sequence++;
    }
  }
  const latest = path.join(backupDir, "config.latest.json");
  fs.copyFileSync(configPath, latest);
  // 08-F4: a config backup carries the same sensitive fields as the live config
  // (endpoints, tokens). `copyFileSync` inherits the source's (often 0644) mode,
  // so tighten the backups to owner-only — mirrors the env-cli 0600 write floor.
  fs.chmodSync(timestamped, 0o600);
  fs.chmodSync(latest, 0o600);

  pruneOldBackups(backupDir);

  return { timestamped, latest };
}

function pruneOldBackups(backupDir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(backupDir);
  } catch {
    return;
  }
  const timestamped = entries
    .filter((n) => n.startsWith("config-") && n.endsWith(".json") && n !== "config.latest.json")
    .map((name) => {
      const full = path.join(backupDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        // Unreadable — sorts to the end via mtime 0.
      }
      return { path: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const stale of timestamped.slice(MAX_CONFIG_BACKUPS)) {
    try {
      fs.unlinkSync(stale.path);
    } catch {
      // Best-effort prune; next save will retry.
    }
  }
}

// ── Config write lock ────────────────────────────────────────────────────────

/**
 * Path to the config write sentinel (`config.json.lck` in $CONFIG).
 *
 * Placed next to config.json so the lock scope is obvious and the path is
 * predictable for debugging. Uses $CONFIG (not $DATA) because config.json
 * itself lives in $CONFIG — they should fail together if the dir is read-only.
 */
export function getConfigLockPath(): string {
  return path.join(getConfigDir(), "config.json.lck");
}

const CONFIG_LOCK_MAX_RETRIES = 10;
const CONFIG_LOCK_RETRY_DELAY_MS = 50;

/**
 * Block the current thread for `ms` without busy-spinning (H8). Delegates to
 * the runtime boundary's `sleepSync`, a real blocking sleep that yields the
 * thread to the OS scheduler.
 */
function sleepSyncMs(ms: number): void {
  sleepSync(ms);
}

/**
 * Acquire an exclusive sentinel around config writes.
 *
 * Returns a release function. Acquisition is fail-closed: config mutation may
 * never continue without owning the lock that protects its read/merge/write.
 */
export function acquireConfigLock(): () => void {
  const lockPath = getConfigLockPath();
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Directory already exists or unwritable — let the write fail naturally.
  }

  for (let attempt = 0; attempt < CONFIG_LOCK_MAX_RETRIES; attempt++) {
    try {
      const ownership = tryAcquireLockSync(lockPath, createLockPayload());
      if (ownership) {
        return () => releaseLock(ownership);
      }
    } catch (error) {
      throw new ConfigError(
        `Unable to acquire config lock at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        "INVALID_CONFIG_FILE",
      );
    }
    const probe = probeLock(lockPath);
    if (probe.state === "stale" && reclaimStaleLock(lockPath, probe)) {
      continue; // Reclaimed — retry immediately.
    }
    if (attempt < CONFIG_LOCK_MAX_RETRIES - 1) {
      // H8: yield the thread between retries instead of busy-spinning.
      // The previous `while (Date.now() < deadline)` loop burned CPU for up to
      // 50ms per retry (≈500ms total), freezing the single JS thread and
      // starving co-scheduled work under parallel load. `sleepSync` is a
      // real blocking sleep that releases the thread to the OS scheduler.
      // Kept synchronous (rather than an async sleep) to preserve the sync
      // `withConfigLock` signature and avoid an async ripple through every
      // `saveConfig`/`loadConfig` caller. Lock semantics are unchanged: same
      // retry count, same delay budget, same best-effort fall-through.
      sleepSyncMs(CONFIG_LOCK_RETRY_DELAY_MS);
    }
  }
  throw new ConfigError(
    `Timed out waiting for config lock at ${lockPath}. Another AKM process may be updating config.`,
    "INVALID_CONFIG_FILE",
  );
}

/**
 * Run `fn` inside the config write lock. Always releases the lock.
 */
export function withConfigLock<T>(fn: () => T): T {
  const release = acquireConfigLock();
  try {
    return fn();
  } finally {
    release();
  }
}

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
