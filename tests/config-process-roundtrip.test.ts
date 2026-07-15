import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AkmConfig } from "../src/core/config/config";
import { loadConfig, resetConfigCache, saveConfig } from "../src/core/config/config";
import { ConfigError } from "../src/core/errors";
import { getConfigPath } from "../src/core/paths";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// #598 regression guard. The bug: an `akm config` rewrite silently dropped
// process-level tuning fields (consolidate.incrementalSince, minPoolSize,
// extract.minContentChars, per-process `enabled` flags) because they were not
// in the typed schema, so the load→save round trip wiped them. They are now
// first-class `ImproveProcessConfigSchema` fields (config-schema.ts). These
// tests lock the round trip AND the chosen resolution for unknown process keys:
// a hard ConfigError at load time, NOT a silent drop.

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
  resetConfigCache();
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
  resetConfigCache();
});

describe("#598 process-level config fields survive a load→save→load round trip", () => {
  test("consolidate/extract tuning fields and enabled flags are preserved", () => {
    const config = {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              consolidate: {
                enabled: true,
                incrementalSince: "4h",
                minPoolSize: 50,
                neighborsPerChanged: 3,
              },
              extract: {
                enabled: false,
                minContentChars: 200,
              },
            },
          },
        },
      },
    } as unknown as AkmConfig;

    // Persist, then drop the in-memory cache so the reload comes from disk.
    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    const consolidate = reloaded.improve?.strategies?.default?.processes?.consolidate;
    expect(consolidate?.enabled).toBe(true);
    expect(consolidate?.incrementalSince).toBe("4h");
    expect(consolidate?.minPoolSize).toBe(50);
    expect(consolidate?.neighborsPerChanged).toBe(3);

    const extract = reloaded.improve?.strategies?.default?.processes?.extract;
    expect(extract?.enabled).toBe(false);
    expect(extract?.minContentChars).toBe(200);
  });

  test("a second save (rewrite) does not drop the fields the first save persisted", () => {
    saveConfig({
      semanticSearchMode: "off",
      improve: {
        strategies: { default: { processes: { consolidate: { incrementalSince: "6h", minPoolSize: 25 } } } },
      },
    } as unknown as AkmConfig);
    resetConfigCache();

    // Mutate an unrelated field and rewrite — the original failure mode was the
    // rewrite silently clobbering the process-level tuning fields.
    const loaded = loadConfig();
    saveConfig({ ...loaded, semanticSearchMode: "auto" });
    resetConfigCache();

    const consolidate = loadConfig().improve?.strategies?.default?.processes?.consolidate;
    expect(consolidate?.incrementalSince).toBe("6h");
    expect(consolidate?.minPoolSize).toBe(25);
  });

  test("an unknown process sub-key is tolerated and preserved at load (lenient unknown-key policy)", () => {
    // Policy reversal: unknown keys are tolerated (passthrough) so cross-version
    // config skew never becomes INVALID_CONFIG_FILE. Known keys still validate.
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: {
          strategies: { default: { processes: { consolidate: { incrementalSince: "4h", bogusKey: 1 } } } },
        },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const procs = loadConfig().improve?.strategies?.default?.processes?.consolidate as Record<string, unknown>;
    expect(procs.incrementalSince).toBe("4h");
    expect(procs.bogusKey).toBe(1); // preserved, not dropped
  });

  test("#615 procedural is a RECOGNIZED process key (load does not throw; fields round-trip)", () => {
    // Regression guard: each new opt-in improve process must be added to the
    // recognized-process-key allowlist in config-schema.ts. #615 procedural was
    // shipped without it, so enabling it in a real config hard-errored at load.
    const config = {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              procedural: { enabled: true, minRecurrence: 2, maxProposalsPerRun: 5 },
            },
          },
        },
      },
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    // The bug surfaced as a ConfigError thrown here for the unrecognized key.
    expect(() => loadConfig()).not.toThrow();

    const processes = loadConfig().improve?.strategies?.default?.processes as Record<string, Record<string, unknown>>;
    expect(processes.procedural?.enabled).toBe(true);
    expect(processes.procedural?.minRecurrence).toBe(2);
    expect(processes.procedural?.maxProposalsPerRun).toBe(5);
  });

  test("WS-2 salience.outcomeWeightEnabled: true survives a load→save→load round trip", () => {
    const config = {
      semanticSearchMode: "off",
      improve: {
        salience: {
          outcomeWeightEnabled: true,
        },
      },
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    expect(reloaded.improve?.salience?.outcomeWeightEnabled).toBe(true);
  });

  test("WS-2 salience.outcomeWeightEnabled: absent default is false/undefined (no block required)", () => {
    const config = {
      semanticSearchMode: "off",
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    const salience = reloaded.improve?.salience;
    // When the salience block is absent the effective value is falsy — either
    // undefined or false. Either is acceptable; the key point is no throw.
    expect(salience?.outcomeWeightEnabled ?? false).toBe(false);
  });

  test("WS-2 unknown key under improve.salience is tolerated and preserved (lenient policy)", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: {
          salience: {
            outcomeWeightEnabled: true,
            bogus: "tolerated",
          },
        },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const salience = loadConfig().improve?.salience as Record<string, unknown>;
    expect(salience.outcomeWeightEnabled).toBe(true);
    expect(salience.bogus).toBe("tolerated");
  });

  test("WS-3a: cosineCandidateLimit and p90ChunkSecondsDefault survive a round trip and are not rejected", () => {
    // Regression guard: both fields were added to the TS types but NOT to the
    // Zod schema initially (WS-3a review blocker). Any user who set them in a
    // config file got a hard config-validation error. This test ensures both
    // fields round-trip cleanly through load → save → reload.
    const config = {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              consolidate: {
                enabled: true,
                p90ChunkSecondsDefault: 45,
                dedup: {
                  enabled: true,
                  cosineThreshold: 0.95,
                  cosineCandidateLimit: 300,
                },
              },
            },
          },
        },
      },
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();

    const consolidate = reloaded.improve?.strategies?.default?.processes?.consolidate;
    expect(consolidate?.p90ChunkSecondsDefault).toBe(45);
    expect(consolidate?.dedup?.cosineCandidateLimit).toBe(300);
    expect(consolidate?.dedup?.cosineThreshold).toBeCloseTo(0.95);
    expect(consolidate?.dedup?.enabled).toBe(true);
  });

  test("WS-4 improve.exploration: enabled + budgetFraction survive a load→save→load round trip", () => {
    const config: AkmConfig = {
      semanticSearchMode: "off",
      improve: {
        exploration: { enabled: true, budgetFraction: 0.08 },
      },
    };
    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();
    expect(reloaded.improve?.exploration?.enabled).toBe(true);
    expect(reloaded.improve?.exploration?.budgetFraction).toBeCloseTo(0.08);
  });

  test("WS-4 improve.exploration: absent default is undefined (no block required)", () => {
    const config: AkmConfig = { semanticSearchMode: "off" };
    saveConfig(config);
    resetConfigCache();
    const reloaded = loadConfig();
    expect(reloaded.improve?.exploration).toBeUndefined();
  });

  test("#624 P2 graphExtraction.topN survives a load→save→load round trip (locks .strict() schema registration)", () => {
    // RED: topN is not yet declared on ImproveProcessConfigSchema (.strict()),
    // so a config carrying processes.graphExtraction.topN currently HARD-ERRORS
    // at load. This test locks that the new field is registered in BOTH
    // config-types.ts and config-schema.ts and survives the round trip.
    const config = {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              graphExtraction: { enabled: true, topN: 50 },
            },
          },
        },
      },
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();

    const processes = loadConfig().improve?.strategies?.default?.processes as Record<string, Record<string, unknown>>;
    expect(processes.graphExtraction?.topN).toBe(50);
  });

  test("#624 P3 index.graph.lazyGraphExtraction true/false both survive a load→save→load round trip", () => {
    // RED (CLAUDE.md registration guard): lazyGraphExtraction is not yet a
    // recognized per-pass key, so a config carrying index.graph.lazyGraphExtraction
    // currently HARD-ERRORS at load (IndexPassConfigSchema.strict()). This locks
    // that the new field is registered in BOTH config-types.ts (IndexPassConfig)
    // and config-schema.ts (INDEX_PASS_KNOWN_KEYS + z.object + help string), for
    // both `true` and `false`.
    for (const value of [true, false]) {
      const config = {
        semanticSearchMode: "off",
        index: { graph: { lazyGraphExtraction: value } },
      } as unknown as AkmConfig;

      saveConfig(config);
      resetConfigCache();
      expect(() => loadConfig()).not.toThrow();

      const graph = loadConfig().index?.graph as Record<string, unknown> | undefined;
      expect(graph?.lazyGraphExtraction).toBe(value);
      resetConfigCache();
    }
  });

  test("#624 P2 graphExtraction.topN known key validates; unknown sibling tolerated (lenient policy)", () => {
    // topN (known) round-trips; an unknown sibling is now tolerated rather than
    // rejected — known keys are still type-checked.
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: {
          strategies: { default: { processes: { graphExtraction: { topN: 10, bogusGraphKey: 1 } } } },
        },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const gx = loadConfig().improve?.strategies?.default?.processes?.graphExtraction as Record<string, unknown>;
    expect(gx.topN).toBe(10);
    expect(gx.bogusGraphKey).toBe(1);
  });

  test("WS-4 unknown key under improve.exploration is tolerated and preserved (lenient policy)", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: {
          exploration: {
            enabled: true,
            bogus: "tolerated",
          },
        },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const exploration = loadConfig().improve?.exploration as Record<string, unknown>;
    expect(exploration.enabled).toBe(true);
    expect(exploration.bogus).toBe("tolerated");
  });

  test("#616 improve.strategies.<strategy>.maxCycles survives a load→save→load round trip (positiveInt)", () => {
    // RED (#616 bounded multi-cycle phasing): maxCycles is not yet declared on
    // ImproveProfileConfig (config-types.ts) nor ImproveProfileConfigSchema
    // (config-schema.ts, .strict()), so a config carrying it currently
    // HARD-ERRORS at load. This locks that the new per-profile field is
    // registered in BOTH places and round-trips cleanly.
    const config = {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: { maxCycles: 3 },
        },
      },
    } as unknown as AkmConfig;

    saveConfig(config);
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();

    const reloaded = loadConfig();
    expect((reloaded.improve?.strategies?.default as { maxCycles?: number } | undefined)?.maxCycles).toBe(3);
  });

  test("#616 maxCycles=0 is rejected by the schema at load (positiveInt forbids 0/negative)", () => {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: { strategies: { default: { maxCycles: 0 } } },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

// Config audit 0.9.0 — schema/type drift closure. These four knobs previously
// existed only in the TS type (or only in the schema), riding `.passthrough()`
// without validation, because the Zod schema and the hand-written interface were
// two hand-synced sources of truth. The interfaces are now DERIVED from the
// schema via `z.infer` (config-types.ts) and the missing fields were added to
// the schema (config-schema.ts). These tests lock that each is a first-class,
// VALIDATED field — round-tripping when valid AND rejected when mistyped.
describe("config audit 0.9.0: previously-drifted knobs are now schema-validated", () => {
  test("graphExtraction.fullScan round-trips (was TS-only)", () => {
    saveConfig({
      semanticSearchMode: "off",
      improve: { strategies: { default: { processes: { graphExtraction: { enabled: true, fullScan: true } } } } },
    } as unknown as AkmConfig);
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const gx = loadConfig().improve?.strategies?.default?.processes?.graphExtraction;
    expect(gx?.fullScan).toBe(true);
  });

  test("extract.triage { enabled, minScore } round-trips (was TS-only)", () => {
    saveConfig({
      semanticSearchMode: "off",
      improve: {
        strategies: { default: { processes: { extract: { enabled: true, triage: { enabled: true, minScore: 3 } } } } },
      },
    } as unknown as AkmConfig);
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    const extract = loadConfig().improve?.strategies?.default?.processes?.extract;
    expect(extract?.triage?.enabled).toBe(true);
    expect(extract?.triage?.minScore).toBe(3);
  });

  test("processes.extract is now a VALIDATED process — a mistyped known field is rejected (closes C2)", () => {
    // Before the fix `extract` was absent from ImproveProfileProcessesSchema, so
    // the whole block rode top-level passthrough and `minNewSessions: "lots"`
    // was silently accepted. It must now hard-error at load.
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        improve: { strategies: { default: { processes: { extract: { minNewSessions: "lots" } } } } },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("agent engine timeoutMs round-trips (number) and rejects a mistyped value", () => {
    saveConfig({
      semanticSearchMode: "off",
      engines: { opencode: { kind: "agent", platform: "opencode", timeoutMs: 120000 } },
    } as unknown as AkmConfig);
    resetConfigCache();
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig().engines?.opencode?.timeoutMs).toBe(120000);

    // A string timeoutMs must now be rejected (it is a known, typed field).
    const configPath = getConfigPath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        engines: { opencode: { kind: "agent", platform: "opencode", timeoutMs: "soon" } },
      }),
    );
    resetConfigCache();
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

// saveConfig is the whole-config validation gate that runs the cross-field
// superRefine GUARDS (not just leaf checks). This is what stops an `akm config
// set` — leaf OR object form — from persisting a guard-violating value (e.g.
// re-introducing the removed `feedbackDistillation` process key via an
// object-valued set, which the per-leaf walker schema alone would let through).
// Lock that the guard fires at save so it can never silently regress.
describe("config audit 0.9.0: saveConfig runs superRefine guards (object-form set cannot bypass)", () => {
  test("saveConfig rejects the removed feedbackDistillation process key with the migration hint", () => {
    expect(() =>
      saveConfig({
        semanticSearchMode: "off",
        improve: { strategies: { default: { processes: { feedbackDistillation: { enabled: true } } } } },
      } as unknown as AkmConfig),
    ).toThrow(/feedbackDistillation was removed/);
  });

  test("saveConfig rejects writable: true on a non-filesystem/git source (superRefine)", () => {
    expect(() =>
      saveConfig({
        semanticSearchMode: "off",
        sources: [{ type: "website", name: "docs", url: "https://example.com", writable: true }],
      } as unknown as AkmConfig),
    ).toThrow(ConfigError);
  });
});
