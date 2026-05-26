/**
 * Test helpers for building AkmConfig values in the 0.8.0 unified shape.
 *
 * The legacy mental model — `{ llm: {...}, agent: {...}, features: {...} }` —
 * is gone in 0.8.0. Tests that still want a one-liner mock LLM/agent should
 * use these helpers to land in the new locations.
 */
import type { AgentProfileConfigV2, AkmConfig, LlmConnectionConfig } from "../../src/core/config";

interface LegacyShape {
  llm?: LlmConnectionConfig & { features?: Record<string, boolean> };
  agent?: { default?: string; profiles?: Record<string, Partial<AgentProfileConfigV2> & { sdkMode?: boolean }> };
  features?: {
    improve?: Record<string, unknown>;
    index?: Record<string, unknown>;
    search?: Record<string, unknown>;
  };
}

/**
 * Build an AkmConfig from a legacy-shape object. The `llm` block is routed to
 * `profiles.llm.default` + `defaults.llm = "default"`; the `agent` block is
 * routed to `profiles.agent.<name>` + `defaults.agent`; legacy `features.*`
 * trees are translated into the unified `profiles.improve.default.processes`,
 * `index.*`, and `search.*` locations.
 */
export function mkConfig(extra: Partial<AkmConfig> & LegacyShape = {}): AkmConfig {
  const { llm, agent, features, ...rest } = extra;
  let config: AkmConfig = { semanticSearchMode: "auto", ...rest };

  if (llm) {
    const { features: llmFeatures, ...llmRest } = llm;
    config = {
      ...config,
      profiles: {
        ...(config.profiles ?? {}),
        llm: { ...(config.profiles?.llm ?? {}), default: { ...llmRest } as LlmConnectionConfig },
      },
      defaults: { ...(config.defaults ?? {}), llm: "default" },
    };
    if (llmFeatures) {
      config = applyLegacyFeatureFlags(config, llmFeatures);
    }
  }

  if (agent) {
    const v2Profiles: Record<string, AgentProfileConfigV2> = { ...(config.profiles?.agent ?? {}) };
    for (const [name, profile] of Object.entries(agent.profiles ?? {})) {
      const platform = profile.sdkMode
        ? ("opencode-sdk" as const)
        : name.toLowerCase().includes("claude")
          ? ("claude" as const)
          : ("opencode" as const);
      v2Profiles[name] = {
        platform,
        ...(profile.bin ? { bin: profile.bin } : {}),
        ...(profile.args ? { args: profile.args } : {}),
        ...(profile.model ? { model: profile.model } : {}),
      };
    }
    config = {
      ...config,
      profiles: { ...(config.profiles ?? {}), agent: v2Profiles },
      defaults: { ...(config.defaults ?? {}), agent: agent.default },
    };
  }

  if (features) {
    if (features.improve) {
      for (const [k, v] of Object.entries(features.improve)) {
        const enabled =
          typeof v === "boolean" ? v : !!(v && typeof v === "object" && (v as { enabled?: boolean }).enabled !== false);
        const processName =
          k === "memory_consolidation" ? "consolidate" : k === "feedback_distillation" ? "distill" : k;
        config = applyProcessFlag(config, processName, enabled);
      }
    }
    if (features.index) {
      for (const [k, v] of Object.entries(features.index)) {
        const enabled =
          typeof v === "boolean" ? v : !!(v && typeof v === "object" && (v as { enabled?: boolean }).enabled !== false);
        if (k === "metadata_enhance") {
          config = { ...config, index: { ...(config.index ?? {}), metadataEnhance: { enabled } } };
        } else if (k === "staleness_detection") {
          config = { ...config, index: { ...(config.index ?? {}), stalenessDetection: { enabled } } };
        } else if (k === "memory_inference") {
          config = applyProcessFlag(config, "memoryInference", enabled);
        } else if (k === "graph_extraction") {
          config = applyProcessFlag(config, "graphExtraction", enabled);
        }
      }
    }
    if (features.search) {
      for (const [k, v] of Object.entries(features.search)) {
        const enabled =
          typeof v === "boolean" ? v : !!(v && typeof v === "object" && (v as { enabled?: boolean }).enabled !== false);
        if (k === "curate_rerank") {
          config = { ...config, search: { ...(config.search ?? {}), curateRerank: { enabled } } };
        }
      }
    }
  }

  return config;
}

