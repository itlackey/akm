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
      const features = (
        typeof result.features === "object" && result.features !== null && !Array.isArray(result.features)
          ? { ...(result.features as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const featuresImprove = (
        typeof features.improve === "object" && features.improve !== null && !Array.isArray(features.improve)
          ? { ...(features.improve as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;

      const existingReflect =
        typeof featuresImprove.reflect === "object" &&
        featuresImprove.reflect !== null &&
        !Array.isArray(featuresImprove.reflect)
          ? { ...(featuresImprove.reflect as Record<string, unknown>) }
          : ({} as Record<string, unknown>);

      const existingOptions =
        typeof existingReflect.options === "object" &&
        existingReflect.options !== null &&
        !Array.isArray(existingReflect.options)
          ? { ...(existingReflect.options as Record<string, unknown>) }
          : ({} as Record<string, unknown>);

      existingOptions.cooldown = improve.reflectCooldownByType;
      existingReflect.options = existingOptions;
      featuresImprove.reflect = existingReflect;
      features.improve = featuresImprove;
      result.features = features;
      changed = true;
    }

    if (typeof improve.limit === "number") {
      const defaults = (
        typeof result.defaults === "object" && result.defaults !== null && !Array.isArray(result.defaults)
          ? { ...(result.defaults as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      const defaultsImprove = (
        typeof defaults.improve === "object" && defaults.improve !== null && !Array.isArray(defaults.improve)
          ? { ...(defaults.improve as Record<string, unknown>) }
          : {}
      ) as Record<string, unknown>;
      defaultsImprove.limit = improve.limit;
      defaults.improve = defaultsImprove;
      result.defaults = defaults;
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
