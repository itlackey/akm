/**
 * Reflect pipeline safety-rail tests.
 *
 * Covers the regressions found in the May 2026 review of 323 reflect proposals:
 *
 *   1. Frontmatter stripped on rewrite (15+ cases).
 *   2. Reflect prepending YAML frontmatter to executable `.ts` script assets.
 *   3. Reflect renaming a skill's identity `name` field.
 *
 * A reply is a patch of `description`, `when_to_use` and title, applied to the
 * source asset: the body is the source's own, and nothing the model writes can
 * shrink, expand or rename the asset. These tests lock the type guard, the
 * source-frontmatter preservation and the judge routing in place so future
 * refactors cannot reintroduce the regressions silently.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { akmReflect } from "../../../../src/commands/improve/reflect";
import { splitFrontmatter } from "../../../../src/commands/improve/reflect-noise";
import { akmProposalAccept } from "../../../../src/commands/proposal/proposal";
import { createProposal, listProposals } from "../../../../src/commands/proposal/repository";
import type { AkmConfig } from "../../../../src/core/config/config";
import { ConfigError } from "../../../../src/core/errors";
import { appendEvent, readEvents } from "../../../../src/core/events";
import { openStateDatabase } from "../../../../src/core/state-db";
import type { SpawnedSubprocess, SpawnFn } from "../../../../src/core/subprocess";
import { _setWarnSinkForTests } from "../../../../src/core/warn";
import { REFLECT_TRUNCATION_MARKER } from "../../../../src/integrations/agent/prompts";
import { LlmCallError } from "../../../../src/llm/client";
import { listImproveLedgerRows } from "../../../../src/storage/repositories/improve-ledger-repository";
import { durableItemRef } from "../../../_helpers/durable-ref";
import { makeConfig, quietQualityGateConfig, reflectReply } from "../../../_helpers/factories";
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

/** A 500-character body of concrete content that reflect must keep as it is. */
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

/** A patch that changes the description of every source asset below. */
const PATCH = { description: "Runbook for the required AdGuard config and how to verify it" };

function reflectLedgerRows() {
  const db = openStateDatabase();
  try {
    return listImproveLedgerRows(db, makeStashDir(), ["reflect"]);
  } finally {
    db.close();
  }
}

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
    // No source asset on disk: reflect has nothing to patch.
    const payload = reflectReply({ description: "Foo doc, with a description" });
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
    const payload = reflectReply({ description: "Existing instruction doc, onboarding steps" });
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

// ── 1b. File guard — a proposal must write the file reflect read ─────────────────

