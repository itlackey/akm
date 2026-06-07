import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ALLOWED_TYPES,
  resolveImproveProfile,
  resolveProcessEnabled,
  shouldSkipRef,
} from "../../src/commands/improve/improve-profiles";
import type { AkmConfig } from "../../src/core/config";

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

describe("resolveImproveProfile", () => {
  test("falls back to 'default' built-in when no name given", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    expect(profile.description).toContain("Standard");
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
    expect(profile.processes?.consolidate?.enabled).toBe(true);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(true);
  });

  test("resolves named built-in 'quick'", () => {
    const profile = resolveImproveProfile("quick", MINIMAL_CONFIG);
    expect(profile.description).toContain("Reflect-only");
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(false);
    expect(profile.processes?.graphExtraction?.enabled).toBe(false);
    // Lightweight pass opts out of end-of-run auto-sync (no surprise commit/push).
    expect(profile.sync?.enabled).toBe(false);
  });

  test("resolves named built-in 'thorough'", () => {
    const profile = resolveImproveProfile("thorough", MINIMAL_CONFIG);
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
    expect(profile.processes?.consolidate?.enabled).toBe(true);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(true);
  });

  test("resolves named built-in 'memory-focus'", () => {
    const profile = resolveImproveProfile("memory-focus", MINIMAL_CONFIG);
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory", "lesson"]);
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.consolidate?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(true);
    expect(profile.processes?.graphExtraction?.enabled).toBe(false);
    // Limited pass opts out of end-of-run auto-sync (no surprise commit/push).
    expect(profile.sync?.enabled).toBe(false);
  });

  test("unknown name falls back to default built-in", () => {
    const profile = resolveImproveProfile("does-not-exist", MINIMAL_CONFIG);
    // Falls back to 'default' built-in
    expect(profile.processes?.reflect?.enabled).toBe(true);
    expect(profile.processes?.distill?.enabled).toBe(true);
  });

  test("user config deep-merges on top of built-in", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      profiles: {
        improve: {
          quick: {
            description: "Custom quick",
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    const profile = resolveImproveProfile("quick", config);
    // User override wins on description and reflect.allowedTypes
    expect(profile.description).toBe("Custom quick");
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory"]);
    // Distill/consolidate/etc still come from built-in quick (disabled)
    expect(profile.processes?.distill?.enabled).toBe(false);
    expect(profile.processes?.memoryInference?.enabled).toBe(false);
  });

  test("config.defaults.improve sets default profile name", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      defaults: {
        improve: "memory-focus",
      },
      profiles: {
        improve: {
          "memory-focus": {
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    // No name given — should pick up 'memory-focus' from defaults
    const profile = resolveImproveProfile(undefined, config);
    // Deep merge: built-in memory-focus + user override
    expect(profile.processes?.reflect?.allowedTypes).toEqual(["memory"]);
  });
});

describe("shouldSkipRef", () => {
  test("script type → skip (type-filter)", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    const result = shouldSkipRef("script:deploy.sh", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("env type → skip (type-filter)", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    const result = shouldSkipRef("env:secrets/key", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("wiki:articles/raw/foo → skip (raw-wiki)", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    const result = shouldSkipRef("wiki:articles/raw/foo", "reflect", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("raw-wiki");
  });

  test("wiki:articles/processed/foo → NOT skipped", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    const result = shouldSkipRef("wiki:articles/processed/foo", "reflect", profile);
    expect(result.skip).toBe(false);
  });

  test("knowledge:foo → NOT skipped by reflect", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    const result = shouldSkipRef("knowledge:foo", "reflect", profile);
    expect(result.skip).toBe(false);
  });

  test("process disabled in profile → skip (process-disabled)", () => {
    const profile = resolveImproveProfile("quick", MINIMAL_CONFIG);
    // In 'quick' profile, distill is disabled
    const result = shouldSkipRef("memory:some-note", "distill", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("process-disabled");
  });

  test("custom allowedTypes: ['memory'] → knowledge skipped, memory not", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      profiles: {
        improve: {
          custom: {
            processes: {
              reflect: { enabled: true, allowedTypes: ["memory"] },
            },
          },
        },
      },
    };
    const profile = resolveImproveProfile("custom", config);

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
      profiles: {
        improve: {
          custom: {
            processes: {
              distill: { enabled: true, allowedTypes: [] },
            },
          },
        },
      },
    };
    const profile = resolveImproveProfile("custom", config);
    const result = shouldSkipRef("memory:some-note", "distill", profile);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe("type-filter");
  });

  test("wiki raw path check uses second segment after wiki name", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
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
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    expect(resolveProcessEnabled("reflect", profile)).toBe(true);
    expect(resolveProcessEnabled("distill", profile)).toBe(true);
    expect(resolveProcessEnabled("consolidate", profile)).toBe(true);
    expect(resolveProcessEnabled("memoryInference", profile)).toBe(true);
    expect(resolveProcessEnabled("graphExtraction", profile)).toBe(true);
    // 0.8.0: feedbackDistillation was unified into distill (already asserted above).
  });

  test("returns false for 'validation' (opt-in only, not in default profile)", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    expect(resolveProcessEnabled("validation", profile)).toBe(false);
  });

  test("returns false for unknown process names", () => {
    const profile = resolveImproveProfile(undefined, MINIMAL_CONFIG);
    expect(resolveProcessEnabled("nonExistentProcess", profile)).toBe(false);
  });

  test("profile explicit false overrides IMPROVE_PROCESS_DEFAULTS true", () => {
    const profile = resolveImproveProfile("quick", MINIMAL_CONFIG);
    expect(resolveProcessEnabled("distill", profile)).toBe(false);
    expect(resolveProcessEnabled("consolidate", profile)).toBe(false);
    expect(resolveProcessEnabled("memoryInference", profile)).toBe(false);
    expect(resolveProcessEnabled("graphExtraction", profile)).toBe(false);
  });

  test("profile explicit true is returned directly", () => {
    const profile = resolveImproveProfile("quick", MINIMAL_CONFIG);
    expect(resolveProcessEnabled("reflect", profile)).toBe(true);
  });

  test("user override false beats builtin default true", () => {
    const config: AkmConfig = {
      ...MINIMAL_CONFIG,
      profiles: {
        improve: {
          default: {
            processes: { reflect: { enabled: false } },
          },
        },
      },
    };
    const profile = resolveImproveProfile("default", config);
    expect(resolveProcessEnabled("reflect", profile)).toBe(false);
  });

  test("empty profile falls back to IMPROVE_PROCESS_DEFAULTS", () => {
    expect(resolveProcessEnabled("reflect", {})).toBe(true);
    expect(resolveProcessEnabled("distill", {})).toBe(true);
    expect(resolveProcessEnabled("validation", {})).toBe(false);
    expect(resolveProcessEnabled("unknownThing", {})).toBe(false);
  });
});
