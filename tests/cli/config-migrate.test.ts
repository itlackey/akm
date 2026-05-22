import { describe, expect, test } from "bun:test";
import { migrateConfigShape } from "../../src/cli/config-migrate";

describe("migrateConfigShape", () => {
  test("is idempotent on v2 config", () => {
    const input = { configVersion: 2, profiles: { llm: {} } };
    const { changed } = migrateConfigShape(input);
    expect(changed).toBe(false);
  });

  test("migrates memory_inference from llm.features to features.index", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "llama3",
        features: { memory_inference: true },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe("0.8.0");
    const features = result.features as Record<string, unknown>;
    const index = features.index as Record<string, unknown>;
    expect(index.memory_inference).toBe(true);
    // Stripped from llm.features
    const llm = result.llm as Record<string, unknown>;
    expect(llm.features).toBeUndefined();
  });

  test("migrates graph_extraction from llm.features to features.index", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { graph_extraction: false } },
    };
    const { result } = migrateConfigShape(input);
    const index = (result.features as Record<string, unknown>).index as Record<string, unknown>;
    expect(index.graph_extraction).toBe(false);
  });

  test("migrates metadata_enhance from llm.features to features.index", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { metadata_enhance: true } },
    };
    const { result } = migrateConfigShape(input);
    const index = (result.features as Record<string, unknown>).index as Record<string, unknown>;
    expect(index.metadata_enhance).toBe(true);
  });

  test("migrates memory_consolidation from llm.features to features.improve", () => {
    const input = {
      llm: {
        endpoint: "http://x.com/v1/chat/completions",
        model: "m",
        features: { memory_consolidation: true },
      },
    };
    const { result } = migrateConfigShape(input);
    const improve = (result.features as Record<string, unknown>).improve as Record<string, unknown>;
    expect(improve.memory_consolidation).toBe(true);
  });

  test("migrates feedback_distillation from llm.features to features.improve", () => {
    const input = {
      llm: {
        endpoint: "http://x.com/v1/chat/completions",
        model: "m",
        features: { feedback_distillation: false },
      },
    };
    const { result } = migrateConfigShape(input);
    const improve = (result.features as Record<string, unknown>).improve as Record<string, unknown>;
    expect(improve.feedback_distillation).toBe(false);
  });

  test("migrates curate_rerank from llm.features to features.search", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    const search = (result.features as Record<string, unknown>).search as Record<string, unknown>;
    expect(search.curate_rerank).toBe(true);
  });

  test("migrates reflectCooldownByType to profiles.improve.default.processes.reflect.cooldownByType", () => {
    const input = { improve: { reflectCooldownByType: { memory: 1, lesson: 5 } } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    const processes = defaultProfile.processes as Record<string, unknown>;
    const reflect = processes.reflect as Record<string, unknown>;
    expect(reflect.cooldownByType).toEqual({ memory: 1, lesson: 5 });
    expect(result.improve).toBeUndefined();
  });

  test("migrates improve.limit to profiles.improve.default.limit", () => {
    const input = { improve: { limit: 50 } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(50);
  });

  test("migrates improve.reflectCooldownByType + improve.limit together", () => {
    const input = { improve: { reflectCooldownByType: { memory: 5 }, limit: 25 } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    const processes = defaultProfile.processes as Record<string, unknown>;
    const reflect = processes.reflect as Record<string, unknown>;
    expect(reflect.cooldownByType).toEqual({ memory: 5 });
    expect(defaultProfile.limit).toBe(25);
    expect(result.improve).toBeUndefined();
  });

  test("migrates defaults.improve.limit (legacy object form) to profiles.improve.default.limit", () => {
    const input = { defaults: { improve: { limit: 17 } } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(17);
    // Object form should be removed so the parser doesn't see it.
    expect(result.defaults).toBeUndefined();
  });

  test("warns and drops defaults.improve.preset (no longer supported)", () => {
    const input = { defaults: { improve: { preset: "fast", limit: 10 } } };
    // Capture warning so it doesn't pollute test output and so we can assert it fires.
    const originalWarn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const { changed, result } = migrateConfigShape(input);
      expect(changed).toBe(true);
      const profiles = result.profiles as Record<string, unknown>;
      const profilesImprove = profiles.improve as Record<string, unknown>;
      const defaultProfile = profilesImprove.default as Record<string, unknown>;
      expect(defaultProfile.limit).toBe(10);
      expect(result.defaults).toBeUndefined();
      expect(messages.some((m) => m.includes("preset"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("strips improve.schedule", () => {
    const input = { improve: { schedule: "0 * * * *", limit: 10 } };
    const { result } = migrateConfigShape(input);
    const improve = result.improve as Record<string, unknown> | undefined;
    // schedule should be stripped; limit moved to defaults
    expect((improve as Record<string, unknown> | undefined)?.schedule).toBeUndefined();
  });

  test("strips sdkMode from agent profiles", () => {
    const input = {
      agent: {
        profiles: {
          myprofile: { bin: "opencode", sdkMode: true, model: "claude-3" },
        },
      },
    };
    const { result } = migrateConfigShape(input);
    const agent = result.agent as Record<string, unknown>;
    const profiles = agent.profiles as Record<string, Record<string, unknown>>;
    expect(profiles.myprofile.sdkMode).toBeUndefined();
    expect(profiles.myprofile.bin).toBe("opencode");
    expect(profiles.myprofile.model).toBe("claude-3");
  });

  test("strips config.agent.processes['task']", () => {
    const input = {
      agent: {
        processes: { task: { profile: "opencode" }, reflect: { profile: "opencode" } },
      },
    };
    const { result } = migrateConfigShape(input);
    const agent = result.agent as Record<string, unknown>;
    const processes = agent.processes as Record<string, unknown>;
    expect(processes.task).toBeUndefined();
    expect(processes.reflect).toBeDefined();
  });

  test('sets configVersion: "0.8.0" on migrated config', () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    expect(result.configVersion).toBe("0.8.0");
  });

  test("handles all 6 feature key migrations in one config", () => {
    const input = {
      llm: {
        endpoint: "http://x.com/v1/chat/completions",
        model: "m",
        features: {
          memory_inference: true,
          graph_extraction: false,
          metadata_enhance: true,
          memory_consolidation: true,
          feedback_distillation: false,
          curate_rerank: true,
        },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const features = result.features as Record<string, Record<string, unknown>>;
    expect(features.index.memory_inference).toBe(true);
    expect(features.index.graph_extraction).toBe(false);
    expect(features.index.metadata_enhance).toBe(true);
    expect(features.improve.memory_consolidation).toBe(true);
    expect(features.improve.feedback_distillation).toBe(false);
    expect(features.search.curate_rerank).toBe(true);
  });

  test("does not change config with no migratable keys", () => {
    const input = { stashDir: "/my/stash", semanticSearchMode: "auto" };
    const { changed } = migrateConfigShape(input);
    expect(changed).toBe(false);
  });
});
