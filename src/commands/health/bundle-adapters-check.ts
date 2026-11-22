// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `bundle-adapters` for `akm doctor`: every adapter a configured bundle names is one akm has. The config schema
 * accepts any adapter id, so this is where a typo (`agent_skills`) is reported before the bundle is next read.
 */

import { requireAdapter } from "../../core/adapter/registry";
import { toErrorMessage } from "../../core/common";
import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { resolveConfiguredSources } from "../../core/config/config-sources";
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
      if (source.adapterId !== undefined) requireAdapter(source.name, source.adapterId);
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
