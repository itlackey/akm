// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import type { AkmConfig } from "../../src/core/config/config";
import {
  DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY,
  DEFAULT_MAP_CONCURRENCY,
  DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY,
  defaultLlmEngineConcurrency,
  defaultMapConcurrency,
  isLoopbackEndpoint,
  isLoopbackHost,
} from "../../src/workflows/concurrency-policy";
import { scheduleUnits } from "../../src/workflows/exec/scheduler";
import type { WorkflowMapNode, WorkflowPlan } from "../../src/workflows/plan";
import { WORKFLOW_MAX_CONCURRENCY } from "../../src/workflows/resource-limits";
import { freezeWorkflow } from "../_helpers/workflow";

const BASE_CONFIG = {
  configVersion: "0.9.0",
  semanticSearchMode: "off",
  engines: {
    remote: { kind: "llm", endpoint: "https://api.example.test/v1/chat/completions", model: "test-model" },
  },
  defaults: { engine: "remote" },
  workflow: { judgeEngine: "remote" },
} as const satisfies AkmConfig;

function mapWorkflow(concurrency?: number): string {
  return [
    "---",
    "type: workflow",
    "steps:",
    "  - id: discover",
    "  - id: review",
    "    map:",
    "      over: steps.discover.output.files",
    ...(concurrency === undefined ? [] : [`      concurrency: ${concurrency}`]),
    "---",
    "",
    "## discover",
    "",
    "List files.",
    "",
    "## review",
    "",
    "Review one file.",
  ].join("\n");
}

function mapNode(plan: WorkflowPlan): WorkflowMapNode {
  const root = plan.steps.find((step) => step.stepId === "review")?.root;
  if (!root || root.kind !== "map") throw new Error("expected current map node");
  return root;
}

function concurrencyProbe(delayMs = 5) {
  let active = 0;
  let peak = 0;
  return {
    dispatch: async (item: number) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      return item;
    },
    peak: () => peak,
  };
}

describe("current workflow concurrency policy", () => {
  test("new v4 plans freeze one resolved map width", () => {
    expect(mapNode(freezeWorkflow(mapWorkflow(), undefined, BASE_CONFIG)).concurrency).toBe(DEFAULT_MAP_CONCURRENCY);
    expect(mapNode(freezeWorkflow(mapWorkflow(1), undefined, BASE_CONFIG)).concurrency).toBe(1);
    expect(mapNode(freezeWorkflow(mapWorkflow(16), undefined, BASE_CONFIG)).concurrency).toBe(16);
  });

  test("the install default is resolved and clamped at freeze time", () => {
    expect(defaultMapConcurrency(undefined)).toBe(DEFAULT_MAP_CONCURRENCY);
    expect(defaultMapConcurrency(0)).toBe(1);
    expect(defaultMapConcurrency(Number.NaN)).toBe(DEFAULT_MAP_CONCURRENCY);
    expect(defaultMapConcurrency(10_000)).toBe(WORKFLOW_MAX_CONCURRENCY);

    const serial = { ...BASE_CONFIG, workflow: { judgeEngine: "remote", defaultMapConcurrency: 1 } } as AkmConfig;
    expect(mapNode(freezeWorkflow(mapWorkflow(), undefined, serial)).concurrency).toBe(1);
    expect(mapNode(freezeWorkflow(mapWorkflow(6), undefined, serial)).concurrency).toBe(6);
  });

  test("endpoint defaults classify loopback conservatively", () => {
    expect(defaultLlmEngineConcurrency("http://127.0.0.2:11434/v1")).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
    expect(defaultLlmEngineConcurrency("https://api.example.test/v1")).toBe(DEFAULT_REMOTE_LLM_ENGINE_CONCURRENCY);
    expect(defaultLlmEngineConcurrency("not a url")).toBe(DEFAULT_LOCAL_LLM_ENGINE_CONCURRENCY);
    expect(isLoopbackEndpoint("http://[::1]:8080/v1")).toBe(true);
    expect(isLoopbackEndpoint("https://127.0.0.1.evil.test/v1")).toBe(false);
  });

  test.each([
    ["localhost", true],
    ["lmstudio.localhost", true],
    ["127.0.0.2", true],
    ["::1", true],
    ["::ffff:7f00:1", true],
    ["0.0.0.0", true],
    ["127.0.0.1.evil.test", false],
    ["notlocalhost", false],
    ["128.0.0.1", false],
    ["2001:db8::1", false],
  ])("classifies host %s", (host, expected) => {
    expect(isLoopbackHost(host as string)).toBe(expected);
  });

  test("the scheduler applies the smallest current-plan ceiling", async () => {
    const probe = concurrencyProbe();
    await scheduleUnits([1, 2, 3, 4, 5, 6], probe.dispatch, {
      concurrency: DEFAULT_MAP_CONCURRENCY,
      maxConcurrency: 16,
      llmConcurrency: 2,
      hostConcurrency: 16,
    });
    expect(probe.peak()).toBe(2);
  });
});
