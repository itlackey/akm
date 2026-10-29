// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import {
  type ImproveProcessName,
  projectResolvedProcessRouting,
  resolveImprovePlan,
  resolveImproveStrategy,
  shouldSkipRef,
} from "../src/commands/improve/improve-strategies";
import type { AkmConfig, ImproveProfileConfig } from "../src/core/config/config";
import { deepMergeConfig } from "../src/core/config/deep-merge";
import { ConfigError } from "../src/core/errors";
import { asLlmRunner } from "./_helpers/llm-runner";
import { withEnvSync } from "./_helpers/sandbox";

// The built-in `quick` and `reflect-distill` strategies were removed (#1130).
// These are their old definitions as user-defined strategies, so the tests
// below keep exercising the same process shapes through `improve.strategies`.
const QUICK = {
  processes: {
    reflect: { enabled: true },
    extract: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    triage: { enabled: false },
    validation: { enabled: false },
    proactiveMaintenance: { enabled: false },
  },
};
const REFLECT_DISTILL = {
  processes: {
    consolidate: { enabled: false },
    validation: { enabled: false },
    triage: { enabled: true, applyMode: "promote", maxAcceptsPerRun: 15, judgment: true },
  },
};
/** `base` with `overrides` deep-merged on top, typed as an `improve.strategies` entry. */
function strategy(base: object, overrides: object = {}): ImproveProfileConfig {
  return deepMergeConfig(base as never, overrides as never) as ImproveProfileConfig;
}

describe("resolveImproveStrategy", () => {
  test("deep-merges the default baseline, selected built-in, and user override in order", () => {
    const selected = resolveImproveStrategy("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      improve: {
        strategies: {
          quick: strategy(QUICK, { processes: { reflect: { enabled: false, allowedTypes: ["memory"] } } }),
        },
      },
    });

    expect(selected.name).toBe("quick");
    expect(selected.config.processes?.reflect).toMatchObject({ enabled: false, allowedTypes: ["memory"] });
    expect(selected.config.processes?.distill).toBeDefined();
    expect(selected.config.processes?.validation?.enabled).toBe(false);
    expect(selected.config.processes?.proactiveMaintenance?.enabled).toBe(false);
  });

  test("explicit user opt-ins override inherited built-in process defaults", () => {
    const defaultStrategy = resolveImproveStrategy("default", {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              extract: { enabled: true },
              proactiveMaintenance: { enabled: true },
            },
          },
        },
      },
    });
    const quick = resolveImproveStrategy("quick", {
      semanticSearchMode: "off",
      improve: {
        strategies: { quick: strategy(QUICK, { processes: { extract: { enabled: true } } }) },
      },
    });
    const reflectDistill = resolveImproveStrategy("reflect-distill", {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          "reflect-distill": strategy(REFLECT_DISTILL, { processes: { proactiveMaintenance: { enabled: true } } }),
        },
      },
    });

    expect(defaultStrategy.config.processes?.extract?.enabled).toBe(true);
    expect(defaultStrategy.config.processes?.proactiveMaintenance?.enabled).toBe(true);
    expect(quick.config.processes?.extract?.enabled).toBe(true);
    expect(reflectDistill.config.processes?.proactiveMaintenance?.enabled).toBe(true);
  });

  test("uses improve.strategy before the built-in default", () => {
    const selected = resolveImproveStrategy(undefined, {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      improve: { strategy: "quick", strategies: { quick: strategy(QUICK) } },
    });
    expect(selected.name).toBe("quick");
  });

  test("rejects an unknown strategy instead of silently falling back", () => {
    expect(() =>
      resolveImproveStrategy("does-not-exist", { configVersion: "0.9.0", semanticSearchMode: "auto" }),
    ).toThrow(ConfigError);
  });

  test("names the retirement when a task or config still selects graph-refresh (0.9.17-alpha.9)", () => {
    expect(() =>
      resolveImproveStrategy("graph-refresh", { configVersion: "0.9.0", semanticSearchMode: "auto" }),
    ).toThrow(/graph-refresh.*retired/i);
  });

  test("graph-refresh is refused even when a leftover improve.strategies override exists — never silently resolved as a custom strategy", () => {
    // A leftover `improve.strategies["graph-refresh"]` override is a partial
    // patch of the deleted built-in (e.g. just `processes.graphExtraction`),
    // not a full strategy definition. Resolving it as a new custom strategy
    // would silently merge it onto `default` and run every process `default`
    // enables — a full, unplanned improve pass the operator never asked for.
    expect(() =>
      resolveImproveStrategy("graph-refresh", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { "graph-refresh": { processes: { reflect: { enabled: true } } } } },
      }),
    ).toThrow(/graph-refresh.*retired/i);
  });

  test("the retirement message names the leftover override so `akm migrate apply` is the obvious next step", () => {
    expect(() =>
      resolveImproveStrategy("graph-refresh", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { "graph-refresh": { processes: { reflect: { enabled: true } } } } },
      }),
    ).toThrow(/leftover.*akm migrate apply/i);
  });

  test("the retirement message omits the leftover-override sentence when no override exists", () => {
    try {
      resolveImproveStrategy("graph-refresh", { configVersion: "0.9.0", semanticSearchMode: "auto" });
      throw new Error("expected resolveImproveStrategy to throw");
    } catch (err) {
      expect(String(err)).not.toMatch(/leftover/i);
    }
  });
});

