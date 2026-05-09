import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { akmImprove } from "../../src/commands/improve";
import { akmPropose } from "../../src/commands/propose";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeStashDir(): string {
  const stash = makeTempDir("akm-improve-cli-stash-");
  for (const sub of ["lessons", "skills", "memories", "knowledge"]) {
    fs.mkdirSync(path.join(stash, sub), { recursive: true });
  }
  fs.mkdirSync(path.join(stash, "skills", "deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(stash, "skills", "deploy", "SKILL.md"),
    "---\ndescription: deploy apps\nwhen_to_use: shipping\n---\n\nDeploy carefully.\n",
    "utf8",
  );
  return stash;
}

function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "fake-agent",
    bin: "fake-agent",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function asReadableStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakeSpawn(stdout: string, stderr: string, exitCode: number): SpawnFn {
  return () =>
    ({
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    }) satisfies SpawnedSubprocess;
}

const VALID_SKILL_PAYLOAD = JSON.stringify({
  ref: "skill:hello",
  content: "---\ndescription: Say hi\nwhen_to_use: When greeting\n---\n\nSay hi politely.\n",
});

beforeEach(() => {
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-cli-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-cli-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = savedEnv.XDG_CACHE_HOME;
  if (savedEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("improve argv coercion", () => {
  test("empty scope becomes all-mode", async () => {
    const result = await akmImprove({ dryRun: true });
    expect(result.scope.mode).toBe("all");
  });

  test("type scope is preserved", async () => {
    const result = await akmImprove({ scope: "memory", dryRun: true });
    expect(result.scope).toEqual({ mode: "type", value: "memory" });
  });

  test("ref scope is preserved", async () => {
    const result = await akmImprove({ scope: "skill:deploy", dryRun: true });
    expect(result.scope).toEqual({ mode: "ref", value: "skill:deploy" });
  });
});

describe("propose file-backed input", () => {
  test("akmPropose accepts file-loaded task text the same as inline text", async () => {
    const stash = makeStashDir();
    const promptFile = path.join(makeTempDir("akm-propose-file-"), "prompt.md");
    fs.writeFileSync(promptFile, "Say hi", "utf8");
    const task = fs.readFileSync(promptFile, "utf8");
    const result = await akmPropose({
      type: "skill",
      name: "hello",
      task,
      stashDir: stash,
      agentProfile: makeProfile(),
      runAgentOptions: { spawn: fakeSpawn(VALID_SKILL_PAYLOAD, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.ref).toBe("skill:hello");
  });
});
