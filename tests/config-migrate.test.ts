import { describe, expect, test } from "bun:test";
import { CURRENT_CONFIG_VERSION, migrateConfigShape } from "../src/core/config-migration";

describe("migrateConfigShape", () => {
  test("no-op when configVersion is already '0.8.0'", () => {
    const input = { configVersion: "0.8.0", profiles: { llm: {} } };
    const { changed } = migrateConfigShape(input);
    expect(changed).toBe(false);
  });

  test("migrateConfigShape is idempotent for string '0.8.0' configVersion", () => {
    const { changed } = migrateConfigShape({ configVersion: "0.8.0" });
    expect(changed).toBe(false);
  });

  test("no-op when configVersion is a number >= 2 (legacy numeric)", () => {
    const input = { configVersion: 2, stashDir: "/foo" };
    const { changed } = migrateConfigShape(input as Record<string, unknown>);
    expect(changed).toBe(false);
  });

  test("no-op for empty config with no version (nothing to migrate)", () => {
    // An empty config has no fields to rename, so nothing changes
    const { changed } = migrateConfigShape({});
    expect(changed).toBe(false);
  });

  test("migrates llm.features.memory_inference → features.index.memory_inference", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe(CURRENT_CONFIG_VERSION);
    const features = result.features as Record<string, unknown>;
    expect(features).toBeDefined();
    const index = features.index as Record<string, unknown>;
    expect(index.memory_inference).toBe(true);
    // llm.features block should be gone
    const llm = result.llm as Record<string, unknown>;
    expect(llm.features).toBeUndefined();
    expect(llm.endpoint).toBe("http://localhost:11434");
  });

  test("migrates llm.features.graph_extraction → features.index.graph_extraction", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { graph_extraction: false },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const features = result.features as Record<string, unknown>;
    const index = features.index as Record<string, unknown>;
    expect(index.graph_extraction).toBe(false);
  });

  test("migrates llm.features.feedback_distillation → features.improve.feedback_distillation", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { feedback_distillation: true },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const features = result.features as Record<string, unknown>;
    const improve = features.improve as Record<string, unknown>;
    expect(improve.feedback_distillation).toBe(true);
  });

  test("migrates llm.features.curate_rerank → features.search.curate_rerank", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { curate_rerank: true },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const features = result.features as Record<string, unknown>;
    const search = features.search as Record<string, unknown>;
    expect(search.curate_rerank).toBe(true);
  });

  test("migrates improve.reflectCooldownByType → features.improve.reflect.options.cooldown", () => {
    const cooldown = { lesson: 7, feedback: 14 };
    const input = {
      improve: { reflectCooldownByType: cooldown },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const features = result.features as Record<string, unknown>;
    const improve = features.improve as Record<string, unknown>;
    const reflect = improve.reflect as Record<string, unknown>;
    const options = reflect.options as Record<string, unknown>;
    expect(options.cooldown).toEqual(cooldown);
    // improve block should be removed since only reflectCooldownByType was present
    expect(result.improve).toBeUndefined();
  });

  test("migrates improve.limit → defaults.improve.limit", () => {
    const input = {
      improve: { limit: 50 },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const defaults = result.defaults as Record<string, unknown>;
    const defaultsImprove = defaults.improve as Record<string, unknown>;
    expect(defaultsImprove.limit).toBe(50);
  });

  test("strips agent.processes.task", () => {
    const input = {
      agent: {
        processes: { task: { enabled: true }, review: { enabled: false } },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const agent = result.agent as Record<string, unknown>;
    const processes = agent.processes as Record<string, unknown>;
    expect(processes.task).toBeUndefined();
    expect(processes.review).toBeDefined();
  });

  test("strips agent.processes entirely when only task was present", () => {
    const input = {
      agent: {
        processes: { task: { enabled: true } },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const agent = result.agent as Record<string, unknown>;
    expect(agent.processes).toBeUndefined();
  });

  test("strips sdkMode from agent.profiles", () => {
    const input = {
      agent: {
        profiles: {
          claude: { sdkMode: true, model: "claude-opus" },
          opencode: { sdkMode: false, bin: "opencode" },
        },
      },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const agent = result.agent as Record<string, unknown>;
    const profiles = agent.profiles as Record<string, Record<string, unknown>>;
    expect(profiles.claude.sdkMode).toBeUndefined();
    expect(profiles.claude.model).toBe("claude-opus");
    expect(profiles.opencode.sdkMode).toBeUndefined();
    expect(profiles.opencode.bin).toBe("opencode");
  });

  test("sets configVersion to CURRENT_CONFIG_VERSION when changed", () => {
    const input = {
      agent: { processes: { task: {} } },
    };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test("preserves non-migrated fields", () => {
    const input = {
      llm: {
        endpoint: "http://localhost:11434",
        model: "qwen3",
        features: { memory_inference: true },
      },
      stashDir: "/my/stash",
      semanticSearchMode: "auto",
    };
    const { result } = migrateConfigShape(input);
    expect(result.stashDir).toBe("/my/stash");
    expect(result.semanticSearchMode).toBe("auto");
  });
});