describe("Reflect file guard — refuses an asset whose file a proposal would not write (#1052)", () => {
  const NOTE = "---\ndescription: Reference A.\n---\n# Reference A\n\nBody.\n";

  function writeInStash(stash: string, rel: string, content: string): string {
    const file = path.join(stash, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return file;
  }

  test("a skill's references/*.md is refused before the model runs, so no second file is proposed", async () => {
    const stash = makeStashDir();
    writeInStash(stash, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo skill.\n---\n# Demo\n");
    const file = writeInStash(stash, "skills/demo/references/a.md", NOTE);
    let spawned = false;

    // The index names this file `knowledge/skills/demo/references/a`; a proposal for that ref writes
    // `knowledge/skills/demo/references/a.md`, where nothing is.
    const result = await akmReflect({
      ref: "knowledge/skills/demo/references/a",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: {
        spawn: (cmd) => {
          spawned = true;
          return fakeSpawn(reflectReply({ description: "Reference A, revised." }), "", 0)(cmd, {});
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // The improve loop records this reason as a skip, not as a failed reflect.
    expect(result.reason).toBe("unsupported_type");
    expect(result.error).toBe(
      `Reflect refused: the file for knowledge/skills/demo/references/a is ${fs.realpathSync(file)}, but a proposal would write ${path.join(stash, "knowledge", "skills", "demo", "references", "a.md")}. Edit the file directly.`,
    );
    expect(spawned).toBe(false);
    expect(listProposals(stash)).toHaveLength(0);
    expect(fs.existsSync(path.join(stash, "knowledge", "skills"))).toBe(false);
    const completed = readEvents({ type: "reflect_completed" }).events;
    expect(completed).toHaveLength(1);
    expect(completed[0]?.metadata).toMatchObject({
      ok: false,
      reason: "unsupported_type",
      subreason: "file_outside_layout",
    });
  });

  test("a note outside every type directory is refused the same way", async () => {
    const stash = makeStashDir();
    writeInStash(stash, "docs/guide.md", NOTE);
    let spawned = false;

    const result = await akmReflect({
      ref: "knowledge/docs/guide",
      stashDir: stash,
      config: quietQualityGateConfig(),
      runAgentOptions: {
        spawn: (cmd) => {
          spawned = true;
          return fakeSpawn(reflectReply({ description: "Guide, revised." }), "", 0)(cmd, {});
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.reason).toBe("unsupported_type");
    expect(spawned).toBe(false);
    expect(listProposals(stash)).toHaveLength(0);
  });

  test("assets in the bundle's layout are still reflected, as an update of their own file", async () => {
    const stash = makeStashDir();
    writeInStash(stash, "knowledge/guide.md", NOTE);
    writeInStash(stash, "skills/demo/SKILL.md", "---\nname: demo\ndescription: Demo skill.\n---\n# Demo\n");

    for (const [ref, file] of [
      ["knowledge/guide", "knowledge/guide.md"],
      ["skills/demo", "skills/demo/SKILL.md"],
    ] as const) {
      const result = await akmReflect({
        ref,
        stashDir: stash,
        config: quietQualityGateConfig(),
        runAgentOptions: { spawn: fakeSpawn(reflectReply({ description: `${ref}, revised.` }), "", 0) },
      });
      if (!result.ok) throw new Error(`expected ${ref} to be reflected, got: ${result.error}`);
      expect(result.proposal.changes).toMatchObject([{ path: file, op: "update" }]);
    }
  });
});

// ── 2. Frontmatter preservation ─────────────────────────────────────────────────

describe("Reflect frontmatter preservation — a patch keeps the source's other frontmatter and its body", () => {
  test("a description patch changes only the description", async () => {
    const stash = makeStashDir();
    // Source asset has rich frontmatter the reply never mentions.
    const sourceContent = [
      "---",
      "name: release-policy",
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

    const result = await akmReflect({
      ref: "knowledge/policies/release",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      runAgentOptions: {
        spawn: fakeSpawn(reflectReply({ description: "Release policy for production deploys and hotfixes" }), "", 0),
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const finalContent = result.proposal.payload.content;
    expect(finalContent.startsWith("---\n")).toBe(true);
    expect(finalContent).toContain("description: Release policy for production deploys and hotfixes");
    expect(finalContent).not.toContain("description: Release policy for production deploys\n");
    // Every other key survives, the identity field included.
    expect(finalContent).toContain("when_to_use: Whenever you cut a release branch");
    expect(finalContent).toContain("- release");
    expect(finalContent).toContain("- policy");
    expect(result.proposal.payload.frontmatter?.name).toBe("release-policy");
    // The body is the source's, byte for byte, and the frontmatter block appears exactly once.
    expect(splitFrontmatter(finalContent).body).toBe(splitFrontmatter(sourceContent).body);
    expect((finalContent.match(/^---$/gm) ?? []).length).toBe(2);
  });
});

describe("Reflect quality gate — source context", () => {
  test("validates the separately resolved judge credential before agent generation or reflect events", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Judge preflight boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
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
              return fakeSpawn(reflectReply(PATCH), "", 0)(...args);
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
        assetContent: `---\ndescription: No judge runner\n---\n\n${LONG_SOURCE_BODY}\n`,
        runAgentOptions: {
          spawn: (...args) => {
            spawned += 1;
            return fakeSpawn(reflectReply(PATCH), "", 0)(...args);
          },
        },
      });
    } finally {
      _setWarnSinkForTests(undefined);
    }

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected reflect to succeed with the gate skipped");
    expect(spawned).toBe(1);
    expect(warnings.some((line) => line.includes("no engine configured"))).toBe(true);
    const proposals = listProposals(stash);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.gateDecision).toMatchObject({ outcome: "deferred", reason: "no-judge-configured" });
  });

  test("a separately resolved judge reads its credential at dispatch, after agent generation", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Judge credential boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        judge: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "judge-model",
          apiKey: "$AKM_REFLECT_JUDGE_ROTATING_KEY",
        },
      },
      defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
    } as AkmConfig;
    const original = "reflect-judge-original-secret";
    const rotated = "reflect-judge-rotated-secret";
    const observed: Array<string | undefined> = [];
    const spawn = fakeSpawn(reflectReply(PATCH), "", 0);

    const result = await withEnv({ AKM_REFLECT_JUDGE_ROTATING_KEY: original }, () =>
      akmReflect({
        ref: "knowledge/judge-rotation",
        stashDir: stash,
        config,
        assetContent: sourceContent,
        runAgentOptions: {
          spawn: (...args) => {
            mutateScopedEnv("AKM_REFLECT_JUDGE_ROTATING_KEY", rotated);
            return spawn(...args);
          },
        },
        chat: async (connection) => {
          observed.push(connection.apiKey);
          return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "pass" });
        },
      }),
    );

    expect(result.ok).toBe(true);
    expect(observed).toEqual([rotated]);
    expect(listProposals(stash)).toHaveLength(1);
  });

  test("SDK fallback generation and a separate judge each read their credential at dispatch", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: SDK and judge credential boundary\n---\n\n${LONG_SOURCE_BODY}\n`;
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
    const judgeRotated = "reflect-sdk-judge-rotated-secret";
    const observedSdk: Array<string | undefined> = [];
    const observedJudge: Array<string | undefined> = [];

    const result = await withEnv(
      { AKM_REFLECT_SDK_FALLBACK_KEY: sdkSecret, AKM_REFLECT_SDK_JUDGE_KEY: judgeSecret },
      () =>
        akmReflect({
          ref: "knowledge/sdk-judge-rotation",
          stashDir: stash,
          config,
          assetContent: sourceContent,
          runSdk: async (_profile, _prompt, _options, fallbackConnection) => {
            observedSdk.push(fallbackConnection?.apiKey);
            mutateScopedEnv("AKM_REFLECT_SDK_JUDGE_KEY", judgeRotated);
            return {
              ok: true,
              exitCode: 0,
              stdout: reflectReply(PATCH),
              stderr: "",
              durationMs: 1,
            };
          },
          chat: async (connection) => {
            observedJudge.push(connection.apiKey);
            return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "pass" });
          },
        }),
    );

    expect(result.ok).toBe(true);
    expect(observedSdk).toEqual([sdkSecret]);
    expect(observedJudge).toEqual([judgeRotated]);
    expect(listProposals(stash)).toHaveLength(1);
    const persisted = JSON.stringify(listProposals(stash));
    for (const secret of [sdkSecret, judgeSecret, judgeRotated]) expect(persisted).not.toContain(secret);
  });

  test("judges the proposal against the source content already loaded by reflect", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: SOURCE_ONLY_MARKER Source context regression guard\n---\n\n${LONG_SOURCE_BODY}\n`;
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
        strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } },
      },
    } as AkmConfig;
    let judgePrompt = "";

    const result = await akmReflect({
      ref: "knowledge/quality-source",
      stashDir: stash,
      config,
      assetContent: sourceContent,
      runAgentOptions: {
        spawn: fakeSpawn(reflectReply(PATCH), "", 0),
      },
      chat: async (_connection, messages) => {
        judgePrompt = messages[1]?.content ?? "";
        return JSON.stringify({ scores: { need: 5, preservation: 4, quality: 4 }, reason: "adds useful detail" });
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a proposal");
    // The judge's pass is staged for the drain, with its evidence on the stamp.
    expect(result.proposal.gateDecision).toMatchObject({
      outcome: "staged",
      reason: "quality-judge",
      gate: "quality-gate",
      scores: { need: 5, preservation: 4, quality: 4 },
      judgeReason: "adds useful detail",
    });
    expect(judgePrompt).toContain("NEED");
    expect(judgePrompt).toContain("PRESERVATION");
    expect(judgePrompt).not.toContain("Does the lesson add information not already present");
    // The source half of the prompt is the asset reflect loaded; the revision half is that asset with the patch,
    // and the changed region is the description the patch replaced.
    const [judgedSource = "", afterSource = ""] = judgePrompt.split("Proposed revision:");
    const [proposedRevision = "", changedRegion = ""] = afterSource.split("Changed region:");
    expect(judgedSource).toContain("SOURCE_ONLY_MARKER");
    expect(proposedRevision).not.toContain("SOURCE_ONLY_MARKER");
    expect(proposedRevision).toContain(`description: ${PATCH.description}`);
    expect(proposedRevision).toContain("## Required config");
    expect(changedRegion).toContain("SOURCE_ONLY_MARKER");
  });

  test("the reflect gate follows its own switch, not distill's", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Own switch\n---\n\n${LONG_SOURCE_BODY}\n`;
    let judged = 0;
    const reflectWith = (ref: string, processes: Record<string, unknown>) =>
      akmReflect({
        ref,
        stashDir: stash,
        config: {
          ...quietQualityGateConfig(),
          engines: {
            "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
            judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
          },
          defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
          improve: { strategies: { default: { processes } } },
        } as AkmConfig,
        assetContent: sourceContent,
        runAgentOptions: { spawn: fakeSpawn(reflectReply(PATCH), "", 0) },
        chat: async () => {
          judged += 1;
          return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "pass" });
        },
      });

    await reflectWith("knowledge/distill-gate-off", { distill: { qualityGate: { enabled: false } } });
    expect(judged).toBe(1);
    await reflectWith("knowledge/reflect-gate-off", { reflect: { qualityGate: { enabled: false } } });
    expect(judged).toBe(1);
  });

  test("qualityGate.engine judges with its own engine instead of the default LLM", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Separate judge\n---\n\n${LONG_SOURCE_BODY}\n`;
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
        general: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "general-model" },
        judge: { kind: "llm", endpoint: "http://localhost:11435/v1/chat/completions", model: "judge-model" },
      },
      defaults: { engine: "fake-agent", llmEngine: "general", improveStrategy: "default" },
      improve: { strategies: { default: { processes: { reflect: { qualityGate: { engine: "judge" } } } } } },
    } as AkmConfig;
    const models: string[] = [];

    const result = await akmReflect({
      ref: "knowledge/separate-judge",
      stashDir: stash,
      config,
      assetContent: sourceContent,
      runAgentOptions: {
        spawn: fakeSpawn(reflectReply(PATCH), "", 0),
      },
      chat: async (connection) => {
        models.push(connection.model);
        return JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "pass" });
      },
    });

    expect(result.ok).toBe(true);
    expect(models).toEqual(["judge-model"]);
  });

  test("a gate whose settings resolve to an agent judges with that agent, under the model-work tool policy", async () => {
    const stash = makeStashDir();
    // The judge's dispatch runs this binary for real: it records its argv and passes the revision.
    const judgeBin = path.join(stash, "judge-agent.sh");
    const argvLog = path.join(stash, "judge-argv.log");
    fs.writeFileSync(
      judgeBin,
      `#!/bin/sh\necho "$@" >> "${argvLog}"\necho '${JSON.stringify({ scores: { need: 5, preservation: 5, quality: 5 }, reason: "ok" })}'\n`,
      { mode: 0o755 },
    );
    const config = {
      ...quietQualityGateConfig(),
      engines: {
        "fake-agent": { kind: "agent", platform: "opencode", bin: judgeBin },
        general: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "general-model" },
      },
      defaults: { engine: "fake-agent", llmEngine: "general", improveStrategy: "default" },
      improve: {
        strategies: {
          default: { processes: { reflect: { engine: "fake-agent", qualityGate: { llm: { temperature: 0 } } } } },
        },
      },
    } as AkmConfig;
    let chatRan = false;

    const result = await akmReflect({
      ref: "knowledge/agent-judge",
      stashDir: stash,
      config,
      improveProfile: config.improve?.strategies?.default,
      assetContent: `---\ndescription: Agent judge\n---\n\n${LONG_SOURCE_BODY}\n`,
      runAgentOptions: {
        spawn: fakeSpawn(reflectReply(PATCH), "", 0),
      },
      chat: async () => {
        chatRan = true;
        return "must not run";
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a proposal");
    expect(chatRan).toBe(false);
    // The agent judged it, under the model-work policy, and its scores reach the stamp.
    expect(fs.readFileSync(argvLog, "utf8")).toStartWith("run --agent akm-model-work");
    expect(result.proposal.gateDecision).toMatchObject({
      outcome: "staged",
      scores: { need: 5, preservation: 5, quality: 5 },
    });
  });
});

