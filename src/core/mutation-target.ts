// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type AssetRef, displayRef } from "./asset/resolve-ref";
import type { AkmConfig } from "./config/config";
import { UsageError } from "./errors";
import { type ResolvedWriteTarget, resolveWriteTarget } from "./write-source";

export interface ResolvedMutationTarget {
  target: ResolvedWriteTarget;
  /** Ref with the resolved source's stable identity, suitable for durable use. */
  ref: AssetRef;
  /** User-facing spelling, short only for the configured default bundle. */
  displayRef: string;
}

/** Reconcile a qualified mutation ref with `--target`, then resolve the write destination. */
export function resolveMutationTarget(
  config: AkmConfig,
  ref: AssetRef,
  explicitTarget?: string,
  options: { requireWritable?: boolean } = {},
): ResolvedMutationTarget {
  if (ref.origin && explicitTarget && ref.origin !== explicitTarget) {
    throw new UsageError(
      `Qualified ref bundle "${ref.origin}" conflicts with --target "${explicitTarget}".`,
      "INVALID_FLAG_VALUE",
      `Drop --target or use --target ${ref.origin}.`,
    );
  }

  const target = resolveWriteTarget(config, ref.origin ?? explicitTarget, options);
  const stableRef = { ...ref, origin: target.source.name };
  return {
    target,
    ref: stableRef,
    displayRef: displayRef(
      { type: stableRef.type, name: stableRef.name, bundleId: stableRef.origin },
      config.defaultBundle,
    ),
  };
}
