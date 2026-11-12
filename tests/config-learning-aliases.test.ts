// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * #1626: `experimental.learning.*` mirrors `improve.strategies` and `improve.qualityGate`. A config that says a
 * learning control only under the new path reads exactly as the same value under the old one; a key set under both
 * to different values reads as the new one with one warning naming both.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, setConfigValue } from "../src/commands/config-cli";
import { resolveImprovePlan } from "../src/commands/improve/improve-strategies";
import {
  mutateConfig,
  parseAndValidateConfigText,
  resetConfigCache,
  unknownConfigKeyPaths,
} from "../src/core/config/config";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../src/core/warn";
import { sandboxXdgConfigHome } from "./_helpers/sandbox";

let cleanup: () => void = () => {};
beforeEach(() => {
  cleanup = sandboxXdgConfigHome().cleanup;
  resetConfigCache();
});
afterEach(() => {
  cleanup();
  resetConfigCache();
});

/** Parse `value` as a config document, returning the effective config and every warning printed. */
function read(value: Record<string, unknown>) {
  const warnings: string[] = [];
  _resetWarnOnceForTests();
  _setWarnSinkForTests((level, args) => {
    if (level === "warn") warnings.push(args.map(String).join(" "));
  });
  try {
    const config = parseAndValidateConfigText(JSON.stringify({ configVersion: "0.9.0", ...value }));
    return { config, warnings };
  } finally {
    _setWarnSinkForTests(undefined);
  }
}

/** `{ a: { b: value } }` for `["a", "b"]`. */
function nest(keys: readonly string[], value: unknown): Record<string, unknown> {
  return keys.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value) as Record<string, unknown>;
}

/** Every Research row inside a strategy: its path under `strategies.mine`, and the values to prove, falsy ones included. */
const STRATEGY_ALIASES: ReadonlyArray<[string, readonly unknown[]]> = [
  ["description", ["a description"]],
  ["sync", [{ enabled: false }, { push: false }]],
  ["processes.reflect.enabled", [true, false]],
  ["processes.distill.enabled", [true, false]],
  ["processes.consolidate.enabled", [false]],
  ["processes.extract.enabled", [false]],
  ["processes.triage.enabled", [false]],
  ["processes.proactiveMaintenance.enabled", [false]],
  ["processes.reflect.allowedTypes", [[], ["memory"]]],
  ["processes.distill.allowedTypes", [[], ["lesson"]]],
  ["processes.consolidate.allowedTypes", [[], ["memory"]]],
  ["processes.reflect.qualityGate.enabled", [true, false]],
  ["processes.distill.qualityGate.enabled", [true, false]],
  ["processes.reflect.defectFilter", [{ placeholders: [] }, { metaCommentary: ["note"], frontmatterKeys: [] }]],
  ["processes.extract.triage", [{ enabled: false }, { enabled: true, minScore: 0 }]],
  ["processes.extract.triage.minScore", [0, 3]],
  ["processes.extract.indexSessions", [true, false]],
  ["processes.extract.minSessionDuration", [0, 7]],
  ["processes.triage.applyMode", ["queue", "promote"]],
  ["processes.triage.judgment", [false, true, { enabled: false }]],
  ["processes.proactiveMaintenance.maxPerRun", [1, 40]],
  ["processes.proactiveMaintenance.dueDays", [0, 9]],
  ["processes.distill.cls", [{ enabled: false }, { enabled: true, adjacentCount: 1 }]],
  ["processes.distill.requirePlannedRefs", [true, false]],
  ["processes.consolidate.maxChunkSize", [1, 50]],
];

const QUALITY_GATE_VALUES: readonly unknown[] = [
  { connection: "lab" },
  { harness: "work", model: "fast" },
  { llm: { temperature: 0, enableThinking: false } },
  { timeoutMs: null },
  { timeoutMs: 5000 },
];

const OLD = (keys: readonly string[], value: unknown) => ({ improve: nest(["strategies", "mine", ...keys], value) });
const NEW = (keys: readonly string[], value: unknown) => ({
  experimental: { learning: nest(["strategies", "mine", ...keys], value) },
});

