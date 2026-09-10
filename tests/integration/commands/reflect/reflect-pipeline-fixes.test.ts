/**
 * Reflect pipeline safety-rail tests.
 *
 * Covers the regressions found in the May 2026 review of 323 reflect proposals:
 *
 *   1. Frontmatter stripped on rewrite (15+ cases).
 *   2. Catastrophic content shrinkage (75 → 3 lines, 200 → 4 lines).
 *   3. Reflect prepending YAML frontmatter to executable `.ts` script assets.
 *   4. Reflect renaming a skill's identity `name` field.
 *   5. Excessive expansion (>2× source).
 *
 * Each defect is now a hard safety rail in `src/commands/reflect.ts`. These
 * tests lock the rails in place so future refactors cannot reintroduce the
 * regression silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { akmProposalAccept } from "../../../../src/commands/proposal/proposal";
import { createProposal, isProposalSkipped, listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { ConfigError } from "../../../../src/core/errors";
import { appendEvent, readEvents } from "../../../../src/core/events";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import { _setWarnSinkForTests } from "../../../../src/core/warn";
import { REFLECT_TRUNCATION_MARKER } from "../../../../src/integrations/agent/prompts";
import { durableItemRef } from "../../../_helpers/durable-ref";
import { makeConfig, quietQualityGateConfig } from "../../../_helpers/factories";
import { type IsolatedAkmStorage, mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../../../_helpers/sandbox";

// ── Setup ─────────────────────────────────────────────────────────────────────

let storage: IsolatedAkmStorage;

function makeStashDir(): string {
  return storage.stashDir;
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
  return () => {
    const proc: SpawnedSubprocess = {
      exitCode,
      exited: Promise.resolve(exitCode),
      stdout: asReadableStream(stdout),
      stderr: asReadableStream(stderr),
      stdin: null,
      kill: () => undefined,
    };
    return proc;
  };
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
});

/**
 * A 500-character body of concrete content the LLM should be preserving.
 * The shrink / expand tests reference this so the size-guard thresholds
 * (50% min, 200% max) can be evaluated meaningfully.
 */
const LONG_SOURCE_BODY = [
  "# Krang split-horizon AdGuard YAML",
  "",
  "## Required config",
  "",
  "1. Set `bind_host` to `0.0.0.0` so both LAN and VPN clients are served.",
  "2. Add upstream `tls://1.1.1.1` for sanitised DNS over TLS.",
  "3. Register split-horizon rules:",
  "   - `/internal.example.com/192.168.10.5`",
  "   - `/public.example.com/cname:host.example.com`",
  "4. Set `cache_size: 2000` and `cache_ttl_min: 60`.",
  "",
  "## Verification",
  "",
  "- Run `dig @192.168.10.5 internal.example.com` from the LAN.",
  "- Run `dig @1.1.1.1 internal.example.com` externally and confirm NXDOMAIN.",
  "- Check `/var/log/AdGuardHome/query.log` shows both legs.",
].join("\n");

// ── 1. Type guard — reflect refuses executable / non-markdown types ───────────

