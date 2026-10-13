// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Pluggable registry of LLM config importers for supported agent harnesses.
 *
 * Each importer detects whether a harness is installed (filesystem only,
 * no network) and, if so, reads its config to extract LLM connection details.
 * API key VALUES are never stored — only the env var names that hold them.
 *
 * To add a new harness importer: declare `configImporter` on the harness
 * descriptor (`integrations/harnesses/<id>/index.ts`).
 *
 * NOTE: The `detect()` method in each importer overlaps intentionally with
 * `detectAgentPlatforms()` in `detect.ts`. That function scans for harness
 * presence to display installed platforms to the user; these importers go
 * further by reading and parsing the harness config. They serve different
 * purposes and should not be deduplicated.
 */

import { HARNESS_REGISTRY } from "../integrations/harnesses";
import type { HarnessConfigImporter, HarnessLLMConfig } from "../integrations/harnesses/shared";

/** Importers declared by the registered harnesses, in registry order. */
export const HARNESS_CONFIG_IMPORTERS: HarnessConfigImporter[] = HARNESS_REGISTRY.flatMap((h) =>
  h.configImporter ? [h.configImporter] : [],
);

/**
 * Run all importers whose `detect()` returns `true` and collect their configs.
 *
 * Pure function — filesystem reads only, no network, no side effects.
 * Individual importer failures are swallowed so one broken harness never
 * blocks the setup wizard.
 *
 * @returns List of detected harness configs (may be empty).
 */
export function detectHarnessConfigs(): HarnessLLMConfig[] {
  const results: HarnessLLMConfig[] = [];
  for (const importer of HARNESS_CONFIG_IMPORTERS) {
    try {
      if (!importer.detect()) continue;
      const config = importer.importConfig();
      if (config) results.push(config);
    } catch {
      // Never let one importer crash the whole detection
    }
  }
  return results;
}
