// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../src/core/config/config";
import {
  ImproveProcessConfigSchema,
  TriageProcessConfigSchema,
  validateConfigShape,
} from "../src/core/config/config-schema";
import { configGet, configSet, configUnset } from "../src/core/config/config-walker";

const llm = {
  kind: "llm" as const,
  endpoint: "https://example.test/v1/chat/completions",
  model: "base",
};

function parseConfig(raw: unknown): AkmConfig {
  const result = validateConfigShape(raw);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function isolatedProcesses(judgment: unknown): Record<string, unknown> {
  return {
    reflect: { enabled: false },
    distill: { enabled: false },
    consolidate: { enabled: false },
    memoryInference: { enabled: false },
    graphExtraction: { enabled: false },
    extract: { enabled: false },
    validation: { enabled: false },
    proactiveMaintenance: { enabled: false },
    triage: { enabled: true, judgment },
  };
}

const judgmentPath = "improve.strategies.nightly.processes.triage.judgment";

function judgmentPatchBase(): Record<string, unknown> {
  return {
    configVersion: "0.9.0",
    improve: {
      strategies: {
        nightly: {
          processes: {
            triage: { enabled: true, judgment: { enabled: false, engine: "old" } },
          },
        },
      },
    },
  };
}

describe("triage judgment config normalization (#814)", () => {
  test("normalizes boolean shorthand and legacy objects to explicit enabled state", () => {
    expect(ImproveProcessConfigSchema.parse({ judgment: true }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: false }).judgment).toEqual({ enabled: false });
    expect(ImproveProcessConfigSchema.parse({ judgment: {} }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: { engine: "judge", model: "exact" } }).judgment).toEqual({
      enabled: true,
      engine: "judge",
      model: "exact",
    });
    expect(ImproveProcessConfigSchema.parse({ judgment: { enabled: false, timeoutMs: null } }).judgment).toEqual({
      enabled: false,
      timeoutMs: null,
    });
  });

  test("tolerates judgment typos, unknown keys and the retired mode/profile knobs", () => {
    // An unknown key is not fatal anywhere in config: the loader names it once
    // and it changes nothing. Only the retired keys below still fail, because
    // they have a replacement to point at.
    for (const judgment of [{ bogus: 1 }, { egnine: "judge" }]) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment }).success).toBe(true);
    }
    expect(TriageProcessConfigSchema.safeParse({ judgement: true }).success).toBe(true);

    // The retired `mode`/`profile` knobs are unknown keys like any other now:
    // tolerated here, named once by the loader, and never a reason to fail.
    for (const key of ["mode", "profile"] as const) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment: { [key]: "llm" } }).success).toBe(true);
    }
  });

  test("tolerates unknown judgment LLM override keys and retains arbitrary extraParams", () => {
    for (const llmOverrides of [{ tempertaure: 0.2 }, { futureTopLevelKnob: true }]) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment: { llm: llmOverrides } }).success).toBe(true);

      const live = validateConfigShape({
        configVersion: "0.9.0",
        improve: {
          strategies: {
            nightly: { processes: { triage: { enabled: true, judgment: { llm: llmOverrides } } } },
          },
        },
      });
      expect(live.ok).toBe(true);
    }

    const extraParams = {
      providerFeature: { nested: [1, true, "kept"] },
      arbitrary_number: 7,
    };
    expect(ImproveProcessConfigSchema.parse({ judgment: { llm: { temperature: 0.2, extraParams } } }).judgment).toEqual(
      { enabled: true, llm: { temperature: 0.2, extraParams } },
    );

    const live = validateConfigShape({
      configVersion: "0.9.0",
      improve: {
        strategies: {
          nightly: { processes: { triage: { enabled: true, judgment: { llm: { extraParams } } } } },
        },
      },
    });
    expect(live.ok).toBe(true);
    if (!live.ok) throw new Error(JSON.stringify(live.errors));
    expect(live.value.improve?.strategies?.nightly?.processes?.triage?.judgment?.llm?.extraParams).toEqual(extraParams);
  });

  test("cross-validation ignores disabled judgment engines but validates enabled ones", () => {
    const base = { configVersion: "0.9.0" };
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            disabled: { processes: { triage: { enabled: true, judgment: { enabled: false, engine: "missing" } } } },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            enabled: { processes: { triage: { enabled: true, judgment: { enabled: true, engine: "missing" } } } },
          },
        },
      }).ok,
    ).toBe(false);
  });

  test("disabled judgment requires no engine and produces no runtime runner", () => {
    const config = parseConfig({
      configVersion: "0.9.0",
      engines: {
        ready: llm,
        private: { ...llm, apiKey: "$MISSING_JUDGMENT_TOKEN" },
      },
      defaults: { llmEngine: "ready" },
      improve: {
        strategies: {
          disabled: {
            processes: isolatedProcesses({ enabled: false, engine: "private" }),
          },
        },
      },
    });

    const plan = resolveImprovePlan("disabled", config);
    expect(plan.strategy.config.processes?.triage?.judgment?.enabled).toBe(false);
    expect(plan.triageJudgment).toBeNull();
  });

  test("true and legacy-object judgment remain enabled and fail closed without an engine", () => {
    for (const judgment of [true, {}]) {
      const config = parseConfig({
        configVersion: "0.9.0",
        improve: { strategies: { enabled: { processes: isolatedProcesses(judgment) } } },
      });
      expect(config.improve?.strategies?.enabled?.processes?.triage?.judgment?.enabled).toBe(true);
      expect(() => resolveImprovePlan("enabled", config)).toThrow("Enabled improve triage judgment requires an engine");
    }
  });

  test("enabled judgment keeps judgment → triage → strategy → defaults precedence", () => {
    const config = parseConfig({
      configVersion: "0.9.0",
      engines: {
        default: { ...llm, model: "default" },
        strategy: { ...llm, model: "strategy" },
        triage: { ...llm, model: "triage" },
        judgment: { ...llm, model: "judgment" },
      },
      defaults: { llmEngine: "default" },
      improve: {
        strategies: {
          enabled: {
            engine: "strategy",
            processes: {
              ...isolatedProcesses(true),
              triage: { enabled: true, engine: "triage", judgment: { enabled: true, engine: "judgment" } },
            },
          },
        },
      },
    });

    expect(resolveImprovePlan("enabled", config).triageJudgment).toMatchObject({
      kind: "llm",
      engine: "judgment",
      connection: { model: "judgment" },
    });
  });
});

