import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ALLOWED_TYPES,
  resolveProcessEnabled,
  shouldSkipRef,
} from "../../src/commands/improve/improve-profiles";
import { preflightImproveStrategyEngines, resolveImproveStrategy } from "../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../src/core/config/config";
import { ImproveProfileConfigSchema } from "../../src/core/config/config-schema";
import { ConfigError } from "../../src/core/errors";

const MINIMAL_CONFIG: AkmConfig = {
  semanticSearchMode: "off",
};

describe("DEFAULT_ALLOWED_TYPES", () => {
  test("reflect includes all expected markdown-canonical types", () => {
    const expected = ["agent", "command", "knowledge", "lesson", "memory", "skill", "wiki", "workflow"];
    for (const t of expected) {
      expect(DEFAULT_ALLOWED_TYPES.reflect).toContain(t);
    }
  });

  test("reflect does not include 'script'", () => {
    expect(DEFAULT_ALLOWED_TYPES.reflect).not.toContain("script");
  });

  test("distill only includes 'memory'", () => {
    expect(DEFAULT_ALLOWED_TYPES.distill).toEqual(["memory"]);
  });

  test("consolidate only includes 'memory'", () => {
    expect(DEFAULT_ALLOWED_TYPES.consolidate).toEqual(["memory"]);
  });
});

