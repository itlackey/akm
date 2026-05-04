/**
 * Unit tests for the bench run-config loader (`tests/bench/run-config.ts`).
 *
 * Covers the parts that don't require spawning a process:
 * - Schema validation (unknown fields, missing schemaVersion, bad arms).
 * - Path resolution (~ expansion, ${VAR} expansion, relative vs absolute).
 * - Provider discovery chain (env > inline > providersRef > XDG default).
 * - Baseline-file loading + range checks.
 * - Task selector resolution (slice / domain / id / array).
 *
 * The CLI-level dispatch is exercised by `cli.test.ts` via spawned bench
 * runs — keep those for end-to-end coverage; this file is unit-grade.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultUserProvidersPath, loadBaseline, loadBenchRunConfig, resolvePathString } from "./run-config";
import { benchMkdtemp } from "./tmp";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let workDir: string;
let savedEnv: { BENCH_OPENCODE_CONFIG?: string; BENCH_OPENCODE_MODEL?: string; AKM_TEST_VAR?: string };

beforeEach(() => {
  // Per #276 invariant: bench tmp dirs live under `${AKM_CACHE_DIR}/bench/`,
  // never the OS-default tmp root. `benchMkdtemp` is the drop-in.
  workDir = benchMkdtemp("akm-bench-runconfig-test-");
  savedEnv = {
    BENCH_OPENCODE_CONFIG: process.env.BENCH_OPENCODE_CONFIG,
    BENCH_OPENCODE_MODEL: process.env.BENCH_OPENCODE_MODEL,
    AKM_TEST_VAR: process.env.AKM_TEST_VAR,
  };
  delete process.env.BENCH_OPENCODE_CONFIG;
  delete process.env.BENCH_OPENCODE_MODEL;
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function writeProvidersFile(filePath: string, defaultModel = "p/m"): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      defaultModel,
      providers: { p: { npm: "@ai-sdk/openai-compatible" } },
    }),
  );
}

describe("resolvePathString", () => {
  test("resolves a relative path against the supplied base dir", () => {
    expect(resolvePathString("foo.json", "/work")).toBe("/work/foo.json");
  });

  test("returns absolute paths unchanged", () => {
    expect(resolvePathString("/abs/path.json", "/work")).toBe("/abs/path.json");
  });

  test("expands `~` to the operator's home dir", () => {
    expect(resolvePathString("~/.config/akm/foo.json", "/work")).toBe(path.join(os.homedir(), ".config/akm/foo.json"));
  });

  test("expands env-var references", () => {
    // Build the input with concatenation rather than a string literal to avoid
    // biome's noTemplateCurlyInString flag on the `\${VAR}` form.
    process.env.AKM_TEST_VAR = "/somewhere";
    const input = `${"$"}{AKM_TEST_VAR}/providers.json`;
    expect(resolvePathString(input, "/work")).toBe("/somewhere/providers.json");
  });
});

describe("defaultUserProvidersPath", () => {
  test("respects XDG_CONFIG_HOME when set", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = "/xdg-test";
    try {
      expect(defaultUserProvidersPath()).toBe("/xdg-test/akm/bench-providers.json");
    } finally {
      if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved;
    }
  });

  test("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    const saved = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(defaultUserProvidersPath()).toBe(path.join(os.homedir(), ".config/akm/bench-providers.json"));
    } finally {
      if (saved !== undefined) process.env.XDG_CONFIG_HOME = saved;
    }
  });
});

describe("loadBaseline", () => {
  test("loads a `{ taskId: passRate }` map", () => {
    const filePath = path.join(workDir, "baseline.json");
    fs.writeFileSync(filePath, JSON.stringify({ "domain/a": 0.8, "domain/b": 1.0 }));
    expect(loadBaseline(filePath)).toEqual({ "domain/a": 0.8, "domain/b": 1.0 });
  });

  test("rejects pass rates outside [0, 1]", () => {
    const filePath = path.join(workDir, "bad.json");
    fs.writeFileSync(filePath, JSON.stringify({ "x/y": 1.5 }));
    expect(() => loadBaseline(filePath)).toThrow(/must be a number in \[0, 1\]/);
  });

  test("rejects non-number values", () => {
    const filePath = path.join(workDir, "non-number.json");
    fs.writeFileSync(filePath, JSON.stringify({ "x/y": "not a number" }));
    expect(() => loadBaseline(filePath)).toThrow(/must be a number/);
  });
});

describe("loadBenchRunConfig — schema validation", () => {
  test("rejects unknown top-level fields", () => {
    const cfgPath = path.join(workDir, "bad.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, name: "x", weirdField: 42 }));
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/unknown field "weirdField"/);
  });

  test("rejects missing schemaVersion", () => {
    const cfgPath = path.join(workDir, "noversion.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ name: "x" }));
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/unsupported schemaVersion/);
  });

  test("rejects providers AND providersRef both set", () => {
    const cfgPath = path.join(workDir, "both.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providers: { p: { npm: "x" } },
        providersRef: "./other.json",
      }),
    );
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/only one of "providers" or "providersRef"/);
  });

  test("rejects bad arm values", () => {
    const cfgPath = path.join(workDir, "badarm.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ schemaVersion: 1, arms: ["nope"] }));
    expect(() => loadBenchRunConfig(cfgPath)).toThrow(/invalid arm/);
  });

  test("missing config file exits with usage error", () => {
    expect(() => loadBenchRunConfig(path.join(workDir, "ghost.json"))).toThrow(/file not found/);
  });
});

describe("loadBenchRunConfig — provider discovery", () => {
  test("BENCH_OPENCODE_CONFIG env var wins over providersRef", () => {
    const envProviders = path.join(workDir, "env-providers.json");
    const refProviders = path.join(workDir, "ref-providers.json");
    writeProvidersFile(envProviders, "env/model");
    writeProvidersFile(refProviders, "ref/model");
    process.env.BENCH_OPENCODE_CONFIG = envProviders;

    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./ref-providers.json",
        tasks: "all",
      }),
    );
    // No tasks resolved so we can't actually load — just verify provider
    // resolution. We restrict to a single committed task to satisfy the
    // selector. The bench corpus exists at fixtures/bench/tasks; we use
    // "all" as the selector and skip past the `tasks=0` exit by writing a
    // selector that matches a real task.
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./ref-providers.json",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.providers.source).toBe(envProviders);
    expect(resolved.model).toBe("env/model");
  });

  test("`providersRef` is resolved relative to the config file", () => {
    const refProviders = path.join(workDir, "subdir", "providers.json");
    writeProvidersFile(refProviders, "ref/model");
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./subdir/providers.json",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.providers.source).toBe(refProviders);
    expect(resolved.model).toBe("ref/model");
  });

  test("config `defaultModel` overrides the providers file's defaultModel", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders, "ref/model");
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        defaultModel: "config/model",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.model).toBe("config/model");
  });

  test("BENCH_OPENCODE_MODEL env wins over both", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders, "ref/model");
    process.env.BENCH_OPENCODE_MODEL = "env/model";
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        defaultModel: "config/model",
        tasks: ["drillbit/backup-policy"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.model).toBe("env/model");
  });
});

describe("loadBenchRunConfig — task resolution", () => {
  test("tasks=array selects exactly the listed ids", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders);
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        tasks: ["drillbit/backup-policy", "drillbit/canary-enable"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.tasks.map((t) => t.id).sort()).toEqual(["drillbit/backup-policy", "drillbit/canary-enable"]);
  });

  test("tasks=domain matches every task whose domain matches", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders);
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        tasks: "drillbit",
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.tasks.length).toBeGreaterThan(0);
    for (const t of resolved.tasks) expect(t.domain).toBe("drillbit");
  });

  test("tasks=single-id matches exactly that task", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders);
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        tasks: "drillbit/backup-policy",
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.tasks.map((t) => t.id)).toEqual(["drillbit/backup-policy"]);
  });

  test("--tasks override (CLI) restricts to a subset of the config's selection", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders);
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        tasks: ["drillbit/backup-policy", "drillbit/canary-enable"],
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath, { tasksList: ["drillbit/canary-enable"] });
    expect(resolved.tasks.map((t) => t.id)).toEqual(["drillbit/canary-enable"]);
  });

  test("baseline path is resolved relative to the config file", () => {
    const refProviders = path.join(workDir, "providers.json");
    writeProvidersFile(refProviders);
    const baselinePath = path.join(workDir, "baseline.json");
    fs.writeFileSync(baselinePath, JSON.stringify({ "drillbit/backup-policy": 0.8 }));
    const cfgPath = path.join(workDir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        schemaVersion: 1,
        providersRef: "./providers.json",
        tasks: ["drillbit/backup-policy"],
        baseline: "./baseline.json",
      }),
    );
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.baselineByTaskId).toEqual({ "drillbit/backup-policy": 0.8 });
  });
});

describe("loadBenchRunConfig — committed configs validate", () => {
  test("tests/bench/configs/nano-quick.json loads cleanly", () => {
    const cfgPath = path.join(REPO_ROOT, "tests", "bench", "configs", "nano-quick.json");
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.name).toBe("nano-quick");
    expect(resolved.arms).toEqual(["akm"]);
    expect(resolved.seedsPerArm).toBe(2);
    expect(resolved.tasks.length).toBe(5);
  });

  test("tests/bench/configs/full.json loads cleanly and carries the baseline", () => {
    const cfgPath = path.join(REPO_ROOT, "tests", "bench", "configs", "full.json");
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.name).toBe("full");
    expect(resolved.baselineByTaskId).toBeDefined();
    expect(typeof resolved.baselineByTaskId?.["drillbit/backup-policy"]).toBe("number");
  });

  test("tests/bench/configs/curate-test.json restricts to one task", () => {
    const cfgPath = path.join(REPO_ROOT, "tests", "bench", "configs", "curate-test.json");
    const resolved = loadBenchRunConfig(cfgPath);
    expect(resolved.tasks.map((t) => t.id)).toEqual(["inkwell/configure-scaling"]);
  });
});
