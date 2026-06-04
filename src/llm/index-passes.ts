// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Per-pass LLM config resolution for `akm index` and the improve pipeline.
 *
 * Resolution order:
 *   1. Per-process profile from the active improve profile:
 *      `profiles.improve.default.processes.<configKey>.profile` →
 *      `profiles.llm[<profile>]`. Lets the user pin a specific model
 *      (e.g. ministral-3b for the batch graph-extraction pass) instead of
 *      forcing the default LLM on every pass. Pre-existing config silently
 *      fell back to the default LLM, which on 2026-05-25 caused gemma-4-e4b
 *      to be used for graph extraction even though the profile said
 *      ministral-3b.
 *   2. `defaults.llm` (or implicit `profiles.llm.default`) — the baseline
 *      default when no per-process override is set.
 *
 * Returns `undefined` if any of:
 *   - No usable LLM profile can be resolved (no default + no per-process).
 *   - The pass is explicitly opted out via `index.<passName>.llm === false`.
 *   - The per-process config sets `enabled === false`.
 *
 * Pass-name mapping (CLI conventions ↔ config keys):
 *   - "memory"     → processes.memoryInference
 *   - "graph"      → processes.graphExtraction
 *   - "enrichment" → no improve-profile counterpart; falls through to default
 *
 * Passes plug in by calling {@link resolveIndexPassLLM} with their pass
 * name. They do not read connection fields directly.
 */

import type { AkmConfig, IndexPassConfig, LlmConnectionConfig } from "../core/config";
import { getDefaultLlmConfig, getIndexPassConfig } from "../core/config";

/**
 * Map a pass name (as used by callers — "memory", "graph", etc.) to the
 * matching key under `profiles.improve.default.processes`. Pass names with
 * no improve-profile counterpart return undefined and resolve via the
 * default LLM only.
 */
function improveProcessKeyForPass(passName: string): "memoryInference" | "graphExtraction" | undefined {
  switch (passName) {
    case "memory":
      return "memoryInference";
    case "graph":
      return "graphExtraction";
    default:
      return undefined;
  }
}

export function resolveIndexPassLLM(passName: string, config: AkmConfig): LlmConnectionConfig | undefined {
  // Gate 1 — explicit opt-out via the index-config block stays authoritative.
  const passConfig: IndexPassConfig | undefined = getIndexPassConfig(config.index, passName);
  if (passConfig?.llm === false) return undefined;

  // Gate 2 — per-process profile from the improve profile, when present.
  // This is the path that lets
  //   profiles.improve.default.processes.graphExtraction.profile = "ministral-3b"
  // actually take effect on the graph pass instead of being silently
  // ignored.
  const processKey = improveProcessKeyForPass(passName);
  if (processKey) {
    const processConfig = config.profiles?.improve?.default?.processes?.[processKey];
    // Honor enabled === false here too — an explicit disable wins.
    if (processConfig?.enabled === false) return undefined;
    const profileName = processConfig?.profile;
    if (profileName) {
      const profile = config.profiles?.llm?.[profileName];
      if (profile) return profile;
      // A named-but-missing profile is a configuration error in spirit, but
      // we fall through to default rather than throwing — callers gracefully
      // treat `undefined` as "pass disabled" and emitting a hard throw here
      // would take the whole improve run down on a typo.
    }
  }

  // Gate 3 — fall back to the default LLM profile.
  return getDefaultLlmConfig(config);
}