describe("Reflect quality gate — a judge that gives no verdict defers the revision to review", () => {
  const ref = "knowledge/judge-no-verdict";
  const sourceContent = `---\ndescription: Judge failure routing\n---\n\n${LONG_SOURCE_BODY}\n`;

  function reflectJudgedBy(chat: () => Promise<string>) {
    return akmReflect({
      ref,
      stashDir: makeStashDir(),
      config: {
        ...quietQualityGateConfig(),
        engines: {
          "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
          judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
        },
        defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
        improve: { strategies: { default: { processes: { reflect: { qualityGate: { enabled: true } } } } } },
      } as AkmConfig,
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(reflectReply(PATCH), "", 0) },
      chat,
    });
  }

  /** Queued for a person by the quality gate, as distill queues its judge failures; never recorded as a rejection. */
  async function expectDeferredToReview(reflecting: ReturnType<typeof reflectJudgedBy>, judgeReason: string) {
    const result = await reflecting;
    if (!result.ok) throw new Error(`expected the revision to be deferred to review, got: ${result.error}`);
    expect(listProposals(makeStashDir())).toHaveLength(1);
    expect(result.proposal).toMatchObject({
      status: "pending",
      gateDecision: { outcome: "deferred", reason: "judge-error", gate: "quality-gate" },
    });
    expect(reflectLedgerRows()).toMatchObject([{ outcome: "review_needed", detail: "judge-error" }]);
    const completed = readEvents({ type: "reflect_completed" }).events.at(-1)?.metadata;
    expect(completed).toMatchObject({ proposalId: result.proposal.id, qualityReason: judgeReason });
    expect(completed?.qualityRejected).toBeUndefined();
  }

  test("a judge reply that is not JSON defers the revision instead of rejecting it", async () => {
    await expectDeferredToReview(
      reflectJudgedBy(async () => "The revision looks fine to me."),
      "judge parse failed — routed to review",
    );
  });

  test.each([
    ["errors", new Error("connect ECONNREFUSED 127.0.0.1:11434")],
    ["times out", new LlmCallError("judge request timed out", "timeout")],
  ])("a judge that %s defers the revision without a retrieval check against it", async (_kind, failure) => {
    // A query that retrieved the asset: the retrieval check would grade on it if a judge failure fell through.
    const db = openStateDatabase();
    try {
      db.prepare("INSERT INTO usage_events (event_type, entry_ref, query, source) VALUES ('search', ?, ?, 'user')").run(
        `stash//${ref}`,
        "adguard split horizon dns",
      );
    } finally {
      db.close();
    }
    let judgeCalls = 0;
    await expectDeferredToReview(
      reflectJudgedBy(async () => {
        judgeCalls += 1;
        throw failure;
      }),
      "judge timeout/error — routed to review",
    );
    expect(judgeCalls).toBe(1);
  });

  test("a real low score is still refused", async () => {
    // NEED 2 leaves the mean (3.33) in the review band: a real score that also carries reviewNeeded.
    const result = await reflectJudgedBy(async () =>
      JSON.stringify({ scores: { need: 2, preservation: 4, quality: 4 }, reason: "rewords a correct asset" }),
    );
    if (result.ok) throw new Error("expected the quality gate to refuse the revision");
    expect(result.reason).toBe("quality_rejected");
    expect(result.error).toContain('reason="rewords a correct asset"');
    expect(listProposals(makeStashDir())).toEqual([]);
    expect(reflectLedgerRows()).toMatchObject([
      { ref, outcome: "quality_rejected", detail: "rewords a correct asset" },
    ]);
    expect(readEvents({ type: "reflect_completed" }).events.at(-1)?.metadata).toMatchObject({
      qualityRejected: true,
      qualityReason: "rewords a correct asset",
    });
  });
});

