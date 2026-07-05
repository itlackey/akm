import { describe, expect, test } from "bun:test";
import { migrateConfigShape } from "../../src/cli/config-migrate";
import {
  CURRENT_CONFIG_VERSION,
  migrateConfigShape as migrateConfigShapeCore,
} from "../../src/core/config/config-migration";
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

  test("drops legacy curate_rerank (removed dead feature, not migrated)", () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    const search = result.search as { curateRerank?: { enabled?: boolean } } | undefined;
    expect(search?.curateRerank).toBeUndefined();
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
    const messages: string[] = [];
    const { changed, result } = migrateConfigShape(input, {
      warn: (...args: unknown[]) => {
        messages.push(args.map((a) => String(a)).join(" "));
      },
    });
    expect(changed).toBe(true);
    const defaultProfile = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(10);
    expect(messages.some((m) => m.includes("preset"))).toBe(true);
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

  test("(#566) infers v1 agent-profile platform via the harness registry, keeping legacy names", () => {
    // v1 profiles carry no explicit `platform`; it is inferred from the name.
    // After #566 this goes through the registry-backed v1ProfilePlatform so the
    // legacy 'claude-code' profile name resolves to canonical 'claude' (the
    // normalization bridge keeps round-tripping) and an 'opencode-sdk-fast'
    // decorated name resolves to 'opencode-sdk', not 'opencode'.
    const input = {
      agent: {
        profiles: {
          "claude-code": { bin: "claude" },
          "opencode-sdk-fast": { bin: "opencode" },
        },
      },
    };
    const { result } = migrateConfigShape(input);
    const profiles = result.profiles as { agent?: Record<string, { platform?: string }> };
    expect(profiles.agent?.["claude-code"]?.platform).toBe("claude");
    expect(profiles.agent?.["opencode-sdk-fast"]?.platform).toBe("opencode-sdk");
  });

  test("(#566) an unknown v1 agent-profile harness name is dropped, NOT misclassified to opencode", () => {
    // Pre-#566, guessAgentPlatform returned undefined only for non-prefixed
    // names; the real hazard is silent MISclassification elsewhere. Here the
    // contract is: a name no harness claims has no usable platform and is
    // dropped rather than written as a bogus 'opencode' profile.
    const input = {
      agent: {
        profiles: {
          cursor: { bin: "cursor" },
          opencode: { bin: "opencode" },
        },
      },
    };
    const { result } = migrateConfigShape(input);
    const profiles = result.profiles as { agent?: Record<string, { platform?: string }> };
    expect(profiles.agent?.cursor).toBeUndefined();
    // the known one still migrates correctly
    expect(profiles.agent?.opencode?.platform).toBe("opencode");
  });

  test('sets configVersion: "0.8.0" on migrated config', () => {
    const input = {
      llm: { endpoint: "http://x.com/v1/chat/completions", model: "m", features: { curate_rerank: true } },
    };
    const { result } = migrateConfigShape(input);
    expect(result.configVersion).toBe("0.8.0");
  });

  test("handles all 5 feature key migrations in one config", () => {
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
  });

  test("empty config with no migratable keys is a no-op", () => {
    const input = { stashDir: "/my/stash", semanticSearchMode: "auto" };
    const { changed, result } = migrateConfigShape(input);
    expect(changed).toBe(false);
    expect(result.configVersion).toBeUndefined();
  });

  describe("catch-all migration for unknown features.* keys", () => {
    /** Capture migration warnings without patching process-global stderr sinks. */
    function captureStderr<T>(fn: (captureWarn: (...args: unknown[]) => void) => T): { result: T; messages: string[] } {
      const messages: string[] = [];
      setQuiet(true);
      try {
        const result = fn((...args: unknown[]) => {
          messages.push(args.map((a) => String(a)).join(" "));
        });
        return { result, messages };
      } finally {
        setQuiet(true); // restore harness default
      }
    }

    test("features.improve.<unknown> boolean → profiles.improve.default.processes.<camelKey>.enabled with warn", () => {
      const input = { features: { improve: { my_custom_process: true } } };
      const { result, messages } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
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
      const { result, messages } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
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
      const { result, messages } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
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
      const { result } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
      const index = result.result.index as {
        customPass?: { enabled?: boolean; options?: Record<string, unknown> };
      };
      expect(index.customPass?.enabled).toBe(true);
      expect(index.customPass?.options).toEqual({ threshold: 0.5, mode: "strict" });
    });

    test("features.search.<unknown> boolean → search.<camelKey>.enabled with warn", () => {
      const input = { features: { search: { fancy_rerank: false } } };
      const { result, messages } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
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
      const { result } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
      const search = result.result.search as {
        fancyRerank?: { enabled?: boolean; options?: Record<string, unknown> };
      };
      expect(search.fancyRerank?.enabled).toBe(true);
      expect(search.fancyRerank?.options).toEqual({ topN: 25 });
    });

    test("unknown features.improve key with unrecognized value type warns and drops", () => {
      // A bare string value is not a recognized ProcessEntry shape.
      const input = { features: { improve: { weird_key: "totally-unknown-value" } } };
      const { result, messages } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
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
      const { result } = captureStderr((captureWarn) => migrateConfigShape(input, { warn: captureWarn }));
      const procs = ((result.result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
        .default as { processes?: Record<string, { enabled?: boolean }> };
      // Known.
      expect(procs.processes?.consolidate?.enabled).toBe(true);
      expect((result.result.index as { metadataEnhance?: { enabled?: boolean } }).metadataEnhance?.enabled).toBe(true);
      // Removed dead feature: curate_rerank is dropped, not migrated.
      expect((result.result.search as { curateRerank?: { enabled?: boolean } }).curateRerank).toBeUndefined();
      // Unknown.
      expect(procs.processes?.myCustom?.enabled).toBe(true);
      expect((result.result.index as { customIndexPass?: { enabled?: boolean } }).customIndexPass?.enabled).toBe(true);
      expect((result.result.search as { customSearchPass?: { enabled?: boolean } }).customSearchPass?.enabled).toBe(
        false,
      );
    });
  });
});

// Merged from the former tests/config-migrate.test.ts. These exercise the
// underlying core migration (src/core/config-migration) directly, as opposed to
// the CLI wrapper (src/cli/config-migrate) covered above.
describe("migrateConfigShape (core)", () => {
  test("no-op when configVersion is already '0.8.0' (no legacy keys)", () => {
    const input = { configVersion: "0.8.0", profiles: { llm: {} } };
    const { changed } = migrateConfigShapeCore(input);
    expect(changed).toBe(false);
  });

  test("migrates legacy keys even when configVersion is already 0.8.0", () => {
    const input = {
      configVersion: "0.8.0",
      llm: { endpoint: "http://x", model: "m", features: { memory_inference: true } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    expect(result.llm).toBeUndefined();
  });

  test("no-op when configVersion is a number >= 2 (legacy numeric) and no legacy keys", () => {
    const input = { configVersion: 2, stashDir: "/foo" };
    const { changed } = migrateConfigShapeCore(input as Record<string, unknown>);
    expect(changed).toBe(false);
  });

  test("empty config is a no-op (no version stamp needed)", () => {
    const { changed, result } = migrateConfigShapeCore({});
    expect(changed).toBe(false);
    expect(result.configVersion).toBeUndefined();
  });

  test("migrates llm.features.memory_inference → profiles.improve.default.processes.memoryInference.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { memory_inference: true } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
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
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { enabled?: boolean }>;
    expect(procs.graphExtraction.enabled).toBe(false);
  });

  test("migrates llm.features.feedback_distillation → profiles.improve.default.processes.distill.enabled (0.8.0 unification)", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { feedback_distillation: true } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { enabled?: boolean }>;
    expect(procs.distill.enabled).toBe(true);
    expect(procs.feedbackDistillation).toBeUndefined();
  });

  test("drops legacy llm.features.curate_rerank (removed dead feature)", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { curate_rerank: true } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const search = result.search as { curateRerank?: { enabled?: boolean } } | undefined;
    expect(search?.curateRerank).toBeUndefined();
  });

  test("migrates llm.features.metadata_enhance → index.metadataEnhance.enabled", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { metadata_enhance: false } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const index = result.index as { metadataEnhance?: { enabled?: boolean } };
    expect(index.metadataEnhance?.enabled).toBe(false);
  });

  test("migrates llm.features.lesson_quality_gate → processes.distill.qualityGate.enabled", () => {
    const input = {
      llm: { endpoint: "http://x", model: "m", features: { lesson_quality_gate: true } },
    };
    const { changed, result } = migrateConfigShapeCore(input);
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
    const { changed, result } = migrateConfigShapeCore(input);
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
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const processes = ((result.profiles as Record<string, unknown>).improve as Record<string, unknown>)
      .default as Record<string, unknown>;
    const procs = processes.processes as Record<string, { contradictionDetection?: { enabled?: boolean } }>;
    expect(procs.consolidate.contradictionDetection?.enabled).toBe(true);
  });

  test("drops legacy improve.reflectCooldownByType silently (0.8.0 removed time-based reflect cooldowns)", () => {
    const cooldown = { lesson: 7, feedback: 14 };
    const input = { improve: { reflectCooldownByType: cooldown } };
    const { result } = migrateConfigShapeCore(input);
    // No profile entry should be created from the dropped key, and the original
    // improve block is gone (the only field it carried).
    const profiles = result.profiles as Record<string, unknown> | undefined;
    const improveProfiles = profiles?.improve as Record<string, unknown> | undefined;
    const defaultProfile = improveProfiles?.default as Record<string, unknown> | undefined;
    const procs = defaultProfile?.processes as Record<string, { cooldownByType?: unknown }> | undefined;
    expect(procs?.reflect?.cooldownByType).toBeUndefined();
    expect(result.improve).toBeUndefined();
  });

  test("legacy improve.reflectCooldownByType + improve.limit: cooldown dropped, limit preserved", () => {
    const input = { improve: { reflectCooldownByType: { memory: 5 }, limit: 25 } };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    const profiles = result.profiles as Record<string, unknown>;
    const profilesImprove = profiles.improve as Record<string, unknown>;
    const defaultProfile = profilesImprove.default as Record<string, unknown>;
    expect(defaultProfile.limit).toBe(25);
    expect(result.improve).toBeUndefined();
  });

  test("migrates legacy defaults.improve object form → profiles.improve.default.limit", () => {
    const input = { defaults: { improve: { limit: 17 } } };
    const { changed, result } = migrateConfigShapeCore(input);
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
    const { changed, result } = migrateConfigShapeCore(input);
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
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    expect(result.configVersion).toBe(CURRENT_CONFIG_VERSION);
  });

  test("preserves non-migrated fields", () => {
    const input = {
      llm: { endpoint: "http://localhost:11434", model: "qwen3", features: { memory_inference: true } },
      stashDir: "/my/stash",
      semanticSearchMode: "auto",
    };
    const { result } = migrateConfigShapeCore(input);
    expect(result.stashDir).toBe("/my/stash");
    expect(result.semanticSearchMode).toBe("auto");
  });

  test("coerces semanticSearchMode boolean true → 'auto'", () => {
    const { changed, result } = migrateConfigShapeCore({ semanticSearchMode: true });
    expect(changed).toBe(true);
    expect(result.semanticSearchMode).toBe("auto");
  });

  test("coerces semanticSearchMode boolean false → 'off'", () => {
    const { changed, result } = migrateConfigShapeCore({ semanticSearchMode: false });
    expect(changed).toBe(true);
    expect(result.semanticSearchMode).toBe("off");
  });

  test("renames legacy stashes[] → sources[]", () => {
    const input = { stashes: [{ type: "filesystem", path: "/stash" }] };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    expect(result.sources).toEqual([{ type: "filesystem", path: "/stash" }]);
    expect(result.stashes).toBeUndefined();
  });

  test("stashes[] is dropped when sources[] already present", () => {
    const input = {
      stashes: [{ type: "filesystem", path: "/legacy" }],
      sources: [{ type: "filesystem", path: "/canonical" }],
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    expect(result.sources).toEqual([{ type: "filesystem", path: "/canonical" }]);
    expect(result.stashes).toBeUndefined();
  });

  test("drops openviking sources during migration", () => {
    const input = {
      sources: [
        { type: "openviking", url: "https://ov.example.com", name: "ov" },
        { type: "filesystem", path: "/keep", name: "keep" },
      ],
    };
    const { changed, result } = migrateConfigShapeCore(input);
    expect(changed).toBe(true);
    expect(result.sources).toEqual([{ type: "filesystem", path: "/keep", name: "keep" }]);
  });
});
