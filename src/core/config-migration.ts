/**
 * Config shape migration logic for AKM v0.8.0.
 *
 * This module is intentionally kept free of imports from `config.ts` to avoid
 * circular dependencies: `config.ts` imports `migrateConfigShape` from here,
 * and `config-migrate.ts` (the CLI command) also imports from here.
 */

/**
 * Current config schema version sentinel.
 * Configs at this version are considered fully migrated and will not be rewritten.
 */
export const CURRENT_CONFIG_VERSION = "0.8.0";

/**
 * Compare two `configVersion` values and return -1/0/1 (a<b / a==b / a>b).
 *
 * Both the legacy numeric scheme (`1`, `2`, …) and the semver-string scheme
 * (`"0.8.0"`, `"0.9.1"`) are accepted. Mixed comparisons promote the numeric
 * value to a semver-like string of the form `0.N.0` (so legacy `2` ≈ `"0.2.0"`
 * is compared element-wise against the string form). Returns `undefined`
 * when either value cannot be parsed at all.
 *
 * This helper is intentionally tolerant: any unknown/garbage version value
 * is treated as "older or equal to whatever we know" rather than throwing,
 * so the read-path never breaks on a malformed `configVersion` field — that
 * is the job of the normal config parser.
 */
export function compareConfigVersion(
  a: string | number | undefined,
  b: string | number | undefined,
): -1 | 0 | 1 | undefined {
  const partsA = normalizeVersion(a);
  const partsB = normalizeVersion(b);
  if (!partsA || !partsB) return undefined;
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const ai = partsA[i] ?? 0;
    const bi = partsB[i] ?? 0;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

function normalizeVersion(v: string | number | undefined): number[] | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Legacy numeric scheme: treat `2` as `0.2.0` so it compares element-wise
    // against the string form, ordering it correctly below any `0.8.0`-style value.
    return [0, Math.trunc(v), 0];
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    // Strip a leading `v` if present, drop any pre-release/build suffix.
    const cleaned = trimmed.replace(/^v/i, "").split(/[-+]/, 1)[0];
    const segments = cleaned.split(".").map((part) => Number.parseInt(part, 10));
    if (segments.length === 0 || segments.some((n) => !Number.isFinite(n))) return undefined;
    return segments;
  }
  return undefined;
}

/**
 * Determine whether a raw config object needs migration to the 0.8.0 shape and
 * apply any necessary field renames or promotions.
 *
 * A config is considered already migrated when:
 *   - `configVersion === "0.8.0"` (canonical string sentinel for this release), OR
 *   - `configVersion` is a number ≥ 2 (legacy numeric versioning from pre-0.8.0 worktrees).
 *
 * Returns `{ changed: true, result }` when any field was renamed/promoted,
 * or `{ changed: false, result: raw }` when the config is already up to date.
 * The function is pure (no I/O) so callers control whether and how to persist
 * the migrated result.
 */
