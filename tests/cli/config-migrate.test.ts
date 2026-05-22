import { describe, expect, test } from "bun:test";
import { migrateConfigShape } from "../../src/cli/config-migrate";

describe("migrateConfigShape (CLI wrapper)", () => {
  test("is idempotent on already-migrated configs", () => {
    const input = { configVersion: "0.8.0", profiles: { llm: {} } };
    const { changed } = migrateConfigShape(input);
    expect(changed).toBe(false);
  });

  test("migrates memory_inference from llm.features → processes.memoryInference.enabled", () => {
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
    const procs = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>).default as {
      processes?: Record<string, { enabled?: boolean }>;
    };
    expect(procs.processes?.memoryInference?.enabled).toBe(true);
    // Legacy llm block stripped.
    expect(result.llm).toBeUndefined();
  });

  test("migrates graph_extraction → processes.graphExtraction.enabled", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { graph_extraction: false } },
    };
    const { result } = migrateConfigShape(input);
    const procs = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>).default as {
      processes?: Record<string, { enabled?: boolean }>;
    };
    expect(procs.processes?.graphExtraction?.enabled).toBe(false);
  });

  test("migrates metadata_enhance → index.metadataEnhance.enabled", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { metadata_enhance: true } },
    };
    const { result } = migrateConfigShape(input);
    const index = result.index as { metadataEnhance?: { enabled?: boolean } };
    expect(index.metadataEnhance?.enabled).toBe(true);
  });

  test("migrates memory_consolidation → processes.consolidate.enabled", () => {
    const input = {
      llm: {
        endpoint: "http://x.com/v1/chat/completions",
        model: "m",
        features: { memory_consolidation: true },
      },
    };
    const { result } = migrateConfigShape(input);
    const procs = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>).default as {
      processes?: Record<string, { enabled?: boolean }>;
    };
    expect(procs.processes?.consolidate?.enabled).toBe(true);
  });

  test("migrates feedback_distillation → processes.feedbackDistillation.enabled", () => {
    const input = {
      llm: {
        endpoint: "http://x.com/v1/chat/completions",
        model: "m",
        features: { feedback_distillation: false },
      },
    };
    const { result } = migrateConfigShape(input);
    const procs = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>).default as {
      processes?: Record<string, { enabled?: boolean }>;
    };
    expect(procs.processes?.feedbackDistillation?.enabled).toBe(false);
  });

  test("migrates curate_rerank → search.curateRerank.enabled", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    const search = result.search as { curateRerank?: { enabled?: boolean } };
    expect(search.curateRerank?.enabled).toBe(true);
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
    const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(50);
  });

  test("migrates improve.reflectCooldownByType + improve.limit together", () => {
    const input = { improve: { reflectCooldownByType: { memory: 5 }, limit: 25 } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const processes = defaultProfile.processes as Record<string, { cooldownByType?: unknown }>;
    expect(processes.reflect.cooldownByType).toEqual({ memory: 5 });
    expect(defaultProfile.limit).toBe(25);
    expect(result.improve).toBeUndefined();
  });

  test("migrates defaults.improve.limit (legacy object form) to profiles.improve.default.limit", () => {
    const input = { defaults: { improve: { limit: 17 } } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(17);
  });

  test("warns and drops defaults.improve.preset (no longer supported)", () => {
    const input = { defaults: { improve: { preset: "fast", limit: 10 } } };
    const originalWarn = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => {
      messages.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const { changed, result } = migrateConfigShape(input);
      expect(changed).toBe(true);
      const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
        .default as Record<string, unknown>;
      expect(defaultProfile.limit).toBe(10);
      expect(messages.some((m) => m.includes("preset"))).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("strips improve.schedule", () => {
    const input = { improve: { schedule: "0 * * * *", limit: 10 } };
    const { result } = migrateConfigShape(input);
    const improve = result.improve as Record<string, unknown> | undefined;
    expect(improve?.schedule).toBeUndefined();
  });

  test("migrates legacy agent.profiles + default into profiles.agent + defaults.agent", () => {
    const input = {
      agent: {
        default: "opencode",
        profiles: { opencode: { bin: "opencode" } },
      },
    };
    const { result } = migrateConfigShape(input);
    expect(result.agent).toBeUndefined();
    const defaults = result.defaults as { agent?: string };
    expect(defaults.agent).toBe("opencode");
    const profiles = result.profiles as { agent?: Record<string, { platform?: string; bin?: string }> };
    expect(profiles.agent?.opencode?.bin).toBe("opencode");
    expect(profiles.agent?.opencode?.platform).toBe("opencode");
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
    const procs = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>).default as {
      processes?: Record<string, { enabled?: boolean }>;
    };
    expect(procs.processes?.memoryInference?.enabled).toBe(true);
    expect(procs.processes?.graphExtraction?.enabled).toBe(false);
    expect(procs.processes?.consolidate?.enabled).toBe(true);
    expect(procs.processes?.feedbackDistillation?.enabled).toBe(false);
    expect((result.index as { metadataEnhance?: { enabled?: boolean } }).metadataEnhance?.enabled).toBe(true);
    expect((result.search as { curateRerank?: { enabled?: boolean } }).curateRerank?.enabled).toBe(true);
  });

  test("empty config with no migratable keys is a no-op", () => {
    const input = { stashDir: "/my/stash", semanticSearchMode: "auto" };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(false);
    expect(result.configVersion).toBeUndefined();
  });
});