describe("experimental.learning aliases: parity", () => {
  for (const [alias, values] of STRATEGY_ALIASES) {
    for (const value of values) {
      test(`strategies.<name>.${alias} = ${JSON.stringify(value)} reads as the old path`, () => {
        const old = read(OLD(alias.split("."), value));
        const alt = read(NEW(alias.split("."), value));
        expect(alt.config.improve).toEqual(old.config.improve);
        expect(alt.config.improve?.strategies?.mine).toBeDefined();
        expect(alt.warnings).toEqual([]);
        expect(old.warnings).toEqual([]);
      });
    }
  }

  for (const value of QUALITY_GATE_VALUES) {
    test(`qualityGate = ${JSON.stringify(value)} reads as improve.qualityGate`, () => {
      const old = read({ improve: { qualityGate: value } });
      const alt = read({ experimental: { learning: { qualityGate: value } } });
      expect(alt.config.improve).toEqual(old.config.improve);
      expect(alt.config.improve?.qualityGate).toBeDefined();
      expect(alt.warnings).toEqual([]);
    });
  }

  test("a whole strategy under the new path reads as the same strategy under the old", () => {
    const strategy = {
      description: "mine",
      sync: { enabled: false },
      processes: {
        reflect: {
          enabled: true,
          allowedTypes: [],
          qualityGate: { enabled: false },
          defectFilter: { placeholders: [] },
        },
        extract: {
          enabled: true,
          triage: { enabled: false, minScore: 0 },
          indexSessions: false,
          minSessionDuration: 0,
        },
        triage: { enabled: true, applyMode: "queue", judgment: false },
        proactiveMaintenance: { enabled: true, maxPerRun: 1, dueDays: 0 },
        distill: { enabled: true, cls: { enabled: false }, requirePlannedRefs: false },
        consolidate: { enabled: true, maxChunkSize: 5 },
      },
    };
    const old = read({ improve: { strategies: { mine: strategy } } });
    const alt = read({ experimental: { learning: { strategies: { mine: strategy } } } });
    expect(alt.config.improve).toEqual(old.config.improve);
    expect(alt.warnings).toEqual([]);
  });

  test("a new-path overlay of the shipped `default` reads as the old-path overlay", () => {
    const patch = { processes: { extract: { triage: { enabled: false } }, reflect: { allowedTypes: [] } } };
    const old = read({ improve: { strategies: { default: patch } } });
    const alt = read({ experimental: { learning: { strategies: { default: patch } } } });
    expect(alt.config.improve).toEqual(old.config.improve);
  });

  test("a config with only old keys is unchanged and prints nothing", () => {
    const improve = {
      strategies: { mine: { processes: { reflect: { enabled: false, allowedTypes: [] } } } },
      qualityGate: { model: "fast" },
    };
    const { config, warnings } = read({ improve });
    expect(config.improve).toEqual(improve);
    expect(config.experimental).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  test("the unknown-key warning does not fire for the new paths", () => {
    const raw = {
      experimental: {
        learning: {
          strategies: { mine: { processes: { extract: { triage: { minScore: 0 } } } } },
          qualityGate: { model: "fast" },
        },
      },
    };
    expect(unknownConfigKeyPaths(raw)).toEqual([]);
    expect(read(raw).warnings).toEqual([]);
  });

  test("experimental.improveAutonomy stays a separate gate", () => {
    const { config } = read({ experimental: { improveAutonomy: true, learning: { qualityGate: { model: "fast" } } } });
    expect(config.experimental?.improveAutonomy).toBe(true);
    const off = read({ experimental: { learning: { qualityGate: { model: "fast" } } } });
    expect(off.config.experimental?.improveAutonomy).toBeUndefined();
  });
});

describe("experimental.learning aliases: old and new both set", () => {
  test("different values: the new key wins and one warning names both", () => {
    const { config, warnings } = read({
      improve: { strategies: { mine: { processes: { reflect: { enabled: true, allowedTypes: ["memory"] } } } } },
      experimental: {
        learning: { strategies: { mine: { processes: { reflect: { enabled: false } } } } },
      },
    });
    expect(config.improve?.strategies?.mine?.processes?.reflect).toEqual({ enabled: false, allowedTypes: ["memory"] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("improve.strategies.mine.processes.reflect.enabled");
    expect(warnings[0]).toContain("experimental.learning.strategies.mine.processes.reflect.enabled");
  });

  test("a falsy new value wins over a truthy old one", () => {
    const { config, warnings } = read({
      improve: { strategies: { mine: { processes: { extract: { minSessionDuration: 9, triage: { minScore: 4 } } } } } },
      experimental: {
        learning: {
          strategies: { mine: { processes: { extract: { minSessionDuration: 0, triage: { minScore: 0 } } } } },
        },
      },
    });
    expect(config.improve?.strategies?.mine?.processes?.extract).toMatchObject({
      minSessionDuration: 0,
      triage: { minScore: 0 },
    });
    expect(warnings).toHaveLength(2);
  });

  test("an empty list wins over a populated one", () => {
    const { config } = read({
      improve: { strategies: { mine: { processes: { reflect: { allowedTypes: ["memory"] } } } } },
      experimental: { learning: { strategies: { mine: { processes: { reflect: { allowedTypes: [] } } } } } },
    });
    expect(config.improve?.strategies?.mine?.processes?.reflect?.allowedTypes).toEqual([]);
  });

  test("qualityGate: the new key wins with one warning", () => {
    const { config, warnings } = read({
      improve: { qualityGate: { model: "old", connection: "lab" } },
      experimental: { learning: { qualityGate: { model: "new" } } },
    });
    expect(config.improve?.qualityGate).toEqual({ model: "new", connection: "lab" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("improve.qualityGate.model");
    expect(warnings[0]).toContain("experimental.learning.qualityGate.model");
  });

  test("the same value under both prints nothing", () => {
    const strategies = { mine: { processes: { reflect: { enabled: false, allowedTypes: [] } } } };
    const { config, warnings } = read({
      improve: { strategies, qualityGate: { model: "fast" } },
      experimental: { learning: { strategies, qualityGate: { model: "fast" } } },
    });
    expect(config.improve?.strategies).toEqual(strategies);
    expect(warnings).toEqual([]);
  });

  test("keys set under one path only are kept from each", () => {
    const { config, warnings } = read({
      improve: { strategies: { mine: { processes: { reflect: { enabled: true } } } } },
      experimental: { learning: { strategies: { mine: { processes: { distill: { enabled: false } } }, other: {} } } },
    });
    expect(config.improve?.strategies?.mine?.processes).toEqual({
      reflect: { enabled: true },
      distill: { enabled: false },
    });
    expect(config.improve?.strategies?.other).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("experimental.learning aliases: plans", () => {
  const lab = { endpoint: "http://127.0.0.1:1/v1", models: { fast: "m" } };
  const strategy = {
    processes: {
      reflect: { enabled: true, allowedTypes: ["memory"], qualityGate: { enabled: false } },
      extract: { enabled: false },
      distill: { enabled: false },
      consolidate: { enabled: false },
      memoryInference: { enabled: false },
      triage: { enabled: false },
      validation: { enabled: false },
      proactiveMaintenance: { enabled: false },
    },
  };

  test("the same strategy under either path plans the same", () => {
    const old = read({ connections: { default: lab }, improve: { strategy: "mine", strategies: { mine: strategy } } });
    const alt = read({
      connections: { default: lab },
      improve: { strategy: "mine" },
      experimental: { learning: { strategies: { mine: strategy } } },
    });
    const plan = (config: typeof old.config) => {
      const resolved = resolveImprovePlan(undefined, config);
      return {
        strategy: resolved.strategy,
        processes: Object.fromEntries(
          Object.entries(resolved.processes).map(([name, p]) => [name, { enabled: p.enabled, config: p.config }]),
        ),
        gated: resolved.autonomyGated,
      };
    };
    expect(plan(alt.config)).toEqual(plan(old.config));
    expect(plan(alt.config).processes.reflect?.config).toMatchObject({ allowedTypes: ["memory"] });
  });
});

describe("experimental.learning aliases: akm config get/set", () => {
  test("set writes the new path only, and reads back", () => {
    const base = { configVersion: "0.9.0" } as never;
    const next = setConfigValue(base, "experimental.learning.qualityGate.model", "fast");
    expect(getConfigValue(next, "experimental.learning.qualityGate.model")).toBe("fast");
    expect((next as { improve?: unknown }).improve).toBeUndefined();
  });

  test("a write of another key leaves a new-path config untouched on disk", () => {
    const configPath = path.join(process.env.XDG_CONFIG_HOME as string, "akm", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        configVersion: "0.9.0",
        experimental: { learning: { strategies: { mine: { processes: { reflect: { enabled: false } } } } } },
      }),
    );
    mutateConfig((current) => setConfigValue(current, "output.format", "json"));
    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(written.improve).toBeUndefined();
    expect(written.experimental.learning.strategies.mine.processes.reflect.enabled).toBe(false);
  });
});
