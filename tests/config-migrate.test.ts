import { describe, expect, test } from "bun:test";
import { CURRENT_CONFIG_VERSION, migrateConfigShape } from "../src/core/config-migration";

describe("migrateConfigShape", () => {
  test("no-op when configVersion is already '0.8.0' (no legacy keys)", () => {
    const input = { configVersion: "0.8.0", profiles: { llm: {} } };
    const { changed } = migrateConfigShape(input);
    expect(changed).toBe(false);
  });

  test("migrates legacy keys even when configVersion is already 0.8.0", () => {
    const input = {
      configVersion: "0.8.0",
      llm: { endpoint: "http://x", model: "m", features: { memory_inference: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.llm).toBeUndefined();
  });

  test("no-op when configVersion is a number >= 2 (legacy numeric) and no legacy keys", () => {
    const input = { configVersion: 2, stashDir: "/foo" };
    const { changed } = migrateConfigShape(input as Record<string, unknown>);
    expect(changed).toBe(false);
  });

  test("empty config is a no-op (no version stamp needed)", () => {
    const { changed, result } = migrateConfigShape({});
    expect(changed).toBe(false);
    expect(result.configVersion).toBeUndefined();
  });

  test("migrates llm.features.memory_inference → profiles.improve.default.processes.memoryInference.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { memory_inference: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe(CURRENT_CONFIG_VERSION);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { enabled?: boolean }>;
    expect(procs.memoryInference.enabled).toBe(true);
    // Legacy llm block stripped (its endpoint/model migrated into profiles.llm.default)
    expect(result.llm).toBeUndefined();
    const llmProfiles = (result.profiles as Record<string, unknown>).llm as Record<string, { endpoint?: string }>;
    expect(llmProfiles.default.endpoint).toBe("http://localhost:11434");
  });

  test("migrates llm.features.graph_extraction → profiles.improve.default.processes.graphExtraction.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { graph_extraction: false } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { enabled?: boolean }>;
    expect(procs.graphExtraction.enabled).toBe(false);
  });

  test("migrates llm.features.feedback_distillation → profiles.improve.default.processes.feedbackDistillation.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { feedback_distillation: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { enabled?: boolean }>;
    expect(procs.feedbackDistillation.enabled).toBe(true);
  });

  test("migrates llm.features.curate_rerank → search.curateRerank.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { curate_rerank: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const search = result.search as { curateRerank?: { enabled?: boolean } };
    expect(search.curateRerank?.enabled).toBe(true);
  });

  test("migrates llm.features.metadata_enhance → index.metadataEnhance.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { metadata_enhance: false } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const index = result.index as { metadataEnhance?: { enabled?: boolean } };
    expect(index.metadataEnhance?.enabled).toBe(false);
  });

  test("migrates llm.features.lesson_quality_gate → processes.distill.qualityGate.enabled", () => {
    const input = {
      llm: { endpoint: "http://x", model: "m", features: { lesson_quality_gate: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { qualityGate?: { enabled?: boolean } }>;
    expect(procs.distill.qualityGate?.enabled).toBe(true);
  });

  test("migrates llm.features.proposal_quality_gate → processes.reflect.qualityGate.enabled", () => {
    const input = {
      llm: { endpoint: "http://x", model: "m", features: { proposal_quality_gate: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { qualityGate?: { enabled?: boolean } }>;
    expect(procs.reflect.qualityGate?.enabled).toBe(true);
  });

  test("migrates llm.features.memory_contradiction_detection → processes.consolidate.contradictionDetection.enabled", () => {
    const input = {
      llm: { endpoint: "http://x", model: "m", features: { memory_contradiction_detection: true } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { contradictionDetection?: { enabled?: boolean } }>;
    expect(procs.consolidate.contradictionDetection?.enabled).toBe(true);
  });

  test("migrates improve.reflectCooldownByType → profiles.improve.default.processes.reflect.cooldownByType", () => {
    const cooldown = { lesson: 7, feedback: 14 };
    const input = { improve: { reflectCooldownByType: cooldown } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { cooldownByType?: unknown }>;
    expect(procs.reflect.cooldownByType).toEqual(cooldown);
    expect(result.improve).toBeUndefined();
  });

  test("migrates improve.reflectCooldownByType + improve.limit together", () => {
    const input = { improve: { reflectCooldownByType: { memory: 5 }, limit: 25 } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(25);
    expect(result.improve).toBeUndefined();
  });

  test("migrates legacy defaults.improve object form → profiles.improve.default.limit", () => {
    const input = { defaults: { improve: { limit: 17 } } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(17);
  });

  test("strips the legacy agent block entirely after migrating into profiles.agent + defaults.agent", () => {
    const input = {
      agent: {
        default: "claude",
        profiles: { claude: { bin: "claude" } },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.agent).toBeUndefined();
    const defaults = result.defaults as { agent?: string };
    expect(defaults.agent).toBe("claude");
    const profiles = result.profiles as { agent?: Record<string, { platform?: string; bin?: string }> };
    expect(profiles.agent?.claude?.bin).toBe("claude");
    expect(profiles.agent?.claude?.platform).toBe("claude");
  });

  test("sets configVersion to CURRENT_CONFIG_VERSION when changed", () => {
    const input = { agent: { default: "claude" } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test("preserves non-migrated fields", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { memory_inference: true } },
      stashDir: "/my/stash",
      semanticSearchMode: "auto",
    };
    const { result } = migrateConfigShape(input);
    expect(result.stashDir).toBe("/my/stash");
    expect(result.semanticSearchMode).toBe("auto");
  });
});
