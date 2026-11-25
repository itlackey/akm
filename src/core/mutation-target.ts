// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import path from "node:path";
import { resolveSourceEntries, type SearchSource } from "../indexer/search/search-source";
import { type AssetRef, conceptIdFromTypeName, displayRef } from "./asset/resolve-ref";
import type { AkmConfig } from "./config/config";
import { UsageError } from "./errors";
import {
  prepareWriteTargetForMutation,
  type ResolvedWriteTarget,
  resolveWorkingStashTarget,
  resolveWriteTarget,
  type WriteTargetOptions,
  type WriteTargetSource,
} from "./write-source";

export interface ResolvedMutationTarget {
  target: ResolvedWriteTarget;
  /** Ref with the resolved source's stable identity, suitable for durable use. */
  ref: AssetRef;
  /** User-facing spelling, short only for the configured default bundle. */
  displayRef: string;
}

function sameTarget(left: WriteTargetSource, right: { name: string; path?: string }): boolean {
  if (left.path !== undefined && right.path !== undefined) {
    return path.resolve(left.path) === path.resolve(right.path);
  }
  return left.path === undefined && right.path === undefined && left.name === right.name;
}

function targetForCanonicalSource(
  config: AkmConfig,
  source: SearchSource,
  options: WriteTargetOptions,
): ResolvedWriteTarget {
  const target = source.registryId
    ? resolveWriteTarget(config, source.bundleId, options)
    : resolveWorkingStashTarget(config, options);
  if (source.unresolved || !sameTarget(target.source, { name: source.bundleId, path: source.path })) {
    throw new UsageError(`Bundle "${source.bundleId}" no longer resolves to its indexed source root.`);
  }
  return target;
}

/** Resolve the canonical bundle id currently assigned to a write target. */
export function canonicalBundleIdForTarget(config: AkmConfig, target: ResolvedWriteTarget): string {
  return (
    resolveSourceEntries(undefined, config).find(
      (source) => !source.unresolved && sameTarget(target.source, { name: source.bundleId, path: source.path }),
    )?.bundleId ?? target.source.name
  );
}

/** Resolve a canonical bundle qualifier to its writable target without preparing a Git boundary. */
export function resolveBundleWriteTarget(
  config: AkmConfig,
  bundleId: string,
  options: WriteTargetOptions = {},
): ResolvedWriteTarget {
  const canonical = resolveSourceEntries(undefined, config).find((source) => source.bundleId === bundleId);
  if (!canonical) {
    throw new UsageError(`Bundle "${bundleId}" is not configured.`, "INVALID_FLAG_VALUE");
  }
  const target = targetForCanonicalSource(config, canonical, options);
  return { ...target, source: { ...target.source, name: canonical.bundleId } };
}

function resolveExplicitMutationTarget(
  config: AkmConfig,
  explicitTarget: string,
  options: WriteTargetOptions,
): ResolvedWriteTarget {
  try {
    return resolveWriteTarget(config, explicitTarget, options);
  } catch (error) {
    try {
      return resolveBundleWriteTarget(config, explicitTarget, options);
    } catch {
      throw error;
    }
  }
}

/**
 * Reconcile a qualified mutation ref with the explicit target (`--bundle`, or
 * the `options.flag` the caller's command spells), then resolve the write
 * destination.
 */
export function resolveMutationTarget(
  config: AkmConfig,
  ref: AssetRef,
  explicitTarget?: string,
  options: WriteTargetOptions = {},
): ResolvedMutationTarget {
  const flag = options.flag ?? "--bundle";
  const writeOptions: WriteTargetOptions = { requireWritable: options.requireWritable, flag };
  const qualifiedTarget = ref.origin ? resolveBundleWriteTarget(config, ref.origin, writeOptions) : undefined;
  const explicitResolved = explicitTarget
    ? resolveExplicitMutationTarget(config, explicitTarget, writeOptions)
    : undefined;
  if (qualifiedTarget && explicitResolved && !sameTarget(qualifiedTarget.source, explicitResolved.source)) {
    throw new UsageError(
      `Qualified ref bundle "${ref.origin}" conflicts with ${flag} "${explicitTarget}".`,
      "INVALID_FLAG_VALUE",
      `Drop ${flag} or select the same bundle.`,
    );
  }

  let target = qualifiedTarget ?? explicitResolved ?? resolveWriteTarget(config, undefined, writeOptions);
  const bundleId = ref.origin ?? canonicalBundleIdForTarget(config, target);
  // The write is an asset of the ref's type: the bundle's adapter must write that type.
  target = prepareWriteTargetForMutation(
    { ...target, source: { ...target.source, name: bundleId } },
    { assetType: ref.type },
  );
  const stableRef = { ...ref, origin: bundleId };
  const defaultBundle = defaultBundleForTarget(config);
  return {
    target,
    ref: stableRef,
    displayRef: displayRef(
      { conceptId: conceptIdFromTypeName(stableRef.type, stableRef.name), bundleId: stableRef.origin },
      defaultBundle,
    ),
  };
}

export function defaultBundleForTarget(config: AkmConfig): string | undefined {
  return config.defaultBundle;
}
