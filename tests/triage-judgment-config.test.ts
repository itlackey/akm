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

const connection = (model: string, extra: Record<string, unknown> = {}) => ({
  endpoint: "https://example.test/v1",
  models: { fast: model },
  ...extra,
});

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
            triage: { enabled: true, judgment: { enabled: false } },
          },
        },
      },
    },
  };
}

describe("triage judgment config normalization (#814)", () => {
  test("normalizes boolean shorthand and objects to explicit enabled state", () => {
    expect(ImproveProcessConfigSchema.parse({ judgment: true }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: false }).judgment).toEqual({ enabled: false });
    expect(ImproveProcessConfigSchema.parse({ judgment: {} }).judgment).toEqual({ enabled: true });
    expect(ImproveProcessConfigSchema.parse({ judgment: { enabled: false } }).judgment).toEqual({ enabled: false });
  });

  test("tolerates judgment typos, unknown keys and the retired mode/profile knobs", () => {
    // An unknown key is not fatal anywhere in config: the loader names it once
    // and it changes nothing. That includes the keys a judgment once took to say
    // where it runs; that is `improve.processes.triage` now.
    for (const judgment of [{ bogus: 1 }, { conection: "judge" }, { connection: "judge", model: "exact" }]) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment }).success).toBe(true);
    }
    expect(TriageProcessConfigSchema.safeParse({ judgement: true }).success).toBe(true);
    for (const key of ["mode", "profile"] as const) {
      expect(ImproveProcessConfigSchema.safeParse({ judgment: { [key]: "llm" } }).success).toBe(true);
    }
  });

  test("where triage's judgment runs is improve.processes.triage, which tolerates unknown LLM keys and keeps extraParams", () => {
    for (const llmOverrides of [{ tempertaure: 0.2 }, { futureTopLevelKnob: true }]) {
      expect(
        validateConfigShape({
          configVersion: "0.9.0",
          improve: { processes: { triage: { llm: llmOverrides } } },
        }).ok,
      ).toBe(true);
    }

    const extraParams = { providerFeature: { nested: [1, true, "kept"] }, arbitrary_number: 7 };
    const live = validateConfigShape({
      configVersion: "0.9.0",
      improve: { processes: { triage: { llm: { extraParams } } } },
    });
    if (!live.ok) throw new Error(JSON.stringify(live.errors));
    expect(live.value.improve?.processes?.triage?.llm?.extraParams).toEqual(extraParams);
  });

  test("triage may name a connection or harness that is not configured: it is resolved when used", () => {
    expect(
      validateConfigShape({
        configVersion: "0.9.0",
        improve: { processes: { triage: { connection: "missing" } } },
      }).ok,
    ).toBe(true);
  });

  test("disabled judgment requires no connection and produces no runtime runner", () => {
    const config = parseConfig({
      configVersion: "0.9.0",
      connections: {
        default: connection("base"),
        private: connection("base", { apiKey: "$MISSING_JUDGMENT_TOKEN" }),
      },
      improve: {
        processes: { triage: { connection: "private" } },
        strategies: { disabled: { processes: isolatedProcesses({ enabled: false }) } },
      },
    });

    const plan = resolveImprovePlan("disabled", config);
    expect(plan.strategy.config.processes?.triage?.judgment?.enabled).toBe(false);
    expect(plan.triageJudgment).toBeNull();
  });

  test("true and legacy-object judgment remain enabled and fail closed without a connection or harness", () => {
    for (const judgment of [true, {}]) {
      const config = parseConfig({
        configVersion: "0.9.0",
        improve: { strategies: { enabled: { processes: isolatedProcesses(judgment) } } },
      });
      expect(config.improve?.strategies?.enabled?.processes?.triage?.judgment?.enabled).toBe(true);
      expect(() => resolveImprovePlan("enabled", config)).toThrow(
        "Enabled improve triage judgment requires a connection or harness",
      );
    }
  });

  test("enabled judgment runs where improve.processes.triage says, else improve-wide, else the default by name", () => {
    const base = {
      configVersion: "0.9.0",
      connections: {
        default: connection("default"),
        improve: connection("improve"),
        triage: connection("triage"),
      },
      strategies: { enabled: { processes: isolatedProcesses(true) } },
    };
    const resolve = (improve: Record<string, unknown>) =>
      resolveImprovePlan("enabled", parseConfig({ ...base, improve: { ...improve, strategies: base.strategies } }))
        .triageJudgment;

    expect(resolve({ connection: "improve", processes: { triage: { connection: "triage" } } })).toMatchObject({
      kind: "connection",
      name: "triage",
      model: "triage",
    });
    expect(resolve({ connection: "improve" })).toMatchObject({ name: "improve", model: "improve" });
    expect(resolve({})).toMatchObject({ name: "default", model: "default" });
  });
});

describe("triage judgment config patch semantics (#814 remediation-1)", () => {
  test("whole-object patches preserve an existing explicit disabled state", () => {
    const emptyPatch = configSet(judgmentPatchBase(), judgmentPath, "{}");
    expect(configGet(emptyPatch, judgmentPath)).toEqual({ enabled: false });

    const enabled = configSet(judgmentPatchBase(), judgmentPath, '{"enabled":true}');
    expect(configGet(enabled, judgmentPath)).toEqual({ enabled: true });
  });

  test("leaf set and unset patches preserve an existing explicit disabled state", () => {
    const enabled = configSet(judgmentPatchBase(), `${judgmentPath}.enabled`, "true");
    expect(configGet(enabled, judgmentPath)).toEqual({ enabled: true });

    const disabledAgain = configSet(enabled, `${judgmentPath}.enabled`, "false");
    expect(configGet(disabledAgain, judgmentPath)).toEqual({ enabled: false });
  });

  test("a newly introduced legacy object still defaults enabled true", () => {
    const base = judgmentPatchBase();
    const withoutJudgment = configUnset(base, judgmentPath);
    const added = configSet(withoutJudgment, judgmentPath, "{}");
    expect(configGet(added, judgmentPath)).toEqual({ enabled: true });
  });

  test("null and unset remove the whole judgment object without reviving it", () => {
    const cleared = configSet(judgmentPatchBase(), judgmentPath, "null");
    expect(configGet(cleared, judgmentPath)).toBeNull();

    const unset = configUnset(judgmentPatchBase(), judgmentPath);
    expect(configGet(unset, judgmentPath)).toBeNull();

    expect(() => configSet(judgmentPatchBase(), judgmentPath, "")).toThrow("Invalid value");
  });

  test("unsetting enabled removes the object it was the last key of, rather than reviving the judgment", () => {
    const raw = configUnset(judgmentPatchBase(), `${judgmentPath}.enabled`);
    expect(configGet(raw, judgmentPath)).toBeNull();
  });
});