describe("resolveImproveStrategy", () => {
  test("falls back to 'default' built-in when no name given", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    expect(profile.description).toContain("Standard");
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
    expect(profile.processes?.consolidate?.enabled).toBe(true);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(true);
  });

  test("resolves named built-in 'quick'", () => {
    const profile = resolveImproveStrategy("quick", MINIMAL_CONFIG).config;
    expect(profile.description).toContain("Reflect-only");
    expect(profile.processes?.reflect?.enabled).toBe(true);
    // extract is default-ON, so "reflect-only" must disable it explicitly — else
    // `quick` runs the full session-extract backlog (~40 min) and cron timeouts
    // SIGTERM it every run (the 0.8.3 lock-leak trigger, forward-ported).
    expect(profile.processes?.extract?.enabled).toBe(false);
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(false);
    expect(profile.processes?.graphExtraction?.enabled).toBe(false);
    // Sync is enabled (consistent with every built-in): reflect can auto-accept
    // and write, so the run must commit rather than leave a silent backlog.
    // saveGitStash no-ops a clean tree, so this is free when nothing is written.
    expect(profile.sync?.enabled).toBe(true);
  });

  test("resolves named built-in 'thorough'", () => {
    const profile = resolveImproveStrategy("thorough", MINIMAL_CONFIG).config;
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
    expect(profile.processes?.consolidate?.enabled).toBe(true);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(true);
  });

  test("resolves named built-in 'memory-focus'", () => {
    const profile = resolveImproveStrategy("memory-focus", MINIMAL_CONFIG).config;
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory", "lesson"]);
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(false);
    // Sync is enabled (consistent with every built-in): reflect + memoryInference
    // both write, so the run must commit rather than leave a silent backlog.
    expect(profile.sync?.enabled).toBe(true);
  });

  test("unknown profile name throws ConfigError naming the bad profile and valid ones", () => {
    // The −96% incident class: a cron pointed at a profile that isn't a built-in
    // and isn't in config must fail LOUDLY, not silently run the default.
    let thrown: unknown;
    try {
      resolveImproveStrategy("does-not-exist", MINIMAL_CONFIG);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const err = thrown as ConfigError;
    expect(err.code).toBe("UNKNOWN_IMPROVE_STRATEGY");
    expect(err.message).toContain("does-not-exist");
    // Lists valid built-ins so the operator can self-correct.
    expect(err.message).toContain("default");
    expect(err.message).toContain("reflect-distill");
  });

  test("unknown name from defaults.improveStrategy also throws (no silent fallback)", () => {
    const config: AkmConfig = { ...MINIMAL_CONFIG, defaults: { improveStrategy: "typo-strategy" } };
    expect(() => resolveImproveStrategy(undefined, config)).toThrow(ConfigError);
  });

  // ── A1: the three profiles promoted from live config to shipped built-ins ──
  // Previously these existed ONLY in the owner's ~/.config/akm/config.json, so
  // a fresh machine running `--profile reflect-distill` would silently fall
  // back to default (proactive-off). They must now resolve without any config.
  for (const name of ["reflect-distill", "proactive-maintenance", "recombine-only"] as const) {
    test(`built-in '${name}' resolves from empty config and validates against the schema`, () => {
      const profile = resolveImproveStrategy(name, MINIMAL_CONFIG).config;
      // Loads and is a valid ImproveProfileConfig.
      expect(ImproveProfileConfigSchema.safeParse(profile).success).toBe(true);
      expect(typeof profile.description).toBe("string");
    });
  }

  test("built-in 'reflect-distill' enables the sustaining proactive-maintenance lane", () => {
    const profile = resolveImproveStrategy("reflect-distill", MINIMAL_CONFIG).config;
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
    expect(profile.processes?.proactiveMaintenance?.enabled).toBe(true);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
    // Sync off — interrupted runs would leave an uncommitted backlog (#662).
    expect(profile.sync?.enabled).toBe(false);
  });

  test("built-in 'recombine-only' enables only the recombine pass", () => {
    const profile = resolveImproveStrategy("recombine-only", MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("recombine", profile)).toBe(true);
    expect(profile.processes?.reflect?.enabled).toBe(false);
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
  });

  test("user config deep-merges on top of built-in", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      improve: {
        strategies: {
          quick: {
            description: "Custom quick",
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    const profile = resolveImproveStrategy("quick", config).config;
    // User override wins on description and reflect.allowedTypes
    expect(profile.description).toBe("Custom quick");
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory"]);
    // Distill/consolidate/etc still come from built-in quick (disabled)
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(false);
  });

  test("defaults.improveStrategy sets the default strategy name", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      defaults: {
        improveStrategy: "memory-focus",
      },
      improve: {
        strategies: {
          "memory-focus": {
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    // No name given — should pick up 'memory-focus' from defaults
    const profile = resolveImproveStrategy(undefined, config).config;
    // Deep merge: built-in memory-focus + user override
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory"]);
  });
});

describe("preflightImproveStrategyEngines", () => {
  const config: AkmConfig = {
    ...MINIMAL_CONFIG,
    engines: {
      agent: { kind: "agent", platform: "opencode" },
    },
  };

  test("ignores an incompatible engine on a default-disabled process", () => {
    expect(() =>
      preflightImproveStrategyEngines(
        { name: "custom", config: { processes: { validation: { engine: "agent" } } } },
        config,
      ),
    ).not.toThrow();
  });

  test("rejects an incompatible engine when that process is enabled", () => {
    expect(() =>
      preflightImproveStrategyEngines(
        { name: "custom", config: { processes: { validation: { enabled: true, engine: "agent" } } } },
        config,
      ),
    ).toThrow('Engine "agent" is not an LLM engine.');
  });
});

describe("shouldSkipRef", () => {
  test("script type → skip (type-filter)", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    const result = shouldSkipRef("script:deploy.sh", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("env type → skip (type-filter)", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    const result = shouldSkipRef("env:secrets/key", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("wiki:articles/raw/foo → skip (raw-wiki)", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    const result = shouldSkipRef("wiki:articles/raw/foo", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("raw-wiki");
  });

  test("wiki:articles/processed/foo → NOT skipped", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    const result = shouldSkipRef("wiki:articles/processed/foo", "reflect", profile);
    expect(result.skip).toBe(false);
  });

  test("knowledge:foo → NOT skipped by reflect", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    const result = shouldSkipRef("knowledge:foo", "reflect", profile);
    expect(result.skip).toBe(false);
  });

  test("process disabled in profile → skip (process-disabled)", () => {
    const profile = resolveImproveStrategy("quick", MINIMAL_CONFIG).config;
    // In 'quick' profile, distill is disabled
    const result = shouldSkipRef("memory:some-note", "distill", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("process-disabled");
  });

  test("custom allowedTypes: ['memory'] → knowledge skipped, memory not", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      improve: {
        strategies: {
          custom: {
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    const profile = resolveImproveStrategy("custom", config).config;

    const knowledgeResult = shouldSkipRef("knowledge:some-doc", "reflect", profile);
    expect(knowledgeResult.skip).toBe(true);
    expect(knowledgeResult.reason).toBe("type-filter");

    const memoryResult = shouldSkipRef("memory:some-note", "reflect", profile);
    expect(memoryResult.skip).toBe(false);
  });

  test("memory ref skipped by distill when distill allowedTypes excludes it (custom profile)", () => {
    // Default distill allows memory, so test with custom profile that restricts it
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      improve: {
        strategies: {
          custom: {
            processes: {
              distill: { enabled: true, allowedTypes: [] },
            },
          },
        },
      },
    };
    const profile = resolveImproveStrategy("custom", config).config;
    const result = shouldSkipRef("memory:some-note", "distill", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("wiki raw path check uses second segment after wiki name", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    // wiki:my-wiki/raw/subdir/file → raw is second segment → skip
    const r1 = shouldSkipRef("wiki:my-wiki/raw/subdir/file", "reflect", profile);
    expect(r1.skip).toBe(true);
    expect(r1.reason).toBe("raw-wiki");

    // wiki:my-wiki/content/raw/file → raw is NOT second segment → not raw-wiki skip
    const r2 = shouldSkipRef("wiki:my-wiki/content/raw/file", "reflect", profile);
    expect(r2.skip).toBe(false);
  });
});

// ── resolveProcessEnabled ────────────────────────────────────────────────────

describe("resolveProcessEnabled", () => {
  test("returns true for known process when profile explicitly enables it", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("reflect", profile)).toBe(true);
    expect(resolveProcessEnabled("distill", profile)).toBe(true);
    expect(resolveProcessEnabled("consolidate", profile)).toBe(true);
    expect(resolveProcessEnabled("memoryInference", profile)).toBe(true);
    expect(resolveProcessEnabled("graphExtraction", profile)).toBe(true);
    // 0.8.0: feedbackDistillation was unified into distill (already asserted above).
  });

  test("returns false for 'validation' (opt-in only, not in default profile)", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("validation", profile)).toBe(false);
  });

  test("returns false for unknown process names", () => {
    const profile = resolveImproveStrategy(undefined, MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("nonExistentProcess", profile)).toBe(false);
  });

  test("profile explicit false overrides IMPROVE_PROCESS_DEFAULTS true", () => {
    const profile = resolveImproveStrategy("quick", MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("distill", profile)).toBe(false);
    expect(resolveProcessEnabled("consolidate", profile)).toBe(false);
    expect(resolveProcessEnabled("memoryInference", profile)).toBe(false);
    expect(resolveProcessEnabled("graphExtraction", profile)).toBe(false);
  });

  test("profile explicit true is returned directly", () => {
    const profile = resolveImproveStrategy("quick", MINIMAL_CONFIG).config;
    expect(resolveProcessEnabled("reflect", profile)).toBe(true);
  });

  test("user override false beats builtin default true", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      improve: {
        strategies: {
          default: {
            processes: { reflect: { enabled: false } },
          },
        },
      },
    };
    const profile = resolveImproveStrategy("default", config).config;
    expect(resolveProcessEnabled("reflect", profile)).toBe(false);
  });

  test("empty profile falls back to IMPROVE_PROCESS_DEFAULTS", () => {
    expect(resolveProcessEnabled("reflect", {})).toBe(true);
    expect(resolveProcessEnabled("distill", {})).toBe(true);
    expect(resolveProcessEnabled("validation", {})).toBe(false);
    expect(resolveProcessEnabled("unknownThing", {})).toBe(false);
  });
});
