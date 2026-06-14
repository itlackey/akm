// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import profileCatchup from "../../assets/profiles/catchup.json" with { type: "json" };
import profileConsolidate from "../../assets/profiles/consolidate.json" with { type: "json" };
import profileDefault from "../../assets/profiles/default.json" with { type: "json" };
import profileFrequent from "../../assets/profiles/frequent.json" with { type: "json" };
import profileGraphRefresh from "../../assets/profiles/graph-refresh.json" with { type: "json" };
import profileMemoryFocus from "../../assets/profiles/memory-focus.json" with { type: "json" };
import profileQuick from "../../assets/profiles/quick.json" with { type: "json" };
import profileThorough from "../../assets/profiles/thorough.json" with { type: "json" };
import { parseAssetRef } from "../../core/asset/asset-ref";
import type { AkmConfig, ImproveProfileConfig } from "../../core/config/config";
import { warn } from "../../core/warn";

export type { ImproveProfileConfig } from "../../core/config/config";

/** Profile name used as the final fallback when nothing else resolves. */
const FALLBACK_PROFILE_NAME = "default";

// Built-in default allowed types per process
export const DEFAULT_ALLOWED_TYPES: Record<"reflect" | "distill" | "consolidate", string[]> = {
  reflect: ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
  distill: ["memory"],
  consolidate: ["memory"],
};

// Built-in profiles are loaded from embedded JSON files in src/assets/profiles/.
// To add a new profile: create a new .json file there, import it above, and add
// it to this map. No code change needed beyond those two steps.
const BUILTIN_PROFILES: Record<string, ImproveProfileConfig> = {
  default: profileDefault as ImproveProfileConfig,
  quick: profileQuick as ImproveProfileConfig,
  thorough: profileThorough as ImproveProfileConfig,
  "memory-focus": profileMemoryFocus as ImproveProfileConfig,
  "graph-refresh": profileGraphRefresh as ImproveProfileConfig,
  frequent: profileFrequent as ImproveProfileConfig,
  consolidate: profileConsolidate as ImproveProfileConfig,
  catchup: profileCatchup as ImproveProfileConfig,
};

/**
 * Default enabled-state for known improve processes when neither the user
 * profile nor the built-in default profile specifies an override.
 *
 * These mirror the legacy `LlmFeatureFlags` defaults so callers that bypass
 * the profile system (rare — most run through `resolveImproveProfile`) get
 * the same answer.
 */
const IMPROVE_PROCESS_DEFAULTS: Record<string, boolean> = {
  reflect: true,
  distill: true,
  consolidate: true,
  memoryInference: true,
  graphExtraction: true,
  validation: false,
  // session-extraction reads native session files from claude-code / opencode
  // and queues durable-insight proposals. Default on — opt out via
  // profiles.improve.default.processes.extract.enabled: false.
  extract: true,
  // proposal-queue triage drains the standing backlog. Opt-in (default off),
  // like `validation` — needs an explicit `enabled: true`.
  triage: false,
  // Layer 2 proactive-maintenance selector. Opt-in (default off) — surfaces
  // stale high-value assets on a schedule. Enable per-profile with an explicit
  // `processes.proactiveMaintenance.enabled: true`.
  proactiveMaintenance: false,
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

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== "object" || base === null) return (override as T) ?? base;
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key];
    // Treat `null` the same as `undefined` so user overrides never wipe a
    // built-in field with `null`. The on-disk parser already strips nulls,
    // but the programmatic API exposes this path and callers occasionally
    // pass JSON-shaped objects with explicit nulls.
    if (ov !== undefined && ov !== null) {
      const bv = base[key];
      if (typeof bv === "object" && bv !== null && typeof ov === "object" && ov !== null && !Array.isArray(bv)) {
        (result as Record<string, unknown>)[key as string] = deepMerge(bv, ov as Partial<typeof bv>);
      } else {
        (result as Record<string, unknown>)[key as string] = ov;
      }
    }
  }
  return result;
}

export function resolveImproveProfile(name: string | undefined, config: AkmConfig): ImproveProfileConfig {
  const requestedName =
    name ??
    (typeof config.defaults?.improve === "string" ? config.defaults.improve : undefined) ??
    FALLBACK_PROFILE_NAME;

  const hasBuiltin = requestedName in BUILTIN_PROFILES;
  const hasUserDefined = !!config.profiles?.improve?.[requestedName];

  let effectiveName = requestedName;
  if (!hasBuiltin && !hasUserDefined && requestedName !== FALLBACK_PROFILE_NAME) {
    warn(
      `[akm] Improve profile "${requestedName}" not found in built-ins or config. ` +
        `Falling back to "${FALLBACK_PROFILE_NAME}".`,
    );
    effectiveName = FALLBACK_PROFILE_NAME;
  }

  const builtin = BUILTIN_PROFILES[effectiveName] ?? BUILTIN_PROFILES[FALLBACK_PROFILE_NAME];
  const userOverride = config.profiles?.improve?.[effectiveName] ?? {};
  return deepMerge(builtin, userOverride) as ImproveProfileConfig;
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
export function isProfileFilteredForAllPasses(ref: string, profile: ImproveProfileConfig): boolean {
  const reflectSkip = shouldSkipRef(ref, "reflect", profile);
  const distillSkip = shouldSkipRef(ref, "distill", profile);
  return reflectSkip.skip && distillSkip.skip;
}
