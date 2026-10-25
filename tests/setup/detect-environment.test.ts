// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the consolidated environment-detection pipeline (issue #514).
 *
 * Coverage:
 *   - `scanProviderEnvVars()` returns env var NAMES only — never values.
 *   - `detectStashDir()` ranking from a temp HOME/CWD.
 *   - `detectLocalServers()` tolerates every endpoint being down.
 *   - `detectEnvironment()` aggregator shape + safety invariant.
 *   - `runDetectOnly()` never returns an API key value.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectEnvironment, detectLocalServers, detectStashDir, scanProviderEnvVars } from "../../src/setup/detect";
import { runDetectOnly } from "../../src/setup/setup";
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
    } as NodeJS.ProcessEnv);
    const byVar = Object.fromEntries(result.map((r) => [r.envVar, r.kind]));
    expect(byVar.OPENAI_API_KEY).toBe("apiKey");
    expect(byVar.OLLAMA_HOST).toBe("endpoint");
  });

  test("does not read variables akm itself never reads", () => {
    expect(scanProviderEnvVars({ AKM_LLM_API_KEY: "y", AKM_LLM_ENDPOINT: "http://x" } as NodeJS.ProcessEnv)).toEqual(
      [],
    );
  });

  test("returns nothing for an empty environment", () => {
    expect(scanProviderEnvVars({} as NodeJS.ProcessEnv)).toEqual([]);
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
      expect(result[i]?.rank).toBeGreaterThanOrEqual(result[i - 1]!.rank);
    }
  });
});

describe("detectLocalServers", () => {
  test("tolerates all endpoints being down without throwing", async () => {
    const result = await detectLocalServers();
    expect(Array.isArray(result)).toBe(true);
    // Ollama, LM Studio and the generic 8080 server.
    expect(result).toHaveLength(3);
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

    expect(env.harnesses).toEqual([]);
    expect(Array.isArray(env.localServers)).toBe(true);
    expect(env.stashSuggestions[0]?.path).toBe(path.resolve("/cfg/stash"));
    expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);

    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(SECRET_VALUE);
  });

  test("lists the agent programs found on PATH, OpenCode like any other", async () => {
    const present = new Set(["claude", "opencode", "codex"]);
    const env = await detectEnvironment({
      envSource: {} as NodeJS.ProcessEnv,
      whichFn: (bin) => (present.has(bin) ? `/usr/bin/${bin}` : undefined),
      cwd: workDir,
      home: workDir,
      probe: false,
    });
    expect(env.harnesses.map((h) => h.platform)).toEqual(["opencode", "claude", "codex"]);
    expect(env.harnesses[1]).toEqual({ platform: "claude", bin: "claude", path: "/usr/bin/claude" });
  });

  test("an offline run does not contact the local servers", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("no network");
    }) as unknown as typeof fetch;
    try {
      const env = await detectEnvironment({
        envSource: {} as NodeJS.ProcessEnv,
        whichFn: () => undefined,
        probe: false,
      });
      expect(env.localServers).toEqual([]);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("runDetectOnly", () => {
  test("never returns an API key value", async () => {
    await withEnv({ ANTHROPIC_API_KEY: SECRET_VALUE }, async () => {
      const env = await runDetectOnly();
      expect(JSON.stringify(env)).not.toContain(SECRET_VALUE);
      expect(env.providers.some((p) => p.envVar === "ANTHROPIC_API_KEY")).toBe(true);
    });
  });
});
