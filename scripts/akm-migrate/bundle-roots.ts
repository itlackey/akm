// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The component roots the runtime reads, for the migration steps that rewrite files in them: each enabled bundle's,
 * and the working stash when no configured bundle owns it, with the adapter the configuration names for it and
 * whether akm may write it. Each step takes the roots whose adapters hold the files it rewrites.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectAdapterId } from "../../src/core/adapter/detect-adapter";
import { deriveBundleId } from "../../src/core/bundle-id";
import type { AkmConfig } from "../../src/core/config/config";
import {
  bundleComponentConfig,
  bundleKeyForContentRoot,
  bundlesToSourceEntries,
} from "../../src/core/config/config-sources";
import { ConfigError } from "../../src/core/errors";
import { resolveWritable } from "../../src/core/write-source";
import { implicitStashDir } from "../../src/indexer/search/search-source";
import { lockContentRootFor } from "../../src/integrations/lockfile";

export interface BundleRoot {
  readonly bundleId: string;
  readonly bundleRoot: string;
  /** The component root: where the bundle's adapter reads its files. */
  readonly root: string;
  /** The adapter the configuration names; absent when the runtime detects it from the files. */
  readonly adapter?: string;
  readonly writable: boolean;
}

function expandTilde(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function existingDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

/**
 * Reconcile two bundle roots that resolve to the same directory on disk
 * (issue #870 — e.g. `AKM_BUNDLE_DIR` pointed at a directory already
 * configured under a different bundle id). When the two roots agree on
 * everything that matters for migration (writability, adapter) the
 * duplicate is silently dropped so each file is enumerated once,
 * rather than surfacing as the opaque `duplicate task migration file path`
 * error further down the pipeline. When they disagree, name both bundle
 * ids and the shared path so the operator knows exactly what to fix.
 */
function reconcileDuplicateRoot(existing: BundleRoot, candidate: BundleRoot, sharedPath: string): void {
  const adapterOf = (root: BundleRoot): string => root.adapter ?? detectAdapterId(root.root);
  if (existing.writable === candidate.writable && adapterOf(existing) === adapterOf(candidate)) return;
  throw new ConfigError(
    `Bundles "${existing.bundleId}" and "${candidate.bundleId}" both resolve to the same directory ` +
      `(${sharedPath}) but disagree on writable/adapter settings. Two bundle ids configured for one ` +
      "directory must have matching settings, or one of them removed — run `akm bundle list` to see both.",
    "INVALID_CONFIG_FILE",
  );
}

/** The runtime's working stash, or none when there is no such directory yet. */
function workingStash(config: AkmConfig): string | undefined {
  try {
    return implicitStashDir(config);
  } catch (cause) {
    if (cause instanceof ConfigError) return undefined;
    throw cause;
  }
}

export function bundleRoots(config: AkmConfig): BundleRoot[] {
  const sources = new Map((bundlesToSourceEntries(config) ?? []).map((source) => [source.name, source]));
  const rootsByPath = new Map<string, BundleRoot>();
  for (const [bundleId, bundle] of Object.entries(config.bundles ?? {})) {
    if (bundle.enabled === false) continue;
    const source = sources.get(bundleId);
    if (!source) continue;
    const configuredRoot =
      source.type === "filesystem" && source.path
        ? path.resolve(expandTilde(source.path))
        : lockContentRootFor(bundleId, source.type);
    if (!configuredRoot || !existingDirectory(configuredRoot)) continue;

    const bundleRoot = path.resolve(configuredRoot);
    const component = bundleComponentConfig(bundle);
    const componentRoot = path.resolve(bundleRoot, component?.root ?? ".");
    const relative = path.relative(bundleRoot, componentRoot);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ConfigError(
        `Migration component root ${componentRoot} escapes bundle ${bundleId} at ${bundleRoot}.`,
        "INVALID_CONFIG_FILE",
      );
    }
    if (!existingDirectory(componentRoot)) continue;

    const candidate: BundleRoot = {
      bundleId,
      bundleRoot,
      root: componentRoot,
      ...(component?.adapter ? { adapter: component.adapter } : {}),
      writable: component?.writable ?? resolveWritable(source),
    };
    const existing = rootsByPath.get(componentRoot);
    if (existing) {
      reconcileDuplicateRoot(existing, candidate, componentRoot);
      continue;
    }
    rootsByPath.set(componentRoot, candidate);
  }

  // The working stash the runtime reads besides the bundles (`AKM_BUNDLE_DIR`, else the default stash): its files
  // must convert here too. A configured bundle at that directory, under any spelling, owns it as it does for the
  // runtime: the loop above took it with that bundle's policy, or left it as disabled.
  const stashRoot = workingStash(config);
  if (stashRoot && !rootsByPath.has(stashRoot) && bundleKeyForContentRoot(config, stashRoot) === undefined) {
    const bundleId = deriveBundleId(undefined, stashRoot, new Set(Object.keys(config.bundles ?? {})));
    // The runtime reads this stash with the adapter it detects, or `akm`.
    rootsByPath.set(stashRoot, {
      bundleId,
      bundleRoot: stashRoot,
      root: stashRoot,
      adapter: detectAdapterId(stashRoot),
      writable: true,
    });
  }
  return [...rootsByPath.values()];
}