export function migrateConfigShape(raw: Record<string, unknown>): {
  changed: boolean;
  result: Record<string, unknown>;
} {
  // Already migrated — string sentinel "0.8.0"
  if (raw.configVersion === CURRENT_CONFIG_VERSION) {
    return { changed: false, result: raw };
  }
  // Legacy numeric versioning (number >= 2 means already at v2+ shape)
  if (typeof raw.configVersion === "number" && raw.configVersion >= 2) {
    return { changed: false, result: raw };
  }

  const result: Record<string, unknown> = { ...raw };
  let changed = false;

  // ── Migrate llm.features.* → top-level features tree ─────────────────────
  // In pre-0.8.0 configs, feature flags lived under config.llm.features.
  // In 0.8.0 they move to config.features.{index,improve,search}.
  if (typeof raw.llm === "object" && raw.llm !== null && !Array.isArray(raw.llm)) {
    const llm = raw.llm as Record<string, unknown>;
    if (typeof llm.features === "object" && llm.features !== null && !Array.isArray(llm.features)) {
      const llmFeatures = llm.features as Record<string, boolean>;

      const features = (
        typeof result.features === "object" && result.features !== null && !Array.isArray(result.features)
          ? { ...(result.features as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const featuresIndex = (
        typeof features.index === "object" && features.index !== null && !Array.isArray(features.index)
          ? { ...(features.index as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const featuresImprove = (
        typeof features.improve === "object" && features.improve !== null && !Array.isArray(features.improve)
          ? { ...(features.improve as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const featuresSearch = (
        typeof features.search === "object" && features.search !== null && !Array.isArray(features.search)
          ? { ...(features.search as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const indexKeys = ["memory_inference", "graph_extraction", "metadata_enhance"] as const;
      for (const key of indexKeys) {
        if (key in llmFeatures) {
          featuresIndex[key] = llmFeatures[key];
          changed = true;
        }
      }

      const improveKeys = ["memory_consolidation", "feedback_distillation"] as const;
      for (const key of improveKeys) {
        if (key in llmFeatures) {
          featuresImprove[key] = llmFeatures[key];
          changed = true;
        }
      }

      if ("curate_rerank" in llmFeatures) {
        featuresSearch.curate_rerank = llmFeatures.curate_rerank;
        changed = true;
      }

      // Strip the old features block from llm
      const { features: _features, ...llmRest } = llm;
      result.llm = llmRest;
      changed = true;

      // Reassemble features tree
      const newFeatures: Record<string, unknown> = { ...features };
      if (Object.keys(featuresIndex).length > 0) newFeatures.index = featuresIndex;
      if (Object.keys(featuresImprove).length > 0) newFeatures.improve = featuresImprove;
      if (Object.keys(featuresSearch).length > 0) newFeatures.search = featuresSearch;
      if (Object.keys(newFeatures).length > 0) {
        result.features = newFeatures;
      }
    }
  }

  // ── Migrate config.improve.* → config.features.improve + config.defaults ──
  if (typeof raw.improve === "object" && raw.improve !== null && !Array.isArray(raw.improve)) {
    const improve = raw.improve as Record<string, unknown>;

    if (typeof improve.reflectCooldownByType === "object" && improve.reflectCooldownByType !== null) {
      // Migrate improve.reflectCooldownByType → profiles.improve.default.processes.reflect.cooldownByType
      const profiles = (
        typeof result.profiles === "object" && result.profiles !== null && !Array.isArray(result.profiles)
          ? { ...(result.profiles as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const profilesImprove = (
        typeof profiles.improve === "object" && profiles.improve !== null && !Array.isArray(profiles.improve)
          ? { ...(profiles.improve as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const defaultProfile = (
        typeof profilesImprove.default === "object" && profilesImprove.default !== null
          ? { ...(profilesImprove.default as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const processes = (
        typeof defaultProfile.processes === "object" && defaultProfile.processes !== null
          ? { ...(defaultProfile.processes as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const reflect = (
        typeof processes.reflect === "object" && processes.reflect !== null
          ? { ...(processes.reflect as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      reflect.cooldownByType = improve.reflectCooldownByType;
      processes.reflect = reflect;
      defaultProfile.processes = processes;
      profilesImprove.default = defaultProfile;
      profiles.improve = profilesImprove;
      result.profiles = profiles;
      changed = true;
    }

    if (typeof improve.limit === "number") {
      // Migrate improve.limit → profiles.improve.default.limit
      const profiles = (
        typeof result.profiles === "object" && result.profiles !== null && !Array.isArray(result.profiles)
          ? { ...(result.profiles as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const profilesImprove = (
        typeof profiles.improve === "object" && profiles.improve !== null && !Array.isArray(profiles.improve)
          ? { ...(profiles.improve as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const defaultProfile = (
        typeof profilesImprove.default === "object" && profilesImprove.default !== null
          ? { ...(profilesImprove.default as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      defaultProfile.limit = improve.limit;
      profilesImprove.default = defaultProfile;
      profiles.improve = profilesImprove;
      result.profiles = profiles;
      changed = true;
    }

    // Strip migrated keys; preserve any remaining improve fields
    const { reflectCooldownByType: _rct, limit: _limit, schedule: _schedule, ...improveRest } = improve;
    if (Object.keys(improveRest).length > 0) {
      result.improve = improveRest;
    } else {
      delete result.improve;
    }
  }

  // ── Strip legacy agent.processes.task and agent.profiles[*].sdkMode ────────
  if (typeof result.agent === "object" && result.agent !== null && !Array.isArray(result.agent)) {
    const agent = { ...(result.agent as Record<string, unknown>) };

    if (typeof agent.processes === "object" && agent.processes !== null && !Array.isArray(agent.processes)) {
      const { task: _task, ...processesRest } = agent.processes as Record<string, unknown>;
      if (Object.keys(processesRest).length > 0) {
        agent.processes = processesRest;
      } else {
        delete agent.processes;
      }
      changed = true;
    }

    if (typeof agent.profiles === "object" && agent.profiles !== null && !Array.isArray(agent.profiles)) {
      const profiles = agent.profiles as Record<string, unknown>;
      const strippedProfiles: Record<string, unknown> = {};
      for (const [name, profile] of Object.entries(profiles)) {
        if (typeof profile === "object" && profile !== null && !Array.isArray(profile)) {
          const { sdkMode: _sdkMode, ...rest } = profile as Record<string, unknown>;
          strippedProfiles[name] = rest;
        } else {
          strippedProfiles[name] = profile;
        }
      }
      agent.profiles = strippedProfiles;
      changed = true;
    }

    result.agent = agent;
  }

  if (changed) {
    result.configVersion = CURRENT_CONFIG_VERSION;
  }

  return { changed, result };
}