// WIKI (R12): reflect's excludeRefPrefixes filter keeps raw wiki-ingest
// snapshots (type `knowledge`, so allowedTypes alone can't exclude them) out
// of reflect without affecting distill/consolidate.
describe("shouldSkipRef excludeRefPrefixes (reflect only)", () => {
  function strategyWithExcluded(excludeRefPrefixes: string[]) {
    return resolveImproveStrategy("default", {
      semanticSearchMode: "off",
      improve: { strategies: { default: { processes: { reflect: { excludeRefPrefixes } } } } },
    }).config;
  }

  test("skips a ref under an excluded prefix with reason exclude-filter", () => {
    const strategy = strategyWithExcluded(["knowledge/wikis/articles/raw"]);
    expect(shouldSkipRef("knowledge/wikis/articles/raw/some-page", "reflect", strategy)).toEqual({
      skip: true,
      reason: "exclude-filter",
    });
  });

  test("matches both bundle-qualified and short forms", () => {
    const strategy = strategyWithExcluded(["stash//knowledge/wikis/articles/raw"]);
    expect(shouldSkipRef("knowledge/wikis/articles/raw/some-page", "reflect", strategy).skip).toBe(true);
    expect(shouldSkipRef("stash//knowledge/wikis/articles/raw/some-page", "reflect", strategy).skip).toBe(true);
  });

  test("a trailing slash on the prefix still excludes both short and bundle-qualified refs", () => {
    const strategy = strategyWithExcluded(["knowledge/wikis/articles/raw/"]);
    expect(shouldSkipRef("knowledge/wikis/articles/raw/some-page", "reflect", strategy).skip).toBe(true);
    expect(shouldSkipRef("stash//knowledge/wikis/articles/raw/some-page", "reflect", strategy).skip).toBe(true);
  });

  test("a partial-segment prefix does not match a longer segment", () => {
    const strategy = strategyWithExcluded(["knowledge/wikis/articles/ra"]);
    expect(shouldSkipRef("knowledge/wikis/articles/raw/some-page", "reflect", strategy).skip).toBe(false);
  });

  test("leaves other refs unaffected", () => {
    const strategy = strategyWithExcluded(["knowledge/wikis/articles/raw"]);
    const result = shouldSkipRef("knowledge/guides/http-caching", "reflect", strategy);
    expect(result.skip).toBe(false);
  });

  test("does not apply the filter to distill", () => {
    const strategy = resolveImproveStrategy("default", {
      semanticSearchMode: "off",
      improve: {
        strategies: {
          default: {
            processes: {
              distill: { allowedTypes: ["memory", "knowledge"] },
              reflect: { excludeRefPrefixes: ["knowledge/wikis/articles/raw"] },
            },
          },
        },
      },
    }).config;
    const result = shouldSkipRef("knowledge/wikis/articles/raw/some-page", "distill", strategy);
    expect(result.skip).toBe(false);
  });
});