function applyLegacyFeatureFlags(config: AkmConfig, flags: Record<string, boolean>): AkmConfig {
  let cfg = config;
  if (typeof flags.memory_consolidation === "boolean")
    cfg = applyProcessFlag(cfg, "consolidate", flags.memory_consolidation);
  if (typeof flags.feedback_distillation === "boolean")
    cfg = applyProcessFlag(cfg, "distill", flags.feedback_distillation);
  if (typeof flags.memory_inference === "boolean")
    cfg = applyProcessFlag(cfg, "memoryInference", flags.memory_inference);
  if (typeof flags.graph_extraction === "boolean")
    cfg = applyProcessFlag(cfg, "graphExtraction", flags.graph_extraction);
  if (typeof flags.metadata_enhance === "boolean")
    cfg = { ...cfg, index: { ...(cfg.index ?? {}), metadataEnhance: { enabled: flags.metadata_enhance } } };
  if (typeof flags.curate_rerank === "boolean")
    cfg = { ...cfg, search: { ...(cfg.search ?? {}), curateRerank: { enabled: flags.curate_rerank } } };
  if (typeof flags.lesson_quality_gate === "boolean") cfg = applyQualityGate(cfg, "distill", flags.lesson_quality_gate);
  if (typeof flags.proposal_quality_gate === "boolean")
    cfg = applyQualityGate(cfg, "reflect", flags.proposal_quality_gate);
  if (typeof flags.memory_contradiction_detection === "boolean")
    cfg = applyContradictionDetection(cfg, flags.memory_contradiction_detection);
  return cfg;
}

function applyProcessFlag(config: AkmConfig, processName: string, enabled: boolean): AkmConfig {
  const profile = config.profiles?.improve?.default ?? {};
  const processes = { ...(profile.processes ?? {}) } as Record<string, { enabled?: boolean }>;
  processes[processName] = { ...(processes[processName] ?? {}), enabled };
  return {
    ...config,
    profiles: {
      ...(config.profiles ?? {}),
      improve: {
        ...(config.profiles?.improve ?? {}),
        default: { ...profile, processes: processes as never },
      },
    },
  };
}

function applyQualityGate(config: AkmConfig, processName: "distill" | "reflect", enabled: boolean): AkmConfig {
  const profile = config.profiles?.improve?.default ?? {};
  const processes = { ...(profile.processes ?? {}) } as Record<
    string,
    { enabled?: boolean; qualityGate?: { enabled?: boolean } }
  >;
  processes[processName] = { ...(processes[processName] ?? {}), qualityGate: { enabled } };
  return {
    ...config,
    profiles: {
      ...(config.profiles ?? {}),
      improve: {
        ...(config.profiles?.improve ?? {}),
        default: { ...profile, processes: processes as never },
      },
    },
  };
}

function applyContradictionDetection(config: AkmConfig, enabled: boolean): AkmConfig {
  const profile = config.profiles?.improve?.default ?? {};
  const processes = { ...(profile.processes ?? {}) } as Record<
    string,
    { enabled?: boolean; contradictionDetection?: { enabled?: boolean } }
  >;
  processes.consolidate = { ...(processes.consolidate ?? {}), contradictionDetection: { enabled } };
  return {
    ...config,
    profiles: {
      ...(config.profiles ?? {}),
      improve: {
        ...(config.profiles?.improve ?? {}),
        default: { ...profile, processes: processes as never },
      },
    },
  };
}
