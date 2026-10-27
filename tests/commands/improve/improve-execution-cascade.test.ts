// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Improve's cascade picks where model work runs, farther to nearer:
 * `improve.connection` / `improve.harness`, then `index.<pass>`, then
 * `improve.processes.<name>`, then the call's own settings, then what the run selected
 * (`--connection`, `--harness`, `--model`). The nearest layer that names a connection or
 * harness decides, whichever of the two keys each layer used.
 */

import { describe, expect, test } from "bun:test";
import { resolveImproveExecution } from "../../../src/commands/improve/execution";
import { resolveImprovePlan } from "../../../src/commands/improve/improve-strategies";
import type { AkmConfig } from "../../../src/core/config/config";

const config = (improve: Record<string, unknown> = {}): AkmConfig =>
  ({
    configVersion: "0.9.0",
    connections: {
      default: { endpoint: "http://lab:1/v1", models: { fast: "default-model" } },
      wide: { endpoint: "http://lab:2/v1", models: { fast: "wide-model" } },
      near: { endpoint: "http://lab:3/v1", models: { fast: "near-model" } },
    },
    harnesses: { claude: {} },
    improve,
  }) as unknown as AkmConfig;

const resolve = (
  improve: Record<string, unknown>,
  options: Partial<Parameters<typeof resolveImproveExecution>[0]> = {},
) => resolveImproveExecution({ config: config(improve), processName: "reflect", alias: "fast", ...options })?.runner;

/** `improve` with the reflect process saying where it runs. */
const reflect = (where: Record<string, unknown>, improve: Record<string, unknown> = {}) => ({
  ...improve,
  processes: { reflect: where },
});

describe("resolveImproveExecution — the nearest layer that names a target wins", () => {
  test("with nothing named, model work runs on the default connection", () => {
    expect(resolve({})).toMatchObject({ kind: "connection", name: "default" });
  });

  test("improve-wide, then the process, then the current invocation", () => {
    expect(resolve({ connection: "wide" })).toMatchObject({ name: "wide" });
    expect(resolve(reflect({ connection: "near" }, { connection: "wide" }))).toMatchObject({ name: "near" });
    expect(
      resolve(reflect({ connection: "near" }, { connection: "wide" }), { current: { connection: "default" } }),
    ).toMatchObject({ name: "default" });
  });

  test("a call that is not a process takes the settings of the process it names", () => {
    const improve = { processes: { triage: { connection: "near" }, reflect: { connection: "wide" } } };
    expect(resolve(improve, { processName: "triage-judgment", process: "triage" })).toMatchObject({ name: "near" });
    expect(resolve(improve, { processName: "remember-enrich" })).toMatchObject({ name: "default" });
  });

  test("a nearer harness replaces a farther connection, and a nearer connection a farther harness", () => {
    expect(resolve(reflect({ harness: "claude" }, { connection: "wide" }))).toMatchObject({
      kind: "harness",
      name: "claude",
    });
    expect(resolve(reflect({ connection: "near" }, { harness: "claude" }))).toMatchObject({
      kind: "connection",
      name: "near",
    });
  });

  test("the run's selection is nearer than the call's own settings and every process", () => {
    const improve = reflect({ connection: "near" }, { connection: "wide" });
    expect(resolve(improve, { current: { connection: "default" }, run: { harness: "claude" } })).toMatchObject({
      kind: "harness",
      name: "claude",
    });
    expect(resolve(improve, { run: { connection: "default", model: "fast" } })).toMatchObject({
      kind: "connection",
      name: "default",
      model: "default-model",
    });
  });

  test("the retired `engine` key (a connection by that name, else a harness) replaces a process's choice of the other kind", () => {
    expect(resolve(reflect({ connection: "near" }), { current: { engine: "claude" } })).toMatchObject({
      kind: "harness",
      name: "claude",
    });
    expect(resolve(reflect({ harness: "claude" }), { current: { engine: "near" } })).toMatchObject({
      kind: "connection",
      name: "near",
    });
  });
});

describe("resolveImprovePlan — what the run selected reaches every call in it", () => {
  // The strategy says what runs; where reflect runs is `improve.processes`.
  const strategy = {
    processes: { reflect: { enabled: true }, triage: { enabled: true, judgment: { enabled: true } } },
  };
  const planned = (options?: Parameters<typeof resolveImprovePlan>[2]) =>
    resolveImprovePlan(
      "s",
      config({ strategy: "s", strategies: { s: strategy }, processes: { reflect: { connection: "near" } } }),
      options,
    );

  test("without a selection each process runs where the config puts it", () => {
    const plan = planned();
    expect(plan.processes.reflect.runner).toMatchObject({ kind: "connection", name: "near" });
    expect(plan.triageJudgment).toMatchObject({ kind: "connection", name: "default" });
    expect(plan.run).toBeUndefined();
  });

  test("a selection replaces the process's own target and triage's judgment, and the plan carries it for the judges", () => {
    const plan = planned({ run: { harness: "claude" } });
    expect(plan.processes.reflect.runner).toMatchObject({ kind: "harness", name: "claude" });
    expect(plan.triageJudgment).toMatchObject({ kind: "harness", name: "claude" });
    expect(plan.run).toEqual({ harness: "claude" });
  });
});
