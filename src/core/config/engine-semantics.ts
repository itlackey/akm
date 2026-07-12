// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const ENGINE_NAME_PATTERN_SOURCE = "^(?!akm-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";

export const BUILTIN_IMPROVE_STRATEGY_NAMES = [
  "default",
  "quick",
  "thorough",
  "memory-focus",
  "graph-refresh",
  "frequent",
  "consolidate",
  "catchup",
  "synthesize",
  "reflect-distill",
  "proactive-maintenance",
  "recombine-only",
] as const;

/** Engine capability required by each configured improve process. `null` means engine-free. */
export const IMPROVE_PROCESS_ENGINE_CAPABILITIES = {
  reflect: "llm",
  distill: "llm",
  consolidate: "llm",
  memoryInference: "llm",
  graphExtraction: "llm",
  extract: "llm",
  validation: "llm",
  triage: null,
  proactiveMaintenance: null,
  recombine: "llm",
  procedural: "llm",
} as const;
