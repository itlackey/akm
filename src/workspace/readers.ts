// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Readers shared by the workspace operations: the read-only state database, the stash directory, per-section isolation and caps. */

import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolveStashDir } from "../core/common";
import { type AkmConfig, getConfigValueSource, loadConfig, sanitizeConfigForWrite } from "../core/config/config";
import { bundleKeyForContentRoot } from "../core/config/config-sources";
import { UsageError } from "../core/errors";
import { getStateDbPath, listPendingStateMigrations } from "../core/state-db";
import { resolveWorkingStashTarget } from "../core/write-source";
import { implicitStashDir } from "../indexer/search/search-source";
import { type Database, openDatabase } from "../storage/database";
import { applyReadonlyPragmas } from "../storage/sqlite-pragmas";

/**
 * Run `fn` against `state.db` opened read-only, or return `fallback` when it
 * does not exist or is behind on migrations (a read-only open must not apply
 * them; `akm health` reports that state). The handle is closed before returning,
 * so no request holds a lock past its own read.
 */
export function withReadonlyStateDb<T>(fn: (db: Database) => T, fallback: T): T {
  const dbPath = getStateDbPath();
  if (!fs.existsSync(dbPath) || listPendingStateMigrations(dbPath).length > 0) return fallback;
  const db = openDatabase(dbPath, { readonly: true, create: false });
  try {
    applyReadonlyPragmas(db);
    return fn(db);
  } finally {
    db.close();
  }
}

export function tryStashDir(): string | null {
  try {
    return resolveStashDir();
  } catch {
    return null;
  }
}

/** `section` for a synchronous read, where the caller needs a fallback value (a read inside an open database). */
export function attempt<T>(errors: Record<string, string>, name: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : String(error);
    return fallback;
  }
}

/** Run each section of a composite response on its own: one failing store degrades one section, not the page. */
export async function section<T>(
  errors: Record<string, string>,
  name: string,
  fn: () => T | Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : String(error);
    return null;
  }
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

/** A list size from a caller: the default when absent or not a positive integer, never above the cap. */
export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIST_LIMIT): number {
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) return fallback;
  return Math.min(limit, MAX_LIST_LIMIT);
}

/** Most characters of either side a detail view returns; a larger file is cut and flagged `truncated`. */
export const DIFF_SIDE_MAX_CHARS = 512 * 1024;

export function capSide(text: string | null): { text: string | null; truncated: boolean } {
  if (text === null || text.length <= DIFF_SIDE_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, DIFF_SIDE_MAX_CHARS), truncated: true };
}

/**
 * The working stash is the directory akm reads besides the configured bundles (`implicitStashDir`).
 * It is described only when no configured bundle already covers that directory.
 */
export function workingStashDir(config: AkmConfig): string | undefined {
  try {
    const dir = implicitStashDir(config);
    return dir && !bundleKeyForContentRoot(config, dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

/** Refuse a write that the config sanitizer would turn into a silent credential removal. */
export function preserveUnrelatedConfig(config = loadConfig()) {
  if (!isDeepStrictEqual(sanitizeConfigForWrite(config, { quiet: true }), config)) {
    throw new UsageError(
      "AKM's config sanitizer would remove unrelated credentials. Remove registry URL credentials using the CLI before changing bundle configuration in the UI.",
    );
  }
}

export function configSource(path: string[]): string | null {
  // `getConfigValueSource` takes a dotted path; a key that contains a dot cannot be told apart from two keys.
  if (path.some((segment) => segment.includes("."))) return null;
  try {
    const source = getConfigValueSource(path.join("."));
    return source === "local" ? "file" : source;
  } catch {
    return null;
  }
}

/** Where an automatic write goes (no defaultWriteTarget): AKM_BUNDLE_DIR first, then the default bundle. */
export function automaticWriteTarget(config: AkmConfig) {
  try {
    const { source } = resolveWorkingStashTarget(config, { requireWritable: false });
    const path = source.path ?? null;
    return { name: source.name, path, workingStash: path !== null && path === workingStashDir(config) };
  } catch {
    return null; // No AKM_BUNDLE_DIR and no usable default bundle: writes need an explicit target.
  }
}
