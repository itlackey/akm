// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export const ENGINE_NAME_PATTERN_SOURCE = "^(?!akm-)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";

export const BUILTIN_IMPROVE_STRATEGY_NAMES = [
  "default",
  "quick",
  "thorough",
  "consolidate",
  "catchup",
  "reflect-distill",
] as const;

/**
 * The improve processes that use an engine. Triage's engine is its judgment's;
 * each of the others makes the process's own model calls.
 */
export const IMPROVE_ENGINE_PROCESSES = [
  "reflect",
  "distill",
  "consolidate",
  "memoryInference",
  "extract",
  "validation",
  "triage",
] as const;

/** Every improve process, in plan order: the engine processes and `proactiveMaintenance`, which uses none. */
export const IMPROVE_PROCESS_NAMES = [...IMPROVE_ENGINE_PROCESSES, "proactiveMaintenance"] as const;
