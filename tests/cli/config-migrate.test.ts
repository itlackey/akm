import { describe, expect, test } from "bun:test";
import { migrateConfigShape } from "../../src/cli/config-migrate";
import { setQuiet } from "../../src/core/warn";

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

  test("migrates feedback_distillation → processes.distill.enabled (0.8.0 unification)", () => {
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
    expect(procs.processes?.distill?.enabled).toBe(false);
    expect(procs.processes?.feedbackDistillation).toBeUndefined();
  });

  test("migrates curate_rerank → search.curateRerank.enabled", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    const search = result.search as { curateRerank?: { enabled?: boolean } };
    expect(search.curateRerank?.enabled).toBe(true);
  });

  test("drops legacy reflectCooldownByType (0.8.0 removed time-based reflect cooldowns)", () => {
    const input = { improve: { reflectCooldownByType: { memory: 1, lesson: 5 } } };
    const { result } = migrateConfigShape(input);
    const profiles = result.profiles as Record<string, unknown> | undefined;
    const profilesImprove = profiles?.improve as Record<string, unknown> | undefined;
    const defaultProfile = profilesImprove?.default as Record<string, unknown> | undefined;
    const processes = defaultProfile?.processes as Record<string, Record<string, unknown>> | undefined;
    expect(processes?.reflect?.cooldownByType).toBeUndefined();
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

  test("drops legacy reflectCooldownByType while preserving improve.limit migration", () => {
    const input = { improve: { reflectCooldownByType: { memory: 5 }, limit: 25 } };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(true);
    const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const processes = defaultProfile.processes as Record<string, { cooldownByType?: unknown }> | undefined;
    expect(processes?.reflect?.cooldownByType).toBeUndefined();
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
    expect(procs.processes?.distill?.enabled).toBe(false);
    expect((result.index as { metadataEnhance?: { enabled?: boolean } }).metadataEnhance?.enabled).toBe(true);
    expect((result.search as { curateRerank?: { enabled?: boolean } }).curateRerank?.enabled).toBe(true);
  });

  test("empty config with no migratable keys is a no-op", () => {
    const input = { stashDir: "/my/stash", semanticSearchMode: "auto" };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(false);
    expect(result.configVersion).toBeUndefined();
  });

  describe("catch-all migration for unknown features.* keys", () => {
    /** Capture warn output across a single block of code. */
    function captureStderr<T>(fn: () => T): { result: T; messages: string[] } {
      const messages: string[] = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      console.warn = (...args: unknown[]) => {
        messages.push(args.map((a) => String(a)).join(" "));
      };
      console.error = (...args: unknown[]) => {
        messages.push(args.map((a) => String(a)).join(" "));
      };
      // The harness sets quiet=true by default; opt into noisy mode so that
      // warn() calls inside migrateConfigShape reach the patched console.warn.
      setQuiet(false);
      try {
        const result = fn();
        return { result, messages };
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
        setQuiet(true); // restore harness default
      }
    }

    test("features.improve.<unknown> boolean → profiles.improve.default.processes.<camelKey>.enabled with warn", () => {
      const input = { features: { improve: { my_custom_process: true } } };
      const { result, messages } = captureStderr(() => migrateConfigShape(input));
      const procs = ((result.result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
        .default as { processes?: Record<string, { enabled?: boolean }> };
      expect(procs.processes?.myCustomProcess?.enabled).toBe(true);
      expect(messages.some((m) => m.includes("my_custom_process") && m.includes("myCustomProcess"))).toBe(true);
      // Legacy block stripped.
      expect(result.result.features).toBeUndefined();
    });

    test("features.improve.<unknown> ProcessEntry-shaped object → migrates with profile/mode/timeoutMs", () => {
      const input = {
        features: {
          improve: {
            customAgentProcess: {
              enabled: true,
              mode: "agent",
              profile: "opencode",
              timeoutMs: 12345,
              options: { allowedTypes: ["lesson"], cooldownDays: 7 },
            },
          },
        },
      };
      const { result, messages } = captureStderr(() => migrateConfigShape(input));
      const procs = ((result.result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
        .default as { processes?: Record<string, Record<string, unknown>> };
      const entry = procs.processes?.customAgentProcess;
      expect(entry?.enabled).toBe(true);
      expect(entry?.mode).toBe("agent");
      expect(entry?.profile).toBe("opencode");
      expect(entry?.timeoutMs).toBe(12345);
      expect(entry?.allowedTypes).toEqual(["lesson"]);
      // 0.8.0 dropped cooldownDays from process options — should not survive migration.
      expect(entry?.cooldownDays).toBeUndefined();
      expect(messages.some((m) => m.includes("customAgentProcess"))).toBe(true);
    });

    test("features.index.<unknown> boolean → index.<camelKey>.enabled with warn", () => {
      const input = { features: { index: { custom_pass: true } } };
      const { result, messages } = captureStderr(() => migrateConfigShape(input));
      const index = result.result.index as { customPass?: { enabled?: boolean } };
      expect(index.customPass?.enabled).toBe(true);
      expect(messages.some((m) => m.includes("custom_pass") && m.includes("customPass"))).toBe(true);
    });

    test("features.index.<unknown> object with options → index.<camelKey> preserves options", () => {
      const input = {
        features: {
          index: { custom_pass: { enabled: true, options: { threshold: 0.5, mode: "strict" } } },
        },
      };
      const { result } = captureStderr(() => migrateConfigShape(input));
      const index = result.result.index as {
        customPass?: { enabled?: boolean; options?: Record<string, unknown> };
      };
      expect(index.customPass?.enabled).toBe(true);
      expect(index.customPass?.options).toEqual({ threshold: 0.5, mode: "strict" });
    });

    test("features.search.<unknown> boolean → search.<camelKey>.enabled with warn", () => {
      const input = { features: { search: { fancy_rerank: false } } };
      const { result, messages } = captureStderr(() => migrateConfigShape(input));
      const search = result.result.search as { fancyRerank?: { enabled?: boolean } };
      expect(search.fancyRerank?.enabled).toBe(false);
      expect(messages.some((m) => m.includes("fancy_rerank") && m.includes("fancyRerank"))).toBe(true);
    });

    test("features.search.<unknown> object with enabled+options → search.<camelKey> preserves both", () => {
      const input = {
        features: {
          search: { fancy_rerank: { enabled: true, options: { topN: 25 } } },
        },
      };
      const { result } = captureStderr(() => migrateConfigShape(input));
      const search = result.result.search as {
        fancyRerank?: { enabled?: boolean; options?: Record<string, unknown> };
      };
      expect(search.fancyRerank?.enabled).toBe(true);
      expect(search.fancyRerank?.options).toEqual({ topN: 25 });
    });

    test("unknown features.improve key with unrecognized value type warns and drops", () => {
      // A bare string value is not a recognized ProcessEntry shape.
      const input = { features: { improve: { weird_key: "totally-unknown-value" } } };
      const { result, messages } = captureStderr(() => migrateConfigShape(input));
      // No target created.
      const profiles = result.result.profiles as Record<string, unknown> | undefined;
      const improve = profiles?.improve as Record<string, unknown> | undefined;
      const defaultProfile = improve?.default as Record<string, unknown> | undefined;
      const procs = defaultProfile?.processes as Record<string, unknown> | undefined;
      expect(procs?.weirdKey).toBeUndefined();
      expect(messages.some((m) => m.includes("weird_key") && m.toLowerCase().includes("dropping"))).toBe(true);
    });

    test("known keys still take their explicit paths even alongside unknown keys", () => {
      const input = {
        features: {
          improve: {
            memory_consolidation: true,
            my_custom: { enabled: true },
          },
          index: {
            metadata_enhance: true,
            custom_index_pass: true,
          },
          search: {
            curate_rerank: true,
            custom_search_pass: false,
          },
        },
      };
      const { result } = captureStderr(() => migrateConfigShape(input));
      const procs = ((result.result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
        .default as { processes?: Record<string, { enabled?: boolean }> };
      // Known.
      expect(procs.processes?.consolidate?.enabled).toBe(true);
      expect((result.result.index as { metadataEnhance?: { enabled?: boolean } }).metadataEnhance?.enabled).toBe(true);
      expect((result.result.search as { curateRerank?: { enabled?: boolean } }).curateRerank?.enabled).toBe(true);
      // Unknown.
      expect(procs.processes?.myCustom?.enabled).toBe(true);
      expect((result.result.index as { customIndexPass?: { enabled?: boolean } }).customIndexPass?.enabled).toBe(true);
      expect((result.result.search as { customSearchPass?: { enabled?: boolean } }).customSearchPass?.enabled).toBe(
        false,
      );
    });
  });
});
