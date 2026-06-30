import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveJudgeCalibrationSandboxConfig,
  runJudgeCalibrationCase,
} from "../scripts/akm-eval/src/runners/judge-calibration";
import type { EvalCase, EvalContext } from "../scripts/akm-eval/src/types";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(root: string, config: Record<string, unknown>): string {
  const configDir = path.join(root, "config", "akm");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

function makeCase(): EvalCase {
  return {
    schemaVersion: 1,
    id: "judge-calibration-suite",
    suite: "judge-calibration",
    type: "judge-calibration",
    description: "test",
    input: { probesDir: "probes", samplesPerProbe: 1, improveArgs: [] },
    expected: { minAgreement: 0.5, maxVariance: 0.5 },
    scoring: { deterministic: false, passThreshold: 0.8 },
  };
}

function makeContext(root: string, env: Record<string, string>): EvalContext {
  return {
    stashRoot: path.join(root, "stash"),
    dataDir: path.join(root, "data"),
    akmBin: "akm",
    casesRoot: root,
    outRoot: path.join(root, "out"),
    keepSandbox: false,
    env,
  };
}

describe("resolveJudgeCalibrationSandboxConfig", () => {
  test("builds a distill-only sandbox profile from the current llm config shape", () => {
    const root = makeTmpDir("akm-eval-judge-config-");
    const configPath = writeConfig(root, {
      profiles: {
        llm: {
          default: {
            endpoint: "https://example.test/v1",
            model: "mini",
            apiKey: "$" + "{OPENAI_API_KEY}",
            supportsJsonSchema: true,
          },
        },
        improve: {
          default: {
            processes: {
              reflect: { enabled: true },
              distill: { enabled: true },
            },
          },
        },
      },
    });

    const result = resolveJudgeCalibrationSandboxConfig({
      XDG_CONFIG_HOME: path.join(root, "config"),
      OPENAI_API_KEY: "token",
    });

    expect(result.ok).toBe(true);
    expect(result.sourceConfigPath).toBe(configPath);
    const config = result.config as {
      defaults: { llm: string; improve: string };
      profiles: { llm: Record<string, { endpoint: string; model: string }>; improve: Record<string, unknown> };
    };
    expect(config.defaults).toEqual({ llm: "default", improve: "default" });
    expect(config.profiles.llm.default.endpoint).toBe("https://example.test/v1");
    expect(config.profiles.llm.default.model).toBe("mini");

    const improve = config.profiles.improve.default as {
      processes: Record<string, { enabled?: boolean; requirePlannedRefs?: boolean; allowedTypes?: string[] }>;
      sync: { enabled: boolean; push: boolean };
    };
    expect(improve.processes.reflect?.enabled).toBe(false);
    expect(improve.processes.distill?.enabled).toBe(true);
    expect(improve.processes.distill?.requirePlannedRefs).toBe(false);
    expect(improve.processes.distill?.allowedTypes).toEqual(["memory"]);
    expect(improve.processes.consolidate?.enabled).toBe(false);
    expect(improve.processes.memoryInference?.enabled).toBe(false);
    expect(improve.processes.graphExtraction?.enabled).toBe(false);
    expect(improve.processes.extract?.enabled).toBe(false);
    expect(improve.sync).toEqual({ enabled: false, push: false });
  });
});

describe("runJudgeCalibrationCase", () => {
  test("skips with an actionable precondition when no llm path is configured", async () => {
    const root = makeTmpDir("akm-eval-judge-skip-");
    writeConfig(root, {
      profiles: {
        improve: {
          default: {
            processes: {
              distill: { enabled: true },
            },
          },
        },
      },
    });

    const result = await runJudgeCalibrationCase(
      makeCase(),
      makeContext(root, {
        XDG_CONFIG_HOME: path.join(root, "config"),
        HOME: root,
      }),
    );

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.skipReason).toContain("requires an LLM path");
    expect(result.skipReason).toContain("defaults.llm");
    expect(result.evidence.precondition).toBe(result.skipReason);
  });
});
