// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The one config rule for engines: every key unattended model work reads its
 * engine from must name an engine that confines the model-work tool policy (an
 * LLM engine, or an agent whose harness has `enforcesModelWorkTools`). Every
 * other engine key only has to name a configured engine.
 */

import { describe, expect, test } from "bun:test";
import { validateConfigShape } from "../src/core/config/config-schema";
import { HARNESS_REGISTRY } from "../src/integrations/harnesses";

const ENGINES = {
  llm: { kind: "llm", endpoint: "https://example.test/v1/chat/completions", model: "m" },
  ...Object.fromEntries(HARNESS_REGISTRY.map((entry) => [entry.id, { kind: "agent", platform: entry.id }])),
};

/** Each engine key, as the config fragment that sets it to `engine` and the key's dotted path. */
const MODEL_WORK_KEYS: [string, (engine: string) => Record<string, unknown>][] = [
  ["defaults.llmEngine", (engine) => ({ defaults: { llmEngine: engine } })],
  ["index.defaults.engine", (engine) => ({ index: { defaults: { engine } } })],
  ["index.memory.engine", (engine) => ({ index: { memory: { engine } } })],
  ["improve.strategies.s.engine", (engine) => ({ improve: { strategies: { s: { engine } } } })],
  [
    "improve.strategies.s.processes.reflect.engine",
    (engine) => ({ improve: { strategies: { s: { processes: { reflect: { engine } } } } } }),
  ],
  [
    "improve.strategies.s.processes.triage.engine",
    (engine) => ({ improve: { strategies: { s: { processes: { triage: { engine } } } } } }),
  ],
  [
    "improve.strategies.s.processes.triage.judgment.engine",
    (engine) => ({ improve: { strategies: { s: { processes: { triage: { judgment: { engine } } } } } } }),
  ],
  [
    "improve.strategies.s.processes.distill.qualityGate.engine",
    (engine) => ({ improve: { strategies: { s: { processes: { distill: { qualityGate: { engine } } } } } } }),
  ],
];

const OTHER_KEYS: [string, (engine: string) => Record<string, unknown>][] = [
  ["defaults.engine", (engine) => ({ defaults: { engine } })],
  ["workflow.judgeEngine", (engine) => ({ workflow: { judgeEngine: engine } })],
];

function errorsFor(fragment: Record<string, unknown>): { path: string; message: string }[] {
  const result = validateConfigShape({ configVersion: "0.9.0", engines: ENGINES, ...fragment });
  return result.ok ? [] : result.errors;
}

const CONFINING = new Set(["llm", ...HARNESS_REGISTRY.filter((e) => e.capabilities.modelWork).map((e) => e.id)]);
const ROWS = Object.keys(ENGINES).flatMap((engine) =>
  MODEL_WORK_KEYS.map(([key, set]): [string, string, (engine: string) => Record<string, unknown>] => [
    key,
    engine,
    set,
  ]),
);

describe("model-work engine keys need an engine that confines the model-work tool policy", () => {
  test.each(ROWS)("%s = %s", (key, engine, set) => {
    const errors = errorsFor(set(engine));
    if (CONFINING.has(engine)) {
      expect(errors).toEqual([]);
    } else {
      expect(errors).toEqual([
        {
          path: key,
          message: `engine "${engine}" (platform ${engine}) cannot confine the model-work tool policy, which unattended model work requires. Use an LLM engine, or an agent engine on opencode, claude or opencode-sdk.`,
        },
      ]);
    }
  });

  test.each(MODEL_WORK_KEYS)("%s must name a configured engine", (key, set) => {
    expect(errorsFor(set("missing"))).toEqual([{ path: key, message: "engine does not name a configured engine" }]);
  });

  test("a disabled triage judgment's engine is not checked", () => {
    expect(
      errorsFor({
        improve: { strategies: { s: { processes: { triage: { judgment: { enabled: false, engine: "codex" } } } } } },
      }),
    ).toEqual([]);
  });

  test("proactiveMaintenance dispatches no engine", () => {
    expect(
      errorsFor({ improve: { strategies: { s: { processes: { proactiveMaintenance: { engine: "llm" } } } } } }),
    ).toEqual([
      {
        path: "improve.strategies.s.processes.proactiveMaintenance.engine",
        message: "proactiveMaintenance does not dispatch an engine",
      },
    ]);
  });
});

describe("other engine keys take any configured engine", () => {
  test.each(
    Object.keys(ENGINES).flatMap((engine) => OTHER_KEYS.map(([key, set]) => [key, engine, set] as const)),
  )("%s = %s", (_key, engine, set) => {
    expect(errorsFor(set(engine))).toEqual([]);
  });
});