describe("Reflect routing — a judged patch is staged for the drain", () => {
  const sourceContent = `---\ndescription: Routing source\n---\n\n${LONG_SOURCE_BODY}\n`;
  const patch = { description: "Split-horizon DNS on AdGuard: the config and how to check it" };
  const pass = async () =>
    JSON.stringify({ scores: { need: 5, preservation: 4, quality: 4 }, reason: "fixes the description" });

  /** Reflect `ref` with `patch`, judged by `judge`. Without a `judge` the gate is off. */
  function reflectPatched(ref: string, { judge }: { judge?: () => Promise<string> }) {
    return akmReflect({
      ref,
      stashDir: makeStashDir(),
      config: {
        ...quietQualityGateConfig(),
        engines: {
          "fake-agent": { kind: "agent", platform: "opencode", bin: "fake-agent" },
          judge: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
        },
        defaults: { engine: "fake-agent", llmEngine: "judge", improveStrategy: "default" },
        improve: {
          strategies: { default: { processes: { reflect: { qualityGate: { enabled: judge !== undefined } } } } },
        },
      } as AkmConfig,
      assetContent: sourceContent,
      runAgentOptions: { spawn: fakeSpawn(reflectReply(patch), "", 0) },
      chat:
        judge ??
        (async () => {
          throw new Error("the gate is off: nothing may judge the revision");
        }),
    });
  }

  test("a judge-passed patch is staged for the drain to accept, with the judge's scores and reason on the stamp", async () => {
    const result = await reflectPatched("knowledge/judged-patch", { judge: pass });
    if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
    expect(result.proposal.gateDecision).toMatchObject({
      outcome: "staged",
      reason: "quality-judge",
      gate: "quality-gate",
      scores: { need: 5, preservation: 4, quality: 4 },
      judgeReason: "fixes the description",
    });
  });

  test("a patch the judge fails is still refused", async () => {
    const result = await reflectPatched("knowledge/failed-patch", {
      judge: async () =>
        JSON.stringify({ scores: { need: 1, preservation: 2, quality: 2 }, reason: "rewords a correct description" }),
    });
    if (result.ok) throw new Error("expected the quality gate to refuse the revision");
    expect(result.reason).toBe("quality_rejected");
    expect(listProposals(makeStashDir())).toEqual([]);
    expect(reflectLedgerRows()).toMatchObject([
      { outcome: "quality_rejected", detail: "rewords a correct description" },
    ]);
  });

  test("with the gate off, a patch is left to the drain, with no stamp", async () => {
    const result = await reflectPatched("knowledge/gate-off-patch", {});
    if (!result.ok) throw new Error(`expected a proposal, got: ${result.error}`);
    expect(result.proposal.status).toBe("pending");
    expect(result.proposal.gateDecision).toBeUndefined();
  });
});

