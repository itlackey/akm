// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Dependency-free adapter-id table (#909).
 *
 * `core/config/schema/sources-bundles.ts` needs one small, DATA-shaped fact
 * about the adapter registry: the canonical ordered id list, to validate
 * `components.*.adapter` and to reject a typo instead of silently falling
 * back to `akm` (#909). Importing `./registry.ts` (`BUILTIN_ADAPTERS`) for
 * that would pull in all 11 concrete adapters and, transitively, the indexer
 * modules they delegate to (`indexer/passes/metadata`, `core/asset/*`, …) —
 * weight a config-schema module has no reason to carry just to validate one
 * enum. This table is the canonical, dependency-free MIRROR of the id list;
 * `./adapters/index.ts`'s `BUILTIN_ADAPTERS` construction asserts its ids
 * match this table (order included) at module-load time, so the two can
 * never silently drift without a loud failure.
 */

/** Canonical, ordered list of valid adapter ids (matches `BUILTIN_ADAPTERS` order). */
export const ADAPTER_ID_TABLE: readonly string[] = [
  "website-snapshot",
  "agent-skills",
  "claude",
  "opencode",
  "dotenv",
  "akm-workflow",
  "akm-task",
  "llm-wiki",
  "akm",
  "okf",
  "generic-files",
] as const;

/** The dependency-free counterpart of `./registry.ts`'s `getAdapters().map(a => a.id)`. */
export const VALID_ADAPTER_IDS: readonly [string, ...string[]] = ADAPTER_ID_TABLE as unknown as readonly [
  string,
  ...string[],
];
