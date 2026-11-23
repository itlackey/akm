// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `bundle-shared-path` for `akm doctor`: a bundle whose content root is inside another bundle's. They share files, so
 * both list them. A config write refuses a new overlap; an existing one keeps working and is reported here. Equal
 * roots never reach this check: config load refuses them.
 */

import type { AkmConfig } from "../../core/config/config";
import { loadConfig } from "../../core/config/config";
import { bundleOverlaps } from "../../core/config/config-sources";
import type { HealthCheckResult } from "./types";

/** Silent (undefined) when no pair is nested, and when the config cannot be read: `bundle-adapters` says that. */
export function collectBundleSharedPathCheck(readConfig: () => AkmConfig = loadConfig): HealthCheckResult | undefined {
  const base = { name: "bundle-shared-path", kind: "deterministic", confidence: "high" } as const;
  let nested: ReturnType<typeof bundleOverlaps>;
  try {
    nested = bundleOverlaps(readConfig()).filter((overlap) => overlap.kind === "nested");
  } catch {
    return undefined;
  }
  if (nested.length === 0) return undefined;
  const pairs = nested.map((overlap) => {
    const outer = overlap.bundles.find((id) => id !== overlap.inner) as string;
    return { inner: overlap.inner as string, outer };
  });
  return {
    ...base,
    status: "warn",
    message:
      `${pairs.map(({ inner, outer }) => `bundle "${inner}" is inside bundle "${outer}"`).join("; ")}: they share files, ` +
      "so both list them. Move one directory out of the other, or remove one bundle (a wiki folder inside a bundle " +
      "should be its own bundle, moved out).",
    evidence: { pairs },
  };
}