describe("triage judgment config patch semantics (#814 remediation-1)", () => {
  test("whole-object patches preserve an existing explicit disabled state", () => {
    const changedEngine = configSet(judgmentPatchBase(), judgmentPath, '{"engine":"new"}');
    expect(configGet(changedEngine, judgmentPath)).toEqual({ enabled: false, engine: "new" });

    const emptyPatch = configSet(judgmentPatchBase(), judgmentPath, "{}");
    expect(configGet(emptyPatch, judgmentPath)).toEqual({ enabled: false, engine: "old" });

    const nullOverride = configSet(judgmentPatchBase(), judgmentPath, '{"timeoutMs":null}');
    expect(configGet(nullOverride, judgmentPath)).toEqual({ enabled: false, engine: "old", timeoutMs: null });
  });

  test("leaf set and unset patches preserve an existing explicit disabled state", () => {
    const changedEngine = configSet(judgmentPatchBase(), `${judgmentPath}.engine`, "new");
    expect(configGet(changedEngine, judgmentPath)).toEqual({ enabled: false, engine: "new" });

    const nullTimeout = configSet(judgmentPatchBase(), `${judgmentPath}.timeoutMs`, "null");
    expect(configGet(nullTimeout, judgmentPath)).toEqual({ enabled: false, engine: "old", timeoutMs: null });

    const removedEngine = configUnset(judgmentPatchBase(), `${judgmentPath}.engine`);
    expect(configGet(removedEngine, judgmentPath)).toEqual({ enabled: false });
  });

  test("a newly introduced legacy object still defaults enabled true", () => {
    const base = judgmentPatchBase();
    const withoutJudgment = configUnset(base, judgmentPath);
    const added = configSet(withoutJudgment, judgmentPath, '{"engine":"new"}');
    expect(configGet(added, judgmentPath)).toEqual({ enabled: true, engine: "new" });
  });

  test("null and unset remove the whole judgment object without reviving it", () => {
    const cleared = configSet(judgmentPatchBase(), judgmentPath, "null");
    expect(configGet(cleared, judgmentPath)).toBeNull();

    const unset = configUnset(judgmentPatchBase(), judgmentPath);
    expect(configGet(unset, judgmentPath)).toBeNull();

    expect(() => configSet(judgmentPatchBase(), judgmentPath, "")).toThrow("Invalid value");
  });

  test("unsetting enabled intentionally restores the legacy object default", () => {
    const raw = configUnset(judgmentPatchBase(), `${judgmentPath}.enabled`);
    const legacy = configGet(raw, judgmentPath);
    expect(legacy).toEqual({ engine: "old" });
    expect(ImproveProcessConfigSchema.parse({ judgment: legacy }).judgment).toEqual({
      enabled: true,
      engine: "old",
    });
  });
});
