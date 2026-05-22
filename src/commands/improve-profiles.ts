import { parseAssetRef } from "../core/asset-ref";
import type { AkmConfig, ImproveProfileConfig } from "../core/config";

export type { ImproveProfileConfig } from "../core/config";

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
    description: "All sub-processes enabled.",
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

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (typeof base !== "object" || base === null) return (override as T) ?? base;
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key];
    if (ov !== undefined) {
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
  const effectiveName =
    name ?? (typeof config.defaults?.improve === "string" ? config.defaults.improve : undefined) ?? "default";
  const builtin = BUILTIN_PROFILES[effectiveName] ?? BUILTIN_PROFILES.default;
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
