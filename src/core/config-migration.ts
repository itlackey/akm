/**
 * Config shape migration logic for AKM v0.8.0.
 *
 * This module is intentionally kept free of imports from `config.ts` to avoid
 * circular dependencies: `config.ts` imports `migrateConfigShape` from here,
 * and `config-migrate.ts` (the CLI command) also imports from here.
 *
 * Migration policy (0.8.0): every legacy field is migrated to its NEW final
 * location and stripped from the raw config. Production code reads ONLY the
 * new shape. There are no backward-compat shims after this migration.
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
    return [0, Math.trunc(v), 0];
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    const cleaned = trimmed.replace(/^v/i, "").split(/[-+]/, 1)[0];
    const segments = cleaned.split(".").map((part) => Number.parseInt(part, 10));
    if (segments.length === 0 || segments.some((n) => !Number.isFinite(n))) return undefined;
    return segments;
  }
  return undefined;
}

// ── Helpers for deep-merging into nested locations ──────────────────────────

function getObj(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

/** Get the `profiles.improve.default.processes.<name>` object (creating intermediate nodes). */
function getImproveProcess(result: Record<string, unknown>, processName: string): Record<string, unknown> {
  const profiles = getObj(result, "profiles");
  const improve = getObj(profiles, "improve");
  const defaultProfile = getObj(improve, "default");
  const processes = getObj(defaultProfile, "processes");
  return getObj(processes, processName);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Migrate a single legacy ProcessEntry-like value (boolean or
 * { enabled, mode, profile, timeoutMs, options }) into an ImproveProcessConfig
 * at the target location. Merges shallowly with anything already present.
 */
function migrateProcessEntryToImprove(result: Record<string, unknown>, processName: string, legacy: unknown): void {
  const target = getImproveProcess(result, processName);
  if (typeof legacy === "boolean") {
    target.enabled = legacy;
    return;
  }
  if (!isObj(legacy)) return;
  if (typeof legacy.enabled === "boolean") target.enabled = legacy.enabled;
  if (typeof legacy.mode === "string") target.mode = legacy.mode;
  if (typeof legacy.profile === "string") target.profile = legacy.profile;
  if (legacy.timeoutMs === null || typeof legacy.timeoutMs === "number") target.timeoutMs = legacy.timeoutMs;
  if (isObj(legacy.options)) {
    const opts = legacy.options;
    if (typeof opts.cooldown === "object" && opts.cooldown !== null) {
      target.cooldownByType = opts.cooldown;
    }
    if (typeof opts.cooldownDays === "number") {
      target.cooldownDays = opts.cooldownDays;
    }
    if (Array.isArray(opts.allowedTypes)) {
      target.allowedTypes = opts.allowedTypes;
    }
  }
}

/**
 * Determine whether a raw config object needs migration to the 0.8.0 shape and
 * apply any necessary field renames or promotions.
 *
 * A config is considered already migrated when `configVersion === "0.8.0"`
 * (canonical string sentinel for this release) or when `configVersion` is a
 * number ≥ 2 AND the config carries no recognized legacy keys.
 */
export function migrateConfigShape(raw: Record<string, unknown>): {
  changed: boolean;
  result: Record<string, unknown>;
} {
  const hasLegacyKeys =
    Object.hasOwn(raw, "features") ||
    (isObj(raw.llm) && (Object.hasOwn(raw.llm, "endpoint") || Object.hasOwn(raw.llm, "features"))) ||
    isObj(raw.agent);

  // Already migrated — string sentinel "0.8.0" with no legacy keys present.
  if (raw.configVersion === CURRENT_CONFIG_VERSION && !hasLegacyKeys) {
    return { changed: false, result: raw };
  }
  // Legacy numeric versioning sentinel (>= 2) with no legacy keys present.
  if (typeof raw.configVersion === "number" && raw.configVersion >= 2 && !hasLegacyKeys) {
    return { changed: false, result: raw };
  }

  const result: Record<string, unknown> = { ...raw };
  let changed = false;

  // ── 1) Migrate `llm.features.*` → new homes ────────────────────────────
  if (isObj(result.llm)) {
    const llm = { ...(result.llm as Record<string, unknown>) };
    if (isObj(llm.features)) {
      const llmFeatures = llm.features as Record<string, unknown>;

      const setProcessEnabled = (processName: string, enabled: unknown): void => {
        if (typeof enabled !== "boolean") return;
        const target = getImproveProcess(result, processName);
        target.enabled = enabled;
      };

      if ("memory_consolidation" in llmFeatures) {
        setProcessEnabled("consolidate", llmFeatures.memory_consolidation);
      }
      if ("feedback_distillation" in llmFeatures) {
        setProcessEnabled("feedbackDistillation", llmFeatures.feedback_distillation);
      }
      if ("memory_inference" in llmFeatures) {
        setProcessEnabled("memoryInference", llmFeatures.memory_inference);
      }
      if ("graph_extraction" in llmFeatures) {
        setProcessEnabled("graphExtraction", llmFeatures.graph_extraction);
      }
      if ("metadata_enhance" in llmFeatures) {
        const index = getObj(result, "index");
        const me = getObj(index, "metadataEnhance");
        if (typeof llmFeatures.metadata_enhance === "boolean") me.enabled = llmFeatures.metadata_enhance;
      }
      if ("curate_rerank" in llmFeatures) {
        const search = getObj(result, "search");
        const cr = getObj(search, "curateRerank");
        if (typeof llmFeatures.curate_rerank === "boolean") cr.enabled = llmFeatures.curate_rerank;
      }
      if ("lesson_quality_gate" in llmFeatures) {
        const distill = getImproveProcess(result, "distill");
        const qg = getObj(distill, "qualityGate");
        if (typeof llmFeatures.lesson_quality_gate === "boolean") qg.enabled = llmFeatures.lesson_quality_gate;
      }
      if ("proposal_quality_gate" in llmFeatures) {
        const reflect = getImproveProcess(result, "reflect");
        const qg = getObj(reflect, "qualityGate");
        if (typeof llmFeatures.proposal_quality_gate === "boolean") qg.enabled = llmFeatures.proposal_quality_gate;
      }
      if ("memory_contradiction_detection" in llmFeatures) {
        const consolidate = getImproveProcess(result, "consolidate");
        const cd = getObj(consolidate, "contradictionDetection");
        if (typeof llmFeatures.memory_contradiction_detection === "boolean") {
          cd.enabled = llmFeatures.memory_contradiction_detection;
        }
      }

      delete llm.features;
      changed = true;
    }

    // 2) Migrate top-level `llm` (LlmConnectionConfig) → `profiles.llm.default`
    //    + `defaults.llm = "default"` if it actually has connection fields.
    if (typeof llm.endpoint === "string") {
      const profiles = getObj(result, "profiles");
      const llmProfiles = getObj(profiles, "llm");
      // Don't overwrite if a "default" entry already exists.
      if (!isObj(llmProfiles.default)) {
        llmProfiles.default = { ...llm };
      }
      const defaults = getObj(result, "defaults");
      if (typeof defaults.llm !== "string") defaults.llm = "default";
      changed = true;
    }

    // Always strip the legacy `llm` block — its only remaining job was holding
    // connection fields and `features`, both migrated.
    delete result.llm;
  }

  // ── 3) Migrate `features.*` (top-level) → new homes ────────────────────
  if (isObj(result.features)) {
    const features = result.features as Record<string, unknown>;

    if (isObj(features.improve)) {
      const fi = features.improve as Record<string, unknown>;
      // memory_consolidation (bool or ProcessEntry) → processes.consolidate
      if ("memory_consolidation" in fi) {
        migrateProcessEntryToImprove(result, "consolidate", fi.memory_consolidation);
      }
      // feedback_distillation (bool) → processes.feedbackDistillation
      if ("feedback_distillation" in fi) {
        migrateProcessEntryToImprove(result, "feedbackDistillation", fi.feedback_distillation);
      }
      // validation (ProcessEntry) → processes.validation
      if ("validation" in fi) {
        migrateProcessEntryToImprove(result, "validation", fi.validation);
      }
      // reflect/distill/consolidate (ProcessEntry) — merged with .options.cooldown → cooldownByType
      if ("reflect" in fi) migrateProcessEntryToImprove(result, "reflect", fi.reflect);
      if ("distill" in fi) migrateProcessEntryToImprove(result, "distill", fi.distill);
      if ("consolidate" in fi) migrateProcessEntryToImprove(result, "consolidate", fi.consolidate);
      changed = true;
    }

    if (isObj(features.index)) {
      const findex = features.index as Record<string, unknown>;
      if ("memory_inference" in findex) {
        migrateProcessEntryToImprove(result, "memoryInference", findex.memory_inference);
      }
      if ("graph_extraction" in findex) {
        migrateProcessEntryToImprove(result, "graphExtraction", findex.graph_extraction);
      }
      if ("metadata_enhance" in findex) {
        const index = getObj(result, "index");
        const me = getObj(index, "metadataEnhance");
        const val = findex.metadata_enhance;
        if (typeof val === "boolean") me.enabled = val;
        else if (isObj(val) && typeof val.enabled === "boolean") me.enabled = val.enabled;
      }
      if ("staleness_detection" in findex) {
        const index = getObj(result, "index");
        const sd = getObj(index, "stalenessDetection");
        const val = findex.staleness_detection;
        if (typeof val === "boolean") sd.enabled = val;
        else if (isObj(val)) {
          if (typeof val.enabled === "boolean") sd.enabled = val.enabled;
          if (isObj(val.options) && typeof val.options.thresholdDays === "number") {
            sd.thresholdDays = val.options.thresholdDays;
          }
        }
      }
      changed = true;
    }

    if (isObj(features.search)) {
      const fsearch = features.search as Record<string, unknown>;
      if ("curate_rerank" in fsearch) {
        const search = getObj(result, "search");
        const cr = getObj(search, "curateRerank");
        const val = fsearch.curate_rerank;
        if (typeof val === "boolean") cr.enabled = val;
        else if (isObj(val) && typeof val.enabled === "boolean") cr.enabled = val.enabled;
      }
      changed = true;
    }

    delete result.features;
  }

  // ── 4) Migrate `agent.*` (v1) → `profiles.agent` + `defaults.agent` ──────
  if (isObj(result.agent)) {
    const agent = result.agent as Record<string, unknown>;

    // 4a) agent.default → defaults.agent
    if (typeof agent.default === "string" && agent.default.trim()) {
      const defaults = getObj(result, "defaults");
      if (typeof defaults.agent !== "string") defaults.agent = agent.default.trim();
      changed = true;
    }

    // 4b) agent.profiles → profiles.agent (only entries with valid `platform`)
    if (isObj(agent.profiles)) {
      const v1Profiles = agent.profiles as Record<string, unknown>;
      const profiles = getObj(result, "profiles");
      const agentProfiles = getObj(profiles, "agent");
      for (const [name, raw] of Object.entries(v1Profiles)) {
        if (!isObj(raw)) continue;
        if (isObj(agentProfiles[name])) continue; // do not overwrite existing v2 entries
        // v1 profiles do not carry a "platform" — synthesize one from name where possible.
        const platform = typeof raw.platform === "string" ? raw.platform : guessAgentPlatform(name);
        if (!platform) continue;
        const v2: Record<string, unknown> = { platform };
        if (typeof raw.bin === "string" && raw.bin.trim()) v2.bin = raw.bin.trim();
        if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")) v2.args = raw.args;
        if (typeof raw.model === "string" && raw.model.trim()) v2.model = raw.model.trim();
        if (typeof raw.workspace === "string" && raw.workspace.trim()) v2.workspace = raw.workspace.trim();
        agentProfiles[name] = v2;
        changed = true;
      }
    }

    // 4c) agent.processes.<name> (v1 binding) → profiles.improve.default.processes.<name>.profile
    if (isObj(agent.processes)) {
      const v1Processes = agent.processes as Record<string, unknown>;
      for (const [processName, raw] of Object.entries(v1Processes)) {
        if (processName === "task") continue; // legacy v1-only; drop
        let profileName: string | undefined;
        let timeoutMs: number | null | undefined;
        if (typeof raw === "string" && raw.trim()) {
          profileName = raw.trim();
        } else if (isObj(raw)) {
          if (typeof raw.profile === "string" && raw.profile.trim()) profileName = raw.profile.trim();
          if (raw.timeoutMs === null || typeof raw.timeoutMs === "number") {
            timeoutMs = raw.timeoutMs;
          }
        }
        if (!profileName) continue;
        // Map v1 process names to v2 improve process names.
        const v2Name = mapV1ProcessName(processName);
        if (!v2Name) continue;
        const target = getImproveProcess(result, v2Name);
        target.profile = profileName;
        target.mode = "agent";
        if (timeoutMs !== undefined) target.timeoutMs = timeoutMs;
        changed = true;
      }
    }

    delete result.agent;
  }

  // ── 5) Migrate `improve.*` (top-level pipeline options) ──────────────────
  if (isObj(result.improve)) {
    const improve = { ...(result.improve as Record<string, unknown>) };

    if (isObj(improve.reflectCooldownByType)) {
      const reflect = getImproveProcess(result, "reflect");
      reflect.cooldownByType = improve.reflectCooldownByType;
      changed = true;
    }
    if (typeof improve.limit === "number") {
      const profiles = getObj(result, "profiles");
      const improveProfiles = getObj(profiles, "improve");
      const defaultProfile = getObj(improveProfiles, "default");
      defaultProfile.limit = improve.limit;
      changed = true;
    }

    delete improve.reflectCooldownByType;
    delete improve.limit;
    delete improve.schedule;
    if (Object.keys(improve).length > 0) {
      result.improve = improve;
    } else {
      delete result.improve;
    }
  }

  // ── 6) Legacy `defaults.improve` object form ({ limit, preset }) ─────────
  if (isObj(result.defaults)) {
    const defaultsRaw = { ...(result.defaults as Record<string, unknown>) };
    const defaultsImprove = defaultsRaw.improve;
    if (isObj(defaultsImprove)) {
      const improveObj = defaultsImprove as Record<string, unknown>;
      if (typeof improveObj.limit === "number") {
        const profiles = getObj(result, "profiles");
        const improveProfiles = getObj(profiles, "improve");
        const defaultProfile = getObj(improveProfiles, "default");
        if (typeof defaultProfile.limit !== "number") defaultProfile.limit = improveObj.limit;
        changed = true;
      }
      if (improveObj.preset !== undefined) {
        console.warn(
          "[akm config-migrate] defaults.improve.preset is no longer supported. " +
            "Use `--profile <name>` (built-ins: default, quick, thorough, memory-focus) instead.",
        );
      }
      delete defaultsRaw.improve;
      if (Object.keys(defaultsRaw).length > 0) {
        result.defaults = defaultsRaw;
      } else {
        delete result.defaults;
      }
      changed = true;
    }
  }

  // Stamp the new version sentinel on any migration that did substantive work.
  if (changed) {
    result.configVersion = CURRENT_CONFIG_VERSION;
  }

  return { changed, result };
}

/**
 * Guess a v2 agent platform for a known v1 profile name. Returns `undefined`
 * for unknown names — the caller drops those entries (they have no usable
 * platform).
 */
function guessAgentPlatform(name: string): "opencode" | "claude" | "opencode-sdk" | undefined {
  const lower = name.toLowerCase();
  if (lower === "claude" || lower === "claude-code") return "claude";
  if (lower.startsWith("opencode-sdk")) return "opencode-sdk";
  if (lower.startsWith("opencode")) return "opencode";
  return undefined;
}

/**
 * Map a v1 process name (e.g. `"reflect"`, `"propose"`) to its v2 improve
 * process name. Returns `undefined` for names that have no v2 home (e.g.
 * `"task"`, which was removed).
 */
function mapV1ProcessName(name: string): string | undefined {
  switch (name) {
    case "reflect":
      return "reflect";
    case "distill":
      return "distill";
    case "consolidate":
      return "consolidate";
    case "propose":
      // v1 "propose" mapped to reflect/distill at runtime; bind to reflect by default.
      return "reflect";
    case "validation":
      return "validation";
    case "memoryInference":
    case "memory_inference":
      return "memoryInference";
    case "graphExtraction":
    case "graph_extraction":
      return "graphExtraction";
    case "feedbackDistillation":
    case "feedback_distillation":
      return "feedbackDistillation";
    default:
      return undefined;
  }
}