describe("resolveImprovePlan", () => {
  const lab = { endpoint: "https://example.test/v1/chat/completions", models: { fast: "base" } };

  test("resolves one frozen fallback connection for every enabled process before dispatch", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      connections: { default: lab, validation: { ...lab, models: { fast: "repair" } } },
      improve: {
        processes: { validation: { connection: "validation" } },
        strategies: { quick: strategy(QUICK, { processes: { validation: { enabled: true } } }) },
      },
    });

    expect(plan.strategy.name).toBe("quick");
    expect(plan.processes.reflect.runner?.name).toBe("default");
    expect(plan.processes.validation.runner?.name).toBe("validation");
    expect(asLlmRunner(plan.processes.validation.runner).model).toBe("repair");
    expect(plan.processes.distill).toMatchObject({ enabled: false, runner: null });
    expect(Object.keys(plan.processes).sort()).toEqual([
      "consolidate",
      "distill",
      "extract",
      "memoryInference",
      "proactiveMaintenance",
      "reflect",
      "triage",
      "validation",
    ]);
    expect(Object.isFrozen(plan.processes)).toBe(true);
    expect(Object.isFrozen(plan.processes.reflect.config)).toBe(true);
  });

  test("preflights every enabled model-backed process and deeply freezes nested behavior", () => {
    const config: AkmConfig = {
      configVersion: "0.9.0",
      semanticSearchMode: "off",
      connections: { default: lab },
      // D8 — `consolidate` and `memoryInference` are only *enabled* when autonomy
      // is opted into; without this the gate disables them and they resolve no
      // runner, which is the gate working rather than the preflight failing.
      experimental: { improveAutonomy: true },
      improve: {
        strategies: {
          all: {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
              consolidate: { enabled: true },
              memoryInference: { enabled: true },
              extract: { enabled: true, triage: { enabled: true } },
              validation: { enabled: true },
            },
          },
        },
      },
    };
    const plan = resolveImprovePlan("all", config);
    for (const name of ["reflect", "distill", "consolidate", "memoryInference", "extract", "validation"] as const) {
      expect(plan.processes[name].runner?.name).toBe("default");
    }
    expect(Object.isFrozen(plan.processes.extract.config.triage)).toBe(true);
    const sourceExtract = config.improve?.strategies?.all?.processes?.extract;
    if (sourceExtract?.triage) sourceExtract.triage.enabled = false;
    expect(plan.processes.extract.config.triage?.enabled).toBe(true);
  });

  test("retains symbolic credentials in the frozen improve plan", () => {
    withEnvSync({ IMPROVE_PLAN_API_KEY: "plan-secret-sentinel" }, () => {
      const plan = resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "off",
        connections: { default: { ...lab, apiKey: "$IMPROVE_PLAN_API_KEY" } },
        improve: { strategies: { quick: strategy(QUICK) } },
      });

      expect(asLlmRunner(plan.processes.reflect.runner).apiKey).toBe("$IMPROVE_PLAN_API_KEY");
      expect(JSON.stringify(plan)).not.toContain("plan-secret-sentinel");
    });
  });

  test("preflights default fallbacks and accepts a harness triage judgment", () => {
    const plan = resolveImprovePlan("reflect-distill", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      connections: { default: lab },
      harnesses: { reviewer: { platform: "claude", models: { fast: "review" } } },
      improve: {
        processes: { triage: { harness: "reviewer", timeoutMs: null } },
        strategies: { "reflect-distill": strategy(REFLECT_DISTILL) },
      },
    });

    expect(plan.processes.reflect.runner?.name).toBe("default");
    expect(plan.processes.distill.runner?.name).toBe("default");
    expect(plan.triageJudgment?.kind).toBe("harness");
    expect(plan.triageJudgment?.timeoutMs).toBeNull();
  });

  test("requires an explicit judgment block before folded improve enables judgment", () => {
    const plan = resolveImprovePlan("no-judgment", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      connections: { default: lab },
      improve: { strategies: { "no-judgment": { processes: { triage: { enabled: true } } } } },
    });

    expect(plan.triageJudgment).toBeNull();
  });

  test("the triage judgment runs where improve.processes.triage says, else improve-wide, else the default by name", () => {
    const base = {
      configVersion: "0.9.0" as const,
      semanticSearchMode: "auto" as const,
      connections: {
        default: { ...lab, models: { fast: "default" } },
        wide: { ...lab, models: { fast: "wide" } },
        near: { ...lab, models: { fast: "near" } },
      },
      harnesses: { reviewer: { platform: "claude" as const, models: { fast: "agent-base" } } },
    };
    const judging = { precedence: { processes: { triage: { enabled: true, judgment: {} } } } };

    const process = resolveImprovePlan("precedence", {
      ...base,
      improve: { connection: "wide", processes: { triage: { connection: "near" } }, strategies: judging },
    });
    expect(process.triageJudgment).toMatchObject({ kind: "connection", name: "near" });

    const harness = resolveImprovePlan("precedence", {
      ...base,
      improve: {
        connection: "wide",
        processes: { triage: { harness: "reviewer", model: "agent-override", timeoutMs: null } },
        strategies: judging,
      },
    });
    expect(harness.triageJudgment).toMatchObject({
      kind: "harness",
      name: "reviewer",
      timeoutMs: null,
      model: "agent-override",
    });

    const wide = resolveImprovePlan("precedence", {
      ...base,
      improve: { connection: "wide", strategies: judging },
    });
    expect(wide.triageJudgment).toMatchObject({ kind: "connection", name: "wide" });

    const fallback = resolveImprovePlan("precedence", { ...base, improve: { strategies: judging } });
    expect(fallback.triageJudgment).toMatchObject({ kind: "connection", name: "default" });
  });

  test("rejects a model-only selection before dispatch", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: {
          processes: { reflect: { model: "model-without-connection" } },
          strategies: { quick: strategy(QUICK) },
        },
      }),
    ).toThrow('"reflect" requires a connection or harness that is not configured');
  });

  test("a harness that cannot confine the policy still runs model work", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      harnesses: { wrong: { platform: "pi" } },
      improve: { strategies: { quick: strategy(QUICK) } },
    });
    expect(plan.processes.reflect.runner).toMatchObject({ kind: "harness", name: "wrong" });
    expect(plan.engineUnavailable).toEqual([]);
  });

  test("a harness that confines the policy runs model work", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      harnesses: { agent: { platform: "claude" } },
      improve: { strategies: { quick: strategy(QUICK) } },
    });
    expect(plan.processes.reflect.runner).toMatchObject({ kind: "harness", name: "agent" });
    expect(plan.engineUnavailable).toEqual([]);
  });

  test("rejects an enabled model-backed process with no runner even when no model fields express intent", () => {
    expect(() =>
      resolveImprovePlan("quick", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        improve: { strategies: { quick: strategy(QUICK) } },
      }),
    ).toThrow('"reflect" requires a connection or harness that is not configured');
  });

  test("a plan in which no process that calls a model can run stops at planning, whatever else is enabled (#1129)", () => {
    // Triage (deterministic, #1143) and proactiveMaintenance need no connection or harness, and keep nothing alive:
    // a run that could only do those would index, skip everything and look like success.
    for (const triage of [true, false]) {
      expect(() =>
        resolveImprovePlan("default", {
          configVersion: "0.9.0",
          semanticSearchMode: "auto",
          improve: { strategies: { default: { processes: { triage: { enabled: triage } } } } },
        } as AkmConfig),
      ).toThrow("No improve process can run");
    }
  });

  test("disables just the processes with no connection or harness, instead of aborting the whole plan", () => {
    // Validation without its repair step calls no model, so it keeps the plan alive; the processes that do are disabled.
    const plan = resolveImprovePlan(
      "default",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        experimental: { improveAutonomy: true },
        improve: { strategies: { default: { processes: { triage: { enabled: true } } } } },
      } as AkmConfig,
      { repairValidationFailures: false },
    );

    for (const name of ["reflect", "distill", "consolidate", "memoryInference"] as const) {
      expect(plan.processes[name].enabled).toBe(false);
      expect(plan.processes[name].runner).toBeNull();
      expect(plan.strategy.config.processes?.[name]?.enabled).toBe(false);
    }
    expect(plan.processes.triage.enabled).toBe(true);
    expect(plan.processes.validation.enabled).toBe(true);

    const disabledNames: string[] = plan.engineUnavailable.map((item) => item.process).sort();
    expect(disabledNames).toEqual((["consolidate", "distill", "memoryInference", "reflect"] as string[]).sort());
    for (const item of plan.engineUnavailable) {
      expect(item.configKey).toBe(`improve.processes.${item.process}.connection`);
      expect(item.reason).toContain("akm setup");
    }
  });

  test("does not require a validation connection when repair is disabled", () => {
    const plan = resolveImprovePlan(
      "default",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        connections: { default: lab },
      },
      { repairValidationFailures: false },
    );
    expect(plan.processes.reflect.runner?.name).toBe("default");
    expect(plan.processes.validation).toMatchObject({ enabled: true, runner: null });
  });

  test("a harness triage judgment takes llm overrides as inference it reports untranslated", () => {
    const plan = resolveImprovePlan("reflect-distill", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      connections: { default: lab },
      harnesses: { reviewer: { platform: "claude" } },
      improve: {
        processes: { triage: { harness: "reviewer", llm: { temperature: 0 } } },
        strategies: { "reflect-distill": strategy(REFLECT_DISTILL) },
      },
    });
    expect(plan.triageJudgment).toMatchObject({ kind: "harness", name: "reviewer" });
    expect(plan.triageJudgmentNotices).toContainEqual(
      expect.objectContaining({ code: "untranslated-field", adapter: "claude", field: "inference.temperature" }),
    );
  });
});