describe("Reflect type guard — refuses non-markdown asset types", () => {
  test("script:* ref is rejected up-front with a clear error", async () => {
    const stash = makeStashDir();
    let spawned = false;
    const spy: SpawnFn = (cmd) => {
      spawned = true;
      return fakeSpawn("", "", 0)(cmd, {});
    };

    const result = await akmReflect({
      ref: "scripts/deploy.ts",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: spy },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Reason changed 2026-05-26: deterministic type-guard rejections (LLM
    // never invoked) now route through `unsupported_type` so the improve
    // loop can map them to `reflect-skipped` instead of inflating
    // `reflect-failed`. See metrics-taxonomy-review §1a.
    expect(result.reason).toBe("unsupported_type");
    expect(result.error).toContain("not supported by reflect");
    expect(result.error).toContain("script");
    // Spawning the agent must NOT happen — the guard fires before the agent invocation.
    expect(spawned).toBe(false);
    expect(listProposals(stash).length).toBe(0);
  });

  test("env:* ref is rejected (.env files must never get YAML frontmatter)", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "env/default",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn("", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("unsupported_type");
    expect(result.error).toContain("env");
  });

  test("secret:* ref is rejected (08-F2: secret material must never reach reflect's LLM)", async () => {
    const stash = makeStashDir();
    let spawned = false;
    const spy: SpawnFn = (cmd) => {
      spawned = true;
      return fakeSpawn("", "", 0)(cmd, {});
    };
    const result = await akmReflect({
      ref: "secrets/signing-key",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: spy },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Allowlist (REFLECT_ALLOWED_TYPES) refuses structurally — the LLM is never
    // spawned, so secret bytes are never read or sent.
    expect(result.reason).toBe("unsupported_type");
    expect(result.error).toContain("secret");
    expect(spawned).toBe(false);
  });

  test("task:* ref is rejected (YAML tasks are not markdown-shaped)", async () => {
    const stash = makeStashDir();
    const result = await akmReflect({
      ref: "tasks/nightly-backup",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn("", "", 0) },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("unsupported_type");
  });

  test("knowledge:* (markdown-canonical) is allowed by the type guard", async () => {
    const stash = makeStashDir();
    // No source asset on disk — reflect produces a proposal without size-guard checks.
    const payload = JSON.stringify({
      ref: "knowledge/foo",
      content: "---\ndescription: Foo doc\n---\n\nBody of foo.",
    });
    const result = await akmReflect({
      ref: "knowledge/foo",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    // Allowed by the type guard — should at least pass that stage without
    // returning the "not supported" error.
    if (!result.ok) {
      expect(result.error).not.toContain("not supported by reflect");
    } else {
      expect(result.proposal.ref).toBe(durableItemRef(stash, "knowledge", "foo"));
    }
  });

  test("a type outside the fixed list is allowed when its content is genuinely frontmatter + markdown", async () => {
    const stash = makeStashDir();
    const sourceContent = "---\ndescription: Existing instruction doc\n---\n\nFollow these steps.\n";
    const payload = JSON.stringify({
      ref: "instructions/onboarding",
      content: "---\ndescription: Existing instruction doc\n---\n\nFollow these revised steps.",
    });
    const result = await akmReflect({
      ref: "instructions/onboarding",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    if (!result.ok) throw new Error(`expected success, got: ${result.error}`);
    expect(result.proposal.ref).toContain("instructions/onboarding");
  });

  test("an unregistered/custom type with no existing content is still refused, not minted fresh", async () => {
    const stash = makeStashDir();
    let spawned = false;
    const result = await akmReflect({
      ref: "widgets/new-thing",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: {
        spawn: (cmd) => {
          spawned = true;
          return fakeSpawn("", "", 0)(cmd, {});
        },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("unsupported_type");
    expect(spawned).toBe(false);
  });
});

// ── 2. Frontmatter preservation ─────────────────────────────────────────────────

describe("Reflect frontmatter preservation — source frontmatter survives rewrite", () => {
  test("LLM body without frontmatter still results in source frontmatter being present", async () => {
    const stash = makeStashDir();
    // Source asset has rich frontmatter the LLM does NOT emit.
    const sourceContent = [
      "---",
      "description: Release policy for production deploys",
      "when_to_use: Whenever you cut a release branch",
      "tags:",
      "  - release",
      "  - policy",
      "---",
      "",
      LONG_SOURCE_BODY,
      "",
    ].join("\n");

    // LLM rewrites the body only — no frontmatter (correct per new prompt).
    const llmBody = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const payload = JSON.stringify({ ref: "knowledge/policies/release", content: llmBody });

    const result = await akmReflect({
      ref: "knowledge/policies/release",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // Frontmatter must be present and contain the original keys.
    expect(finalContent.startsWith("---\n")).toBe(true);
    expect(finalContent).toContain("description: Release policy for production deploys");
    expect(finalContent).toContain("when_to_use: Whenever you cut a release branch");
    expect(finalContent).toContain("- release");
    expect(finalContent).toContain("- policy");
    // Body must include the improved heading.
    expect(finalContent).toContain("## Required configuration");
  });

  test("LLM emits its own frontmatter block in body — stripped but kept via merge", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Original desc\ntags:\n  - one\n  - two\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM disobeys the prompt and emits frontmatter inside `content`.
    const llmBlob = [
      "---",
      "description: Updated description by LLM",
      "extra_field: added by LLM",
      "---",
      "",
      LONG_SOURCE_BODY,
    ].join("\n");
    const payload = JSON.stringify({ ref: "knowledge/x", content: llmBlob });

    const result = await akmReflect({
      ref: "knowledge/x",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // Source `tags` survive even though the LLM tried to replace the frontmatter.
    expect(finalContent).toContain("- one");
    expect(finalContent).toContain("- two");
    // LLM's new field is merged in (LLM can ADD keys, not remove them).
    expect(finalContent).toContain("extra_field");
    // The frontmatter block appears exactly once (no double `---`).
    const fmDelimCount = (finalContent.match(/^---$/gm) ?? []).length;
    expect(fmDelimCount).toBe(2);
  });
});

describe("Reflect quality gate — source context", () => {
  test("validates the separately resolved judge credential before agent generation or reflect events", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Judge preflight boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
    const candidateContent = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        judge: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "judge-model",
          apiKey: "$AKM_REFLECT_JUDGE_REQUIRED_KEY",
        },
      },
      defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
    } as AkmConfig;
    let spawned = 0;

    await withEnv({ AKM_REFLECT_JUDGE_REQUIRED_KEY: undefined }, async () => {
      await expect(
        akmReflect({
          ref: "knowledge/judge-preflight",
          stashDir: stash,
          config,
          assetContent: sourceContent,
          runAgentOptions: {
            spawn: (...args) => {
              spawned += 1;
              return fakeSpawn(
                JSON.stringify({ ref: "knowledge/judge-preflight", content: candidateContent }),
                "",
                0,
              )(...args);
            },
          },
          chat: async () => JSON.stringify({ score: 5, reason: "pass" }),
        }),
      ).rejects.toBeInstanceOf(ConfigError);
    });

    expect(spawned).toBe(0);
    expect(listProposals(stash)).toEqual([]);
    expect(readEvents({ type: "reflect_invoked" }).events).toEqual([]);
  });

  test("skips the gate and flags the proposal for review when frozen judge selection has no LLM runner", async () => {
    const stash = makeStashDir();
    let spawned = 0;
    const config = quietQualityGateConfig();
    const processes = config.improve?.strategies?.default?.processes;
    if (!processes) throw new Error("quiet quality-gate fixture is missing the default process config");
    processes.reflect = { qualityGate: { enabled: true } };

    const warnings: string[] = [];
    _setWarnSinkForTests((level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });

    let result: Awaited<ReturnType<typeof akmReflect>>;
    try {
      result = await akmReflect({
        ref: "knowledge/no-judge-runner",
        stashDir: stash,
        config,
        runAgentOptions: {
          spawn: (...args) => {
            spawned += 1;
            return fakeSpawn(
              JSON.stringify({ ref: "knowledge/no-judge-runner", content: LONG_SOURCE_BODY }),
              "",
              0,
            )(...args);
          },
        },
      });
    } finally {
      _setWarnSinkForTests(undefined);
    }

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reflect to succeed with the gate skipped");
    expect(spawned).toBe(1);
    expect(warnings.some((line) => line.includes("no LLM configured"))).toBe(true);
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "no-judge-configured" });
  });

  test.each([
    { mutation: "deletion", nextCredential: undefined },
    { mutation: "replacement", nextCredential: "replacement-secret" },
  ])("agent generation and its separately resolved judge survive ambient credential $mutation", async ({
    nextCredential,
  }) => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Judge lease boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
    const candidateContent = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        judge: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "judge-model",
          apiKey: "$AKM_REFLECT_JUDGE_LEASE_KEY",
        },
      },
      defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
    } as AkmConfig;
    const original = "reflect-judge-original-secret";
    const observed: Array<string | undefined> = [];
    const spawn = fakeSpawn(JSON.stringify({ ref: "knowledge/judge-lease", content: candidateContent }), "", 0);

    const result = await withEnv({ AKM_REFLECT_JUDGE_LEASE_KEY: original }, () =>
      akmReflect({
        ref: "knowledge/judge-lease",
        stashDir: stash,
        config,
        assetContent: sourceContent,
        runAgentOptions: {
          spawn: (...args) => {
            mutateScopedEnv("AKM_REFLECT_JUDGE_LEASE_KEY", nextCredential);
            return spawn(...args);
          },
        },
        chat: async (connection) => {
          observed.push(connection.apiKey);
          return JSON.stringify({ score: 5, reason: "pass" });
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(observed).toEqual([original]);
    expect(listProposals(stash)).toHaveLength(1);
  });

  test("SDK fallback generation and a separate judge snapshot both credentials before invocation", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: SDK and judge lease boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
    const candidateContent = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "sdk-generator": { kind: "agent", platform: "opencode-sdk", llmEngine: "sdk-fallback" },
        "sdk-fallback": {
          kind: "llm",
          endpoint: "https://fallback.example.test/v1/chat/completions",
          model: "fallback",
          apiKey: "$AKM_REFLECT_SDK_FALLBACK_KEY",
        },
        judge: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "judge-model",
          apiKey: "$AKM_REFLECT_SDK_JUDGE_KEY",
        },
      },
      defaults: { engine: "sdk-generator", llmEngine: "judge", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
    } as AkmConfig;
    const sdkSecret = "reflect-sdk-original-secret";
    const judgeSecret = "reflect-sdk-judge-original-secret";
    const observedSdk: Array<string | undefined> = [];
    const observedJudge: Array<string | undefined> = [];

    const result = await withEnv(
      { AKM_REFLECT_SDK_FALLBACK_KEY: sdkSecret, AKM_REFLECT_SDK_JUDGE_KEY: judgeSecret },
      () =>
        akmReflect({
          ref: "knowledge/sdk-judge-lease",
          stashDir: stash,
          config,
          assetContent: sourceContent,
          runSdk: async (_profile, _prompt, _options, fallbackConnection) => {
            observedSdk.push(fallbackConnection?.apiKey);
            mutateScopedEnv("AKM_REFLECT_SDK_FALLBACK_KEY", undefined);
            mutateScopedEnv("AKM_REFLECT_SDK_JUDGE_KEY", undefined);
            return {
              ok: true,
              exitCode: 0,
              stdout: JSON.stringify({ ref: "knowledge/sdk-judge-lease", content: candidateContent }),
              stderr: "",
              durationMs: 1,
            };
          },
          chat: async (connection) => {
            observedJudge.push(connection.apiKey);
            return JSON.stringify({ score: 5, reason: "pass" });
          },
        }),
    );

    expect(result.ok).toBe(true);
    expect(observedSdk).toEqual([sdkSecret]);
    expect(observedJudge).toEqual([judgeSecret]);
    expect(listProposals(stash)).toHaveLength(1);
  });

  test("judges the proposal against the source content already loaded by reflect", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Source context regression guard\n---\n\nSOURCE_ONLY_MARKER\n\n${LONG_SOURCE_BODY}\n`;
    const candidateContent = LONG_SOURCE_BODY.replace("## Required config", "## Required configuration");
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        judge: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
        },
      },
      defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
      improve: {
        strategies: { default: { processes: { distill: { qualityGate: { enabled: true } } } } },
      },
    } as AkmConfig;
    let judgePrompt = "";

    const result = await akmReflect({
      ref: "knowledge/quality-source",
      stashDir: stash,
      config,
      assetContent: sourceContent,
      runAgentOptions: {
        spawn: fakeSpawn(JSON.stringify({ ref: "knowledge/quality-source", content: candidateContent }), "", 0),
      },
      chat: async (_connection, messages) => {
        judgePrompt = messages[1]?.content ?? "";
        return JSON.stringify({ score: 4.5, reason: "adds useful detail" });
      },
    });

    expect(result.ok).toBe(true);
    expect(judgePrompt).toContain("SOURCE_ONLY_MARKER");
    expect(judgePrompt).toContain("FEEDBACK ALIGNMENT");
    expect(judgePrompt).toContain("PRESERVATION");
    expect(judgePrompt).not.toContain("Does the lesson add information not already present");
    const proposedRevision = judgePrompt.split("Proposed revision:")[1] ?? "";
    expect(proposedRevision).toContain("description: Source context regression guard");
  });

  test("flags an invalid-size candidate for review without invoking the judge", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Long doc\n---\n\n${LONG_SOURCE_BODY}\n`;
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
      },
      defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { distill: { qualityGate: { enabled: true } } } } } },
    } as AkmConfig;
    let judgeInvoked = false;

    const result = await akmReflect({
      ref: "knowledge/invalid-before-judge",
      stashDir: stash,
      config,
      assetContent: sourceContent,
      runAgentOptions: {
        spawn: fakeSpawn(
          JSON.stringify({ ref: "knowledge/invalid-before-judge", content: "Tiny replacement." }),
          "",
          0,
        ),
      },
      chat: async () => {
        judgeInvoked = true;
        return JSON.stringify({ score: 5, reason: "must not run" });
      },
    });

    expect(result.ok).toBe(true);
    expect(judgeInvoked).toBe(false);
    if (!result.ok) throw new Error("expected success");
    expect(listProposals(stash)[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-size-ratio" });
  });
});

// ── 3. Size guards — shrink and expand ────────────────────────────────────────

describe("Reflect size guard — diff-size safety rails", () => {
  test("body shrunk below 50% of source is flagged for review, not discarded", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Long doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM returns a 3-line body (catastrophic shrinkage seen in the May 2026 review).
    const tinyBody = "Use AdGuard.\nDone.\n";
    const payload = JSON.stringify({ ref: "knowledge/shrink", content: tinyBody });

    const result = await akmReflect({
      ref: "knowledge/shrink",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    // A size-ratio hit says nothing about whether the revision is WRONG, only
    // that it is unusual — the LLM responded fine. It no longer discards the
    // revision (content_policy_reject); the proposal is still queued, flagged
    // for review via its gateDecision instead.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-size-ratio" });
    expect(proposals[0]?.gateDecision?.measured).toBeLessThan(50);
  });

  test("body expanded above 250% of source is flagged for review, not discarded", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Tight doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // LLM quintupled the asset with speculative material (5× > 2500-byte absolute ceiling).
    const bloatedBody = `${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}\n\n${LONG_SOURCE_BODY}`;
    const payload = JSON.stringify({ ref: "knowledge/expand", content: bloatedBody });

    const result = await akmReflect({
      ref: "knowledge/expand",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-size-ratio" });
    expect(proposals[0]?.gateDecision?.measured).toBeGreaterThan(250);
  });

  test("modest size change (~120%) passes the size guard", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Doc\n---\n\n${LONG_SOURCE_BODY}\n`;

    // Small, justified addition.
    const improvedBody = `${LONG_SOURCE_BODY}\n\n## Notes\n\nVerify with the on-call.`;
    const payload = JSON.stringify({ ref: "knowledge/modest", content: improvedBody });

    const result = await akmReflect({
      ref: "knowledge/modest",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
  });

  test("tiny source asset (<200 bytes) skips size guard so seed assets still work", async () => {
    const stash = makeStashDir();

    // 4× expansion would normally trip the guard, but source body is below the
    // REFLECT_SIZE_GUARD_MIN_BYTES floor so the rail is intentionally permissive.
    const payload = JSON.stringify({
      ref: "lessons/tiny",
      content: "Use rg for searching large repositories. rg is faster than grep and respects .gitignore.\n",
    });

    const result = await akmReflect({
      ref: "lessons/tiny",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent:
        "---\ndescription: A tiny repository search lesson\nwhen_to_use: Testing the small-source size guard\n---\nUse rg.\n",
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
  });
});

// ── 4. Protected identity fields — name / ref / id / slug / type ──────────────

describe("Reflect identity guard — protected frontmatter fields cannot be renamed", () => {
  test("LLM renaming `name` is restored to the source value", async () => {
    const stash = makeStashDir();
    const sourceBody = LONG_SOURCE_BODY;
    const sourceContent = [
      "---",
      "name: openpalm-stack-diagnostics",
      "description: Diagnose the OpenPalm stack",
      "when_to_use: When the stack reports degraded health",
      "---",
      "",
      sourceBody,
      "",
    ].join("\n");

    // LLM tries to rename the skill in frontmatter (#26941510). The body also
    // carries a substantive edit — without one, restoring `name` would leave
    // an empty diff and the #580 noise gate would suppress the proposal
    // before the assertions below could inspect it.
    const llmBlob = [
      "---",
      "name: diagnostic-checklist",
      "description: Diagnose the OpenPalm stack",
      "when_to_use: When the stack reports degraded health",
      "---",
      "",
      sourceBody,
      "",
      "A genuinely new troubleshooting paragraph added by the agent.",
    ].join("\n");
    const payload = JSON.stringify({ ref: "skills/openpalm-stack-diagnostics", content: llmBlob });

    const result = await akmReflect({
      ref: "skills/openpalm-stack-diagnostics",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    // The `name` must be restored to the source value.
    expect(finalContent).toContain("name: openpalm-stack-diagnostics");
    expect(finalContent).not.toContain("name: diagnostic-checklist");
    // payload frontmatter object should also carry the restored name.
    expect(result.proposal.payload.frontmatter?.name).toBe("openpalm-stack-diagnostics");
  });

  test("LLM emitting a different `id` field is silently overwritten to source", async () => {
    const stash = makeStashDir();
    const sourceContent = ["---", "id: original-id-12345", "description: doc", "---", "", LONG_SOURCE_BODY, ""].join(
      "\n",
    );

    // As above: include a substantive body edit so the restored-`id` proposal
    // is not an empty diff (which the #580 noise gate would suppress).
    const llmBlob = [
      "---",
      "id: fabricated-by-llm",
      "description: doc",
      "---",
      "",
      LONG_SOURCE_BODY,
      "",
      "A genuinely new paragraph added by the agent.",
    ].join("\n");
    const payload = JSON.stringify({ ref: "knowledge/id-protected", content: llmBlob });

    const result = await akmReflect({
      ref: "knowledge/id-protected",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.proposal.payload.content).toContain("id: original-id-12345");
    expect(result.proposal.payload.content).not.toContain("fabricated-by-llm");
  });
});

// ── 5. Positive control — reflect on a markdown asset works end-to-end ────────

describe("Reflect positive control — markdown assets still flow through", () => {
  test("reflect on a knowledge asset produces a proposal with body-only LLM output", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Control\n---\n\n${LONG_SOURCE_BODY}\n`;

    const improved = LONG_SOURCE_BODY.replace("## Verification", "## Verification steps");
    const payload = JSON.stringify({ ref: "knowledge/control", content: improved });

    const result = await akmReflect({
      ref: "knowledge/control",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const content = result.proposal.payload.content;
    expect(content).toContain("description: Control");
    expect(content).toContain("## Verification steps");
    expect(listProposals(stash).length).toBe(1);
  });
});

// ── 6. Feedback framing — feedback is a signal, not ground truth (#952) ────────

describe("Reflect feedback-framing guard — feedback is a signal to investigate, not a fact to insert", () => {
  test("a feedback line is preceded in the prompt by the 'not a fact to insert' caveat", async () => {
    const stash = makeStashDir();
    const itemRef = durableItemRef(stash, "knowledge", "storage-guide");
    // Harness-observed failure mode (#952): a feedback line asserting a claim
    // the source content never made ("...the storage section does not say
    // which physical disk backs /data...") led both quants to fabricate a new
    // section inventing a disk layout and incident. The caveat must reach the
    // agent immediately ahead of the feedback line that could trigger this.
    appendEvent({
      eventType: "feedback",
      ref: itemRef,
      metadata: {
        signal: "negative",
        note: "the storage section does not say which physical disk backs /data",
      },
    });
    const payload = JSON.stringify({
      ref: "knowledge/storage-guide",
      content: "---\ndescription: Storage guide\n---\n\nUnchanged body.",
    });
    let prompt = "";
    const spawn: SpawnFn = (cmd, opts) => {
      prompt = cmd.at(-1) ?? "";
      return fakeSpawn(payload, "", 0)(cmd, opts);
    };

    const result = await akmReflect({
      ref: "knowledge/storage-guide",
      itemRef,
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: "---\ndescription: Storage guide\n---\n\nExisting body about storage.",
      runAgentOptions: { spawn },
    });

    expect(result.ok).toBe(true);
    const caveatIndex = prompt.indexOf("It is a signal to investigate, not a fact to insert.");
    const feedbackIndex = prompt.indexOf("the storage section does not say which physical disk backs /data");
    expect(caveatIndex).toBeGreaterThan(-1);
    expect(feedbackIndex).toBeGreaterThan(-1);
    expect(caveatIndex).toBeLessThan(feedbackIndex);
  });
});

// ── 7. Truncation-marker leak guard (#952) ──────────────────────────────────

describe("Reflect truncation-marker leak guard — a leaked cap notice is flagged for review, not queued silently", () => {
  test("a proposed body echoing the truncation marker is deferred with reflect-truncation-leak, not discarded", async () => {
    const stash = makeStashDir();
    // Deliberately tiny source so the body-size ratio guard cannot also fire
    // (source body stays under REFLECT_SIZE_GUARD_MIN_BYTES) — isolates the
    // truncation-marker rail from the size-ratio rail.
    const sourceContent = "---\ndescription: Short doc under the size-guard floor\n---\n\nShort body.\n";
    const leakedBody = `Rewritten body.\n${REFLECT_TRUNCATION_MARKER}`;
    const payload = JSON.stringify({ ref: "knowledge/leak-marker", content: leakedBody });

    const result = await akmReflect({
      ref: "knowledge/leak-marker",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-truncation-leak" });
    // Not discarded: the marker text itself is preserved in the queued
    // proposal so a reviewer can see exactly what leaked.
    expect(proposals[0]?.payload.content).toContain(REFLECT_TRUNCATION_MARKER);
  });

  // #952 review round 2: `createProposal`'s mint-time canonical-structure gate
  // (repository.ts, `hasCanonicalProposalValidator`) only runs for ref types
  // with a canonical validator — lesson/task/workflow — which the case above
  // (a `knowledge/...` ref) never exercises. Before the fix, that mint-time
  // gate ran the FULL `defaultProposalValidators` list, including the
  // blocking `reflect-truncation-marker` validator, so a leaking `lessons/...`
  // reflect proposal threw `invalid_canonical_structure` at CREATION time
  // instead of being minted and deferred like the knowledge-ref case above —
  // directly contradicting decision B / the addendum ("creation still defers
  // with reflect-truncation-leak"). This locks in the fix: mint-time
  // structural validation must stay canonical-structure-only.
  test("a lessons/... ref whose body leaks the truncation marker is still minted and deferred, not rejected at creation", async () => {
    const stash = makeStashDir();
    // Deliberately tiny source, same as the knowledge-ref case above, so the
    // body-size ratio guard cannot also fire.
    const sourceContent =
      "---\ndescription: Short lesson under the size-guard floor\nwhen_to_use: Testing the mint-time canonical gate\n---\n\nShort body.\n";
    const leakedBody = `Rewritten lesson body.\n${REFLECT_TRUNCATION_MARKER}`;
    const payload = JSON.stringify({ ref: "lessons/leak-marker", content: leakedBody });

    const result = await akmReflect({
      ref: "lessons/leak-marker",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(payload, "", 0) },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "reflect-truncation-leak" });
    expect(proposals[0]?.payload.content).toContain(REFLECT_TRUNCATION_MARKER);
  });

  // #952 Addendum (dev-team field review, 2026-09-09): the creation-time defer
  // above is the FIRST layer. This is the second: a reflect proposal whose
  // body still contains the marker when it reaches `proposal accept` (e.g. a
  // deferred proposal a human accepts anyway, or any future reflect path that
  // mints a proposal without going through sanitizeReflectPayload) must be
  // REJECTED, not promoted onto disk — a truncated body silently overwriting
  // a full asset is data loss. Exercises the same drain/promote codepath
  // `akm proposal accept` and drain's default `promoteFn` both use.
  test("a reflect proposal whose body still contains the marker is REJECTED at proposal accept, not promoted", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);

    // Bypass sanitizeReflectPayload (the creation-time defer path exercised
    // above) by minting the proposal directly through the repository, the
    // same way a defense-in-depth scenario would reach `proposal accept`
    // with the marker already embedded.
    const created = createProposal(stash, {
      ref: "knowledge/leak-marker-accept",
      source: "reflect",
      force: true,
      target: { source: "stash", root: path.resolve(stash) },
      payload: {
        content: `---\ndescription: Leaked marker doc\n---\n\nRewritten body.\n${REFLECT_TRUNCATION_MARKER}`,
      },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow(
      "reflect-truncation-marker-leak",
    );

    // Never promoted: still pending, nothing written to disk.
    const stillPending = listProposals(stash, { status: "pending" }).find((p) => p.id === created.id);
    expect(stillPending).toBeDefined();
    expect(stillPending?.status).toBe("pending");
  });
});
