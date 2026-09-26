// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Install-time types used by `syncFromRef`.
 *
 * Distinct from the {@link SourceProvider} interface, which only deals with
 * configured sources already resolved into a directory.
 * These types describe the resolution+lockfile step that runs when
 * `akm bundle add <install-ref>` materialises an upstream artifact into a local
 * cache directory.
 *
 * They live here, outside `provider.ts`, so SourceProvider stays minimal.
 */

import type { InstallKind } from "../../registry/types";

export interface SyncOptions {
  /** Force a fresh fetch even when cached content is still valid. */
  force?: boolean;
  /** Override "now" — used by tests to make `syncedAt` deterministic. */
  now?: Date;
  /** Treat the cloned repo as writable (keeps `.git` and pulls instead of re-cloning). */
  writable?: boolean;
  /** Existing writable content root to update in place without changing its durable path. */
  writableRoot?: string;
  /** Configured component roots that must still exist in the fetched revision. */
  writableRequiredRoots?: readonly string[];
  /** Materialize under this cache root instead of the default (`akm bundle update` fetches into staging). */
  cacheRootDir?: string;
  /** Resolved HTTPS bearer credential. Never persisted or included in diagnostics. */
  credential?: string;
}

export interface SourceLockData {
  /** Stable identifier for the source (e.g. npm package name, git owner/repo, local path). */
  id: string;
  /** Source kind — the install/registry discriminator ("npm" | "github" | "git" | "local"). */
  source: InstallKind;
  /** The original ref that was synced (e.g. `npm:foo@1.2.3`). */
  ref: string;
  /** Resolved registry/upstream URL for the artifact, if any. */
  artifactUrl: string;
  /** Resolved semantic version, if applicable. */
  resolvedVersion?: string;
  /** Resolved git revision (commit SHA), if applicable. */
  resolvedRevision?: string;
  /** Content hash of the fetched archive when one was downloaded. */
  integrity?: string;
  /** Absolute path the walker should index. */
  contentDir: string;
  /** Cache directory holding raw + extracted artifacts. */
  cacheDir: string;
  /** Provisional staging directory before include filtering, if any. */
  extractedDir: string;
  /** Whether the synced cache should be treated as writable. */
  writable?: boolean;
  /** ISO timestamp at which the sync resolved. */
  syncedAt: string;
}
