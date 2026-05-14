import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { type AkmDistillOptions, type AkmDistillResult, akmDistill } from "../../src/commands/distill";
import { akmImprove } from "../../src/commands/improve";
import { akmPropose } from "../../src/commands/propose";
import type { AkmReflectOptions } from "../../src/commands/reflect";
import { akmReflect } from "../../src/commands/reflect";
import type { AkmConfig } from "../../src/core/config";
import { listProposals } from "../../src/core/proposals";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { SpawnedSubprocess, SpawnFn } from "../../src/integrations/agent/spawn";

const tempDirs: string[] = [];
const savedEnv = {
  AKM_STASH_DIR: process.env.AKM_STASH_DIR,
  AKM_DATA_DIR: process.env.AKM_DATA_DIR,
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
  process.env.AKM_DATA_DIR = makeTempDir("akm-improve-cli-data-");
  process.env.XDG_CACHE_HOME = makeTempDir("akm-improve-cli-cache-");
  process.env.XDG_CONFIG_HOME = makeTempDir("akm-improve-cli-config-");
});

afterEach(() => {
  if (savedEnv.AKM_STASH_DIR === undefined) delete process.env.AKM_STASH_DIR;
  else process.env.AKM_STASH_DIR = savedEnv.AKM_STASH_DIR;
  if (savedEnv.AKM_DATA_DIR === undefined) delete process.env.AKM_DATA_DIR;
  else process.env.AKM_DATA_DIR = savedEnv.AKM_DATA_DIR;
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
    const stash = makeStashDir();
    const result = await akmImprove({ scope: "skill:deploy", dryRun: true, stashDir: stash });
    expect(result.scope).toEqual({ mode: "ref", value: "skill:deploy" });
  });

  test("memory-focused improve run can queue knowledge-oriented distill proposals", async () => {
    const stash = makeStashDir();
    const memoryFile = path.join(stash, "memories", "deploy-fact.md");
    fs.writeFileSync(
      memoryFile,
      [
        "---",
        "description: Deployment requires VPN access",
        "source: skill:deploy",
        "observed_at: 2026-04-20",
        "confidence: 0.92",
        "quality: curated",
        "---",
        "",
        "Connect the VPN before production deploys so cluster access works.",
        "",
      ].join("\n"),
      "utf8",
    );

    const reflected: AkmReflectOptions[] = [];
    const distilled: AkmDistillOptions[] = [];
    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
    } as AkmConfig;

    const feedbackEvents = (() => ({
      events: [0, 1].map((i) => ({
        schemaVersion: 1 as const,
        id: i,
        ts: `2026-04-27T00:00:0${i}Z`,
        eventType: "feedback",
        ref: "memory:deploy-fact",
        metadata: { signal: "positive" },
      })),
      nextOffset: 0,
    })) as never;

    const result = await akmImprove({
      scope: "memory:deploy-fact",
      stashDir: stash,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        updated: 0,
        deleted: 0,
        warnings: [],
      }),
      reflectFn: async (options) => {
        reflected.push(options);
        return {
          schemaVersion: 1,
          ok: true,
          ref: options.ref ?? "memory:deploy-fact",
          agentProfile: "fake-agent",
          durationMs: 1,
          proposal: {
            id: "reflect-1",
            ref: "memory:deploy-fact",
            status: "pending",
            source: "reflect",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
            payload: { content: "# reflect" },
          },
        };
      },
      distillFn: async (options) => {
        distilled.push(options);
        return akmDistill({
          ...options,
          config,
          stashDir: stash,
          chat: async () => {
            throw new Error("chat must not be called for deterministic memory promotion");
          },
          lookupFn: async () => memoryFile,
          readEventsFn: feedbackEvents,
        });
      },
    });

    expect(reflected.map((call) => call.ref)).toContain("memory:deploy-fact");
    expect(distilled).toHaveLength(1);
    expect(distilled[0].proposalKind).toBe("auto");
    expect(result.actions?.some((action) => action.mode === "distill")).toBe(true);
    const distillAction = result.actions?.find((action) => action.mode === "distill");
    expect(distillAction?.mode).toBe("distill");
    if (!distillAction || distillAction.mode !== "distill") {
      throw new Error("expected distill action");
    }
    const distillResult = distillAction.result as AkmDistillResult;
    expect(distillResult.ok).toBe(true);
    if (distillResult.ok !== true || distillResult.outcome !== "queued") {
      throw new Error("expected queued distill result");
    }
    expect(distillResult.proposalKind).toBe("knowledge");
    expect(distillResult.proposalRef).toBe("knowledge:deploy-fact");
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ref).toBe("knowledge:deploy-fact");
  });

  test("skill-scoped improve passes related lesson evidence into reflect for promotion decisions", async () => {
    const stash = makeStashDir();
    fs.writeFileSync(
      path.join(stash, "lessons", "skill-deploy-lesson.md"),
      "---\ndescription: Capture rollback invariants\nwhen_to_use: When updating deployment guidance\nsources:\n  - skill:deploy\n---\n\nRecord rollback checks and readiness gates after repeated incidents.\n",
      "utf8",
    );

    const config = {
      stashDir: stash,
      sources: [{ type: "filesystem", name: "stash", path: stash, writable: true }],
      defaultWriteTarget: "stash",
    } as AkmConfig;

    let capturedPrompt = "";
    const reflected: string[] = [];
    const distilled: string[] = [];

    const result = await akmImprove({
      scope: "skill:deploy",
      stashDir: stash,
      config,
      ensureIndexFn: async () => undefined,
      reindexFn: async () => ({
        schemaVersion: 1,
        ok: true,
        indexed: 0,
        warnings: [],
        errors: [],
        durationMs: 0,
      }),
      reflectFn: async (options) => {
        reflected.push(options.ref ?? "");
        return akmReflect({
          ...options,
          stashDir: stash,
          agentProfile: makeProfile(),
          runAgentOptions: {
            spawn: (cmd, spawnOpts) => {
              capturedPrompt = cmd.at(-1) ?? "";
              return fakeSpawn(
                JSON.stringify({
                  ref: "knowledge:skills/deploy/references/rollback-gates",
                  content: "# Rollback gates\n\nCapture rollback invariants and readiness checks.\n",
                }),
                "",
                0,
              )(cmd, spawnOpts);
            },
          },
        });
      },
      distillFn: async ({ ref }) => {
        if (ref) distilled.push(ref);
        return {
          schemaVersion: 1,
          ok: true,
          outcome: "queued",
          inputRef: ref,
          lessonRef: `lesson:${ref.replace(/[:/]/g, "-")}-lesson`,
        } satisfies AkmDistillResult;
      },
    });

    expect(result.plannedRefs.map((planned) => planned.ref)).toEqual(["skill:deploy"]);
    expect(reflected).toEqual(["skill:deploy"]);
    expect(distilled).toEqual(["skill:deploy"]);
    expect(capturedPrompt).toContain("Related distilled lessons to evaluate for consolidation:");
    expect(capturedPrompt).toContain("Lesson ref: lesson:skill-deploy-lesson");
    expect(capturedPrompt).toContain("Record rollback checks and readiness gates after repeated incidents.");
    expect(capturedPrompt).toContain("knowledge:skills/<skill>/references/<topic>");
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
