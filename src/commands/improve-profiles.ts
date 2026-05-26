// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseAssetRef } from "../core/asset-ref";
import type { AkmConfig, ImproveProfileConfig } from "../core/config";
import { warn } from "../core/warn";

export type { ImproveProfileConfig } from "../core/config";

/** Profile name used as the final fallback when nothing else resolves. */
const FALLBACK_PROFILE_NAME = "default";

// Built-in default allowed types per process
export const DEFAULT_ALLOWED_TYPES: Record<"reflect" | "distill" | "consolidate", string[]> = {
  reflect: ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"],
  distill: ["memory"],
  consolidate: ["memory"],
};

const BUILTIN_PROFILES: Record<string, ImproveProfileConfig> = {
  default: {
    description: "Standard improve pass — all sub-processes, markdown asset types.",
    processes: {
      reflect: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.reflect },
      distill: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.distill },
      consolidate: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.consolidate },
      memoryInference: { enabled: true },
      graphExtraction: { enabled: true },
      // validation: deliberately undefined — third-tier classifier is opt-in.
    },
  },
  quick: {
    description: "Reflect-only pass — no distill, consolidate, memoryInference, or graphExtraction.",
    processes: {
      reflect: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.reflect },
      distill: { enabled: false },
      consolidate: { enabled: false },
      memoryInference: { enabled: false },
      graphExtraction: { enabled: false },
    },
  },
  thorough: {
    // Reserved for future divergence; for now behaviorally identical to
    // `default`. Documented here so callers picking `--profile thorough` do
    // not expect a different code path until we wire stricter limits in.
    description: "All sub-processes enabled (currently identical to default; reserved for future divergence).",
    processes: {
      reflect: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.reflect },
      distill: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.distill },
      consolidate: { enabled: true, allowedTypes: DEFAULT_ALLOWED_TYPES.consolidate },
      memoryInference: { enabled: true },
      graphExtraction: { enabled: true },
    },
  },
  "memory-focus": {
    description: "Memory and lesson improvement only — no distill or consolidate.",
    processes: {
      reflect: { enabled: true, allowedTypes: ["memory", "lesson"] },
      distill: { enabled: false },
      consolidate: { enabled: false },
      memoryInference: { enabled: true },
      graphExtraction: { enabled: false },
    },
  },
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
