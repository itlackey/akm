// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseAssetRef } from "../../core/asset/asset-ref";
import type { ImproveProfileConfig } from "../../core/config/config";

export type { ImproveProfileConfig } from "../../core/config/config";

// Built-in default allowed types per process
export const DEFAULT_ALLOWED_TYPES: Record<"reflect" | "distill" | "consolidate", string[]> = {
  reflect: ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
  distill: ["memory"],
  consolidate: ["memory"],
};

/**
 * Default enabled-state for known improve processes when neither the user
 * profile nor the built-in default profile specifies an override.
 *
 * These mirror the legacy `LlmFeatureFlags` defaults so callers that bypass
 * strategy resolution get the same answer.
 */
const IMPROVE_PROCESS_DEFAULTS: Record<string, boolean> = {
  reflect: true,
  distill: true,
  consolidate: true,
  memoryInference: true,
  graphExtraction: true,
  validation: true,
  // session-extraction reads native session files from claude-code / opencode
  // and queues durable-insight proposals. Default on — opt out via
  // improve.strategies.<name>.processes.extract.enabled: false.
  extract: true,
  // proposal-queue triage drains the standing backlog. Opt-in (default off),
  // requires an explicit `enabled: true`.
  triage: false,
  // Layer 2 proactive-maintenance selector. Opt-in (default off) — surfaces
  // stale high-value assets on a schedule. Enable per-profile with an explicit
  // `processes.proactiveMaintenance.enabled: true`.
  proactiveMaintenance: false,
  // #609 recombine / synthesize pass — whole-corpus cross-episodic
  // generalization. Opt-in (default off); enable per-profile with an explicit
  // `processes.recombine.enabled: true`.
  recombine: false,
  // #615 procedural-compilation pass — detects recurring successful ordered
  // action sequences and compiles them into workflow proposals. Opt-in (default
  // off); enable per-profile with an explicit `processes.procedural.enabled: true`.
  procedural: false,
};

/**
 * Compute the effective enabled-state for a named improve process.
 *
 * Resolution order: explicit `profile.processes.<name>.enabled` (boolean) →
 * the built-in {@link IMPROVE_PROCESS_DEFAULTS} fallback → `false`.
 */
export function resolveProcessEnabled(
  processName: keyof NonNullable<ImproveProfileConfig["processes"]> | string,
  profile: ImproveProfileConfig,
): boolean {
  const processes = profile.processes as Record<string, { enabled?: boolean } | undefined> | undefined;
  const entry = processes?.[processName as string];
  if (entry && typeof entry.enabled === "boolean") return entry.enabled;
  return IMPROVE_PROCESS_DEFAULTS[processName as string] ?? false;
}

export function shouldSkipRef(
  ref: string,
  processName: "reflect" | "distill" | "consolidate",
  profile: ImproveProfileConfig,
): { skip: boolean; reason: string } {
  const cfg = profile.processes?.[processName];
  // Check if the process itself is disabled
  if (cfg?.enabled === false) return { skip: true, reason: "process-disabled" };

  const parsed = parseAssetRef(ref);
  const allowed = cfg?.allowedTypes ?? DEFAULT_ALLOWED_TYPES[processName];

  if (!allowed.includes(parsed.type)) return { skip: true, reason: "type-filter" };

  // Hardcoded: wiki raw directories are never processed by any improve process.
  if (parsed.type === "wiki" && parsed.name.split("/")[1] === "raw") {
    return { skip: true, reason: "raw-wiki" };
  }

  return { skip: false, reason: "" };
}

/**
 * Planner-level pre-filter: return `true` when every per-ref improve pass that
 * participates in the in-loop dispatch (today: `reflect` and `distill`) would
 * refuse this ref under the active profile. Such refs cannot produce any work
 * downstream — they only generate synthetic skip actions and inflate
 * `plannedRefs` by a constant factor per cron run.
 *
 * Companion to `shouldSkipRef`. The 2026-05-27 planner/profile/metrics deep
 * analysis (`/tmp/akm-health-investigations/planner-profile-metrics-deep-analysis.md`)
 * documents the 99.07% synthetic-skip emission rate this pre-filter eliminates.
 *
 * NOTE: passes that operate on their own candidate set (consolidate,
 * memoryInference, graphExtraction) are deliberately excluded — they do not
 * iterate `plannedRefs` per-ref, so a ref being profile-incompatible at the
 * reflect+distill layer says nothing about their work.
 */
export function isStrategyFilteredForAllPasses(ref: string, profile: ImproveProfileConfig): boolean {
  const reflectSkip = shouldSkipRef(ref, "reflect", profile);
  const distillSkip = shouldSkipRef(ref, "distill", profile);
  return reflectSkip.skip && distillSkip.skip;
}