// ── 3. Run-only guidance reaches the prompt, never the asset ──────────────────

describe("Reflect avoid-patterns — run-only guidance reaches the prompt, never the asset (#963)", () => {
  test("the proposal is the source with the patch, whatever guidance the prompt carried", async () => {
    const stash = makeStashDir();
    const sourceContent = `---\ndescription: Control\n---\n\n${LONG_SOURCE_BODY}\n`;
    let prompt = "";
    const spawn: SpawnFn = (cmd, opts) => {
      prompt = cmd.at(-1) ?? "";
      return fakeSpawn(reflectReply({ description: "Control doc, with a fuller description" }), "", 0)(cmd, opts);
    };

    const result = await akmReflect({
      ref: "knowledge/scaffolding",
      stashDir: stash,
      config: quietQualityGateConfig(),
      assetContent: sourceContent,
      avoidPatterns: ["Reflect rejected: unrelated run diagnostic."],
      runAgentOptions: { spawn },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(prompt).toContain("Run-only guidance: do not copy this heading");
    expect(prompt).toContain("Reflect rejected: unrelated run diagnostic.");
    const content = result.proposal.payload.content;
    expect(content).toContain("description: Control doc, with a fuller description");
    expect(content).not.toContain("## Avoid These Patterns");
    expect(content).not.toContain("unrelated run diagnostic");
    expect(splitFrontmatter(content).body).toBe(splitFrontmatter(sourceContent).body);
    expect(listProposals(stash).length).toBe(1);
  });
});

// ── 4. Feedback framing — feedback is a signal, not ground truth (#952) ────────

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
    const payload = reflectReply({ description: "Storage guide, with its layout caveats" });
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
    const caveatIndex = prompt.indexOf("It is a signal, not a fact to insert.");
    const feedbackIndex = prompt.indexOf("the storage section does not say which physical disk backs /data");
    expect(caveatIndex).toBeGreaterThan(-1);
    expect(feedbackIndex).toBeGreaterThan(-1);
    expect(caveatIndex).toBeLessThan(feedbackIndex);
  });
});

