// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the consolidated environment-detection pipeline (issue #514).
 *
 * Coverage:
 *   - `scanProviderEnvVars()` returns env var NAMES only — never values.
 *   - `pickDefaultModel()` name heuristic.
 *   - `detectStashDir()` ranking from a temp HOME/CWD.
 *   - `detectLocalServers()` tolerates every endpoint being down.
 *   - `detectEnvironment()` aggregator shape + safety invariant.
 *   - `deriveRecommendedConfig()` opinionated defaults.
 *   - `akm setup --detect-only` performs no config writes and emits JSON.
 *   - `akm setup --reset-recommended` preserves pre-existing custom keys.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resetGraphBoostCache } from "../../src/indexer/graph/graph-boost";
import { clearEmbeddingCache, resetLocalEmbedder } from "../../src/llm/embedder";
import {
  detectEnvironment,
  detectLocalServers,
  detectStashDir,
  pickDefaultModel,
  scanProviderEnvVars,
} from "../../src/setup/detect";
import { deriveRecommendedConfig, runDetectOnly } from "../../src/setup/setup";
import { runCliCapture } from "../_helpers/cli";
import { withEnv } from "../_helpers/sandbox";

// A value no test should ever surface anywhere in output.
const SECRET_VALUE = "sk-SECRET-VALUE-MUST-NEVER-LEAK-1234567890";

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-"));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("scanProviderEnvVars", () => {
  test("returns the env var NAME and never the value", () => {
    const fakeEnv = { ANTHROPIC_API_KEY: SECRET_VALUE } as NodeJS.ProcessEnv;
    const result = scanProviderEnvVars(fakeEnv);

    expect(result.length).toBe(1);
    const entry = result[0];
    expect(entry?.provider).toBe("anthropic");
    expect(entry?.envVar).toBe("ANTHROPIC_API_KEY");
    expect(entry?.kind).toBe("apiKey");

    // Hard invariant: the value must appear NOWHERE in the serialized result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_VALUE);
    // And no field carries the value under any key.
    for (const e of result) {
      for (const v of Object.values(e)) {
        expect(v).not.toBe(SECRET_VALUE);
      }
    }
  });

  test("ignores empty/whitespace-only env vars", () => {
    expect(scanProviderEnvVars({ OPENAI_API_KEY: "" } as NodeJS.ProcessEnv)).toEqual([]);
    expect(scanProviderEnvVars({ OPENAI_API_KEY: "   " } as NodeJS.ProcessEnv)).toEqual([]);
  });

  test("detects endpoint-kind vars and multiple providers", () => {
    const result = scanProviderEnvVars({
      OPENAI_API_KEY: "x",
      OLLAMA_HOST: "http://localhost:11434",
      AKM_LLM_API_KEY: "y",
    } as NodeJS.ProcessEnv);
    const byVar = Object.fromEntries(result.map((r) => [r.envVar, r.kind]));
    expect(byVar.OPENAI_API_KEY).toBe("apiKey");
    expect(byVar.OLLAMA_HOST).toBe("endpoint");
    expect(byVar.AKM_LLM_API_KEY).toBe("apiKey");
  });

  test("returns nothing for an empty environment", () => {
    expect(scanProviderEnvVars({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

describe("pickDefaultModel", () => {
  test("prefers an instruct variant", () => {
    expect(pickDefaultModel(["llama-3-8b", "llama-3-8b-instruct", "tiny"])).toBe("llama-3-8b-instruct");
  });
  test("prefers the longer name when no instruct variant", () => {
    expect(pickDefaultModel(["a", "longer-model-name", "mid"])).toBe("longer-model-name");
  });
  test("returns undefined for an empty list", () => {
    expect(pickDefaultModel([])).toBeUndefined();
  });
});

describe("detectStashDir", () => {
  test("suggests existing config stashDir at rank 0", () => {
    const result = detectStashDir({ existingStashDir: "/some/stash", cwd: workDir, home: workDir });
    expect(result[0]?.path).toBe(path.resolve("/some/stash"));
    expect(result[0]?.rank).toBe(0);
  });

  test("suggests akm/ inside a CWD git repo", () => {
    const repo = path.join(workDir, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "akm"), { recursive: true });
    const nested = path.join(repo, "src", "deep");
    fs.mkdirSync(nested, { recursive: true });

    const fakeHome = path.join(workDir, "emptyhome");
    fs.mkdirSync(fakeHome, { recursive: true });

    const result = detectStashDir({ cwd: nested, home: fakeHome });
    expect(result.some((s) => s.path === path.join(repo, "akm"))).toBe(true);
  });

  test("suggests ~/akm and ~/.akm when present, ranked after repo", () => {
    const fakeHome = path.join(workDir, "home");
    fs.mkdirSync(path.join(fakeHome, "akm"), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, ".akm"), { recursive: true });
    // cwd with no git repo
    const cwd = path.join(workDir, "nogit");
    fs.mkdirSync(cwd, { recursive: true });

    const result = detectStashDir({ cwd, home: fakeHome });
    const paths = result.map((s) => s.path);
    expect(paths).toContain(path.join(fakeHome, "akm"));
    expect(paths).toContain(path.join(fakeHome, ".akm"));
    // ranked ascending
    for (let i = 1; i < result.length; i++) {
      expect(result[i]?.rank).toBeGreaterThanOrEqual(result[i - 1]?.rank);
    }
  });
});

describe("detectLocalServers", () => {
  test("tolerates all endpoints being down without throwing", async () => {
    // Probe ports that are (essentially) never listening.
    const result = await detectLocalServers(["http://127.0.0.1:59999/v1"]);
    expect(Array.isArray(result)).toBe(true);
    // Generic defaults + the harness URL.
    expect(result.length).toBeGreaterThanOrEqual(4);
    for (const s of result) {
      expect(typeof s.available).toBe("boolean");
      expect(Array.isArray(s.models)).toBe(true);
    }
  });
});

describe("detectEnvironment aggregator", () => {
  test("returns a typed result with NAMES only (no key value)", async () => {
    const env = await detectEnvironment({
      existingStashDir: "/cfg/stash",
      envSource: { ANTHROPIC_API_KEY: SECRET_VALUE } as NodeJS.ProcessEnv,
      whichFn: () => undefined,
      cwd: workDir,
      home: workDir,
    });

    expect(["opencode-sdk", "opencode", "claude", "none"]).toContain(env.harness);
    expect(Array.isArray(env.localServers)).toBe(true);
    expect(env.stashSuggestions[0]?.path).toBe(path.resolve("/cfg/stash"));
    expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);

    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  test("selects claude harness when only claude bin is present", async () => {
    const env = await detectEnvironment({
      envSource: {} as NodeJS.ProcessEnv,
      whichFn: (bin) => (bin === "claude" ? "/usr/bin/claude" : undefined),
      cwd: workDir,
      home: workDir,
    });
    // opencode-sdk may resolve if installed; only assert no crash and a valid value.
    expect(["opencode-sdk", "claude"]).toContain(env.harness);
  });
});

describe("deriveRecommendedConfig", () => {
  test("uses a cloud provider endpoint when no local server is live", () => {
    const recommended = deriveRecommendedConfig({
      harness: "claude",
      providers: [{ provider: "anthropic", envVar: "ANTHROPIC_API_KEY", kind: "apiKey" }],
      harnessConfigs: [],
      localServers: [{ baseUrl: "http://localhost:11434", label: "Ollama", available: false, models: [] }],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.agentDefault).toBe("claude");
    expect(recommended.llm?.provider).toBe("anthropic");
    expect(recommended.llm?.endpoint).toContain("anthropic.com");
    expect(recommended.taskSchedules?.improve).toBe("0 2 * * *");
    expect(recommended.taskSchedules?.index).toBe("0 4 * * *");
    // No API key value is ever present.
    expect(JSON.stringify(recommended)).not.toContain(SECRET_VALUE);
  });

  test("prefers a live local server with nomic-embed-text embeddings", () => {
    const recommended = deriveRecommendedConfig({
      harness: "none",
      providers: [],
      harnessConfigs: [],
      localServers: [
        {
          baseUrl: "http://localhost:1234",
          label: "LM Studio",
          available: true,
          models: ["m-instruct"],
          defaultModel: "m-instruct",
        },
      ],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.llm?.model).toBe("m-instruct");
    expect(recommended.embedding?.model).toBe("nomic-embed-text");
  });

  test("(#566) derives the agent default profile name from the harness registry", () => {
    // The old hardcoded if-chain only knew claude/opencode/opencode-sdk; the
    // default is now derived from the registry so any dispatch-capable harness
    // gets its canonical id as the headless default.
    for (const id of ["opencode", "claude", "opencode-sdk"] as const) {
      const recommended = deriveRecommendedConfig({
        harness: id,
        providers: [],
        harnessConfigs: [],
        localServers: [],
        stashSuggestions: [],
        agentPlatforms: [],
      });
      expect(recommended.agentDefault).toBe(id);
    }
  });

  test("(#566) harness 'none' yields no agent default (no spurious profile)", () => {
    const recommended = deriveRecommendedConfig({
      harness: "none",
      providers: [],
      harnessConfigs: [],
      localServers: [],
      stashSuggestions: [],
      agentPlatforms: [],
    });
    expect(recommended.agentDefault).toBeUndefined();
  });
});

// ── CLI integration ──────────────────────────────────────────────────────────

async function runCli(argv: string[], env: Record<string, string | undefined> = {}) {
  return withEnv(env, async () => {
    clearEmbeddingCache();
    resetLocalEmbedder();
    resetGraphBoostCache();
    const { stdout, stderr, code } = await runCliCapture(argv);
    return { status: code, stdout, stderr };
  });
}

describe("akm setup --detect-only", () => {
  test("emits JSON, performs no config writes, shows no prompts", async () => {
    const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-cfg-"));
    const xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-data-"));
    const xdgState = fs.mkdtempSync(path.join(os.tmpdir(), "akm-detect-state-"));
    const configPath = path.join(xdgConfig, "akm", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({ configVersion: "0.9.0", stashDir: workDir, archiveRetentionDays: 42 }, null, 2);
    fs.writeFileSync(configPath, original, "utf8");

    try {
      const result = await runCli(["setup", "--detect-only", "--format", "json"], {
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        AKM_STASH_DIR: workDir,
        // Provide a fake key var to confirm the value never reaches stdout.
        ANTHROPIC_API_KEY: SECRET_VALUE,
      });

      expect(result.status).toBe(0);
      // stdout parses as JSON.
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toBeTruthy();
      // No API key value leaked into stdout.
      expect(result.stdout).not.toContain(SECRET_VALUE);
      // Config file is byte-for-byte unchanged.
      expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    } finally {
      for (const d of [xdgConfig, xdgData, xdgState]) fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("runDetectOnly never returns an API key value", async () => {
    await withEnv({ ANTHROPIC_API_KEY: SECRET_VALUE }, async () => {
      const env = await runDetectOnly();
      expect(JSON.stringify(env)).not.toContain(SECRET_VALUE);
      expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);
    });
  });
});

describe("akm setup --reset-recommended", () => {
  test("merges defaults while preserving pre-existing custom keys", async () => {
    const xdgConfig = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reset-cfg-"));
    const xdgData = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reset-data-"));
    const xdgState = fs.mkdtempSync(path.join(os.tmpdir(), "akm-reset-state-"));
    const configPath = path.join(xdgConfig, "akm", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Seed a config with a custom registry entry that must survive the merge.
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          configVersion: "0.9.0",
          stashDir: workDir,
          // A pre-existing custom key that must survive the merge.
          archiveRetentionDays: 7,
          registries: [{ name: "custom-reg", url: "https://example.com/registry.json", enabled: true }],
        },
        null,
        2,
      ),
      "utf8",
    );

    try {
      const result = await runCli(["setup", "--reset-recommended", "--no-init", "--format", "json"], {
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_STATE_HOME: xdgState,
        AKM_STASH_DIR: workDir,
        // The temp stash dir lives under /tmp; opt past the setup/init guards
        // the test runner enforces for that path.
        AKM_FORCE_SETUP_TMP_STASH: "1",
        AKM_FORCE_INIT_TMP_STASH: "1",
      });

      expect(result.status).toBe(0);
      const written = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        registries?: Array<{ name?: string }>;
        archiveRetentionDays?: number;
        setup?: { taskSchedules?: { improve?: string; index?: string } };
      };
      // The pre-existing custom keys survived.
      expect(written.registries?.some((r) => r.name === "custom-reg")).toBe(true);
      expect(written.archiveRetentionDays).toBe(7);
      // Opinionated cron defaults were merged in.
      expect(written.setup?.taskSchedules?.improve).toBe("0 2 * * *");
      expect(written.setup?.taskSchedules?.index).toBe("0 4 * * *");
    } finally {
      for (const d of [xdgConfig, xdgData, xdgState]) fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
