// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `bundle-adapters` for `akm doctor`: every adapter a configured bundle names is one akm has, and the bundle is
 * addressed the way that adapter needs (a `location` for a store adapter, none for a directory adapter). The config
 * schema accepts any adapter id, so this is where a typo (`agent_skills`) is reported before the bundle is next read.
 */

import { type AdapterSkip, adapterSkipMessage, adapterSkipOf } from "../../core/adapter/adapter-skips";
import { assertKnownAdapter } from "../../core/assets/gate";
import { deriveBundleIds } from "../../core/bundle-id";
import { toErrorMessage } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { resolveConfiguredSources } from "../../core/config/config-sources";
import { resolveSourceEntries } from "../../indexer/search/search-source";
import type { HealthCheckResult } from "./types";

export function collectBundleAdaptersCheck(readConfig: () => AkmConfig = loadConfig): HealthCheckResult {
  const base = { name: "bundle-adapters", kind: "deterministic", confidence: "high" } as const;
  let config: AkmConfig;
  try {
    config = readConfig();
  } catch (error) {
    return {
      ...base,
      status: "unknown",
      reason: "blocked",
      message: `The config could not be read, so the bundles' adapters were not checked: ${toErrorMessage(error)}`,
    };
  }
  try {
    for (const source of resolveConfiguredSources(config)) {
      if (source.adapterId !== undefined)
        assertKnownAdapter(source.name, source.adapterId, { location: source.source.type === "location" });
    }
  } catch (error) {
    return {
      ...base,
      status: "fail",
      message: `${toErrorMessage(error)} Fix it with \`akm config set bundles.<name>.adapter <id>\`.`,
    };
  }
  return { ...base, status: "pass", message: "Every configured bundle names an adapter akm has." };
}

/**
 * `adapter-skipped-content`: a bundle whose configured adapter holds none of the files in a folder where the `akm`
 * adapter would hold some (an explicit `agent-skills` next to ordinary akm content), so the index leaves them out.
 * Silent (undefined) when no bundle skips any, and when the bundles cannot be read.
 */
export function collectAdapterSkipCheck(readConfig: () => AkmConfig = loadConfig): HealthCheckResult | undefined {
  const skips: Array<{ bundle: string } & AdapterSkip> = [];
  try {
    const sources = resolveSourceEntries(undefined, readConfig());
    const ids = deriveBundleIds(sources);
    for (const [index, source] of sources.entries()) {
      if (source.unresolved) continue;
      const name = ids[index] as string;
      const skip = adapterSkipOf({
        name,
        path: source.path,
        // asset-io: config the bundle's configured location, copied
        ...(source.location !== undefined ? { location: source.location } : {}),
        ...(source.adapterId !== undefined ? { adapterId: source.adapterId } : {}),
      });
      if (skip) skips.push({ bundle: name, ...skip });
    }
  } catch {
    return undefined;
  }
  if (skips.length === 0) return undefined;
  return {
    name: "adapter-skipped-content",
    kind: "deterministic",
    confidence: "high",
    // Information, not a finding: `akm doctor` exited 0 for such a bundle before the warning moved here (§0.2 N18).
    status: "pass",
    message: skips.map(({ bundle, ...skip }) => adapterSkipMessage(bundle, skip)).join("; "),
    evidence: { skips },
  };
}