describe("projectResolvedProcessRouting (#947)", () => {
  const lab = { endpoint: "https://example.test/v1/chat/completions", models: { fast: "base" } };

  test("one row per IMPROVE_PROCESS_NAMES name, connection/model only for resolved processes", () => {
    const plan = resolveImprovePlan("quick", {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      connections: { default: lab, validation: { ...lab, models: { fast: "repair" } } },
      improve: {
        processes: { validation: { connection: "validation" } },
        strategies: { quick: strategy(QUICK, { processes: { validation: { enabled: true } } }) },
      },
    });

    const rows = projectResolvedProcessRouting(plan);
    const expectedProcesses: ImproveProcessName[] = [
      "reflect",
      "distill",
      "consolidate",
      "memoryInference",
      "extract",
      "validation",
      "triage",
      "proactiveMaintenance",
    ];
    expect(rows.map((row) => row.process).sort()).toEqual(expectedProcesses.sort());

    const reflect = rows.find((row) => row.process === "reflect");
    expect(reflect).toMatchObject({ enabled: true, engine: "default", model: "base", engineKind: "connection" });
    expect(reflect?.notices).toEqual([]);

    const validation = rows.find((row) => row.process === "validation");
    expect(validation).toMatchObject({ enabled: true, engine: "validation", model: "repair" });

    const distill = rows.find((row) => row.process === "distill");
    expect(distill).toMatchObject({ enabled: false });
    expect(distill?.engine).toBeUndefined();

    // Nothing unavailable and no triage.judgment configured.
    expect(rows.every((row) => row.unavailable === undefined)).toBe(true);
    expect(rows.some((row) => row.process === "triage.judgment")).toBe(false);
  });

  test("unresolved processes land in `unavailable` naming the configKey and reason", () => {
    const plan = resolveImprovePlan(
      "default",
      {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        experimental: { improveAutonomy: true },
        improve: { strategies: { default: { processes: { triage: { enabled: true } } } } },
      } as AkmConfig,
      { repairValidationFailures: false },
    );

    const rows = projectResolvedProcessRouting(plan);
    const reflect = rows.find((row) => row.process === "reflect");
    expect(reflect?.enabled).toBe(false);
    expect(reflect?.engine).toBeUndefined();
    expect(reflect?.unavailable?.configKey).toBe("improve.processes.reflect.connection");
    expect(reflect?.unavailable?.reason).toContain("akm setup");
  });

  test("includes a triage.judgment row only when judgment is configured, with its own engineKind", () => {
    const withoutJudgment = projectResolvedProcessRouting(
      resolveImprovePlan("no-judgment", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        connections: { default: lab },
        improve: { strategies: { "no-judgment": { processes: { triage: { enabled: true } } } } },
      }),
    );
    expect(withoutJudgment.some((row) => row.process === "triage.judgment")).toBe(false);

    const withJudgment = projectResolvedProcessRouting(
      resolveImprovePlan("reflect-distill", {
        configVersion: "0.9.0",
        semanticSearchMode: "auto",
        connections: { default: lab },
        harnesses: { reviewer: { platform: "claude", models: { balanced: "review" } } },
        improve: {
          processes: { triage: { harness: "reviewer", timeoutMs: null } },
          strategies: { "reflect-distill": strategy(REFLECT_DISTILL) },
        },
      }),
    );
    const judgmentRow = withJudgment.find((row) => row.process === "triage.judgment");
    expect(judgmentRow).toMatchObject({ enabled: true, engine: "reviewer", engineKind: "harness", model: "review" });
  });
});