// ── 5. Truncation-marker leak guard at accept (#952) ────────────────────────────

describe("Reflect truncation-marker guard — a reflect proposal carrying the cap notice is not promoted", () => {
  // A reflect proposal whose body still contains the marker when it reaches
  // `proposal accept` (a proposal made before reflect kept the body, or any
  // future path that mints one without going through reflect) must be
  // REJECTED, not promoted onto disk — a truncated body silently overwriting
  // a full asset is data loss. Exercises the same drain/promote codepath
  // `akm proposal accept` and drain's default `promoteFn` both use.
  test("a reflect proposal whose body still contains the marker is REJECTED at proposal accept, not promoted", async () => {
    const stash = makeStashDir();
    const config = makeConfig(stash);

    // Minted directly through the repository, the way a proposal that never
    // went through reflect's creation path would reach `proposal accept`.
    const created = createProposal(stash, {
      ref: "knowledge/leak-marker-accept",
      source: "reflect",
      target: { source: "stash", root: path.resolve(stash) },
      payload: {
        content: `---\ndescription: Leaked marker doc\n---\n\nRewritten body.\n${REFLECT_TRUNCATION_MARKER}`,
      },
    });

    await expect(akmProposalAccept({ stashDir: stash, id: created.id, config })).rejects.toThrow(
      "reflect-truncation-marker-leak",
    );

    // Never promoted: still pending, nothing written to disk.
    const stillPending = listProposals(stash, { status: "pending" }).find((p) => p.id === created.id);
    expect(stillPending).toBeDefined();
    expect(stillPending?.status).toBe("pending");
  });
});
