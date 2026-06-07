// Integration-style tests for akmExtract. Real proposal queue + real
// filesystem, but harness + LLM chat are injected so no network / no
// platform install needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmExtract, parseSinceArg } from "../src/commands/improve/extract";
import { EXTRACT_JSON_SCHEMA } from "../src/commands/improve/extract-prompt";
import { isValidDescription } from "../src/commands/proposal/validators/proposal-quality-validators";
import type { AkmConfig } from "../src/core/config";
import { UsageError } from "../src/core/errors";
import { parseFrontmatter } from "../src/core/frontmatter";
import { listProposals } from "../src/core/proposals";
import { detectTruncatedDescription } from "../src/core/text-truncation";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withIsolatedAkmStorage } from "./_helpers/sandbox";

// ── Test scaffolding ────────────────────────────────────────────────────────

const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;
function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
function makeStashDir(): string {
  const stash = makeTempDir("akm-extract-stash-");
  for (const dir of ["memories", "lessons", "knowledge"]) {
    fs.mkdirSync(path.join(stash, dir), { recursive: true });
  }
  return stash;
}
beforeEach(() => {
  storage = withIsolatedAkmStorage();
});
afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function configEnabled(stashDir: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    profiles: {
      llm: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "test-model",
          supportsJsonSchema: true,
        },
      },
      improve: { default: { processes: { extract: { enabled: true } } } },
    },
    defaults: { llm: "default" },
  } as AkmConfig;
}
function configDisabled(stashDir: string): AkmConfig {
  return {
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    profiles: {
      llm: { default: { endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" } },
      improve: { default: { processes: { extract: { enabled: false } } } },
    },
    defaults: { llm: "default" },
  } as AkmConfig;
}

function fakeSession(id: string, endedAt: number): SessionData {
  return {
    ref: {
      harness: "claude-code",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: endedAt - 3600_000,
      endedAt,
      title: `Session ${id}`,
    },
    events: [
      {
        harness: "claude-code",
        text: "user message: explain how to recover from VPN-disconnect during deploy",
        ts: endedAt - 3000_000,
        sessionId: id,
        role: "user",
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude-code",
        text: "agent: I see the issue — deploy.sh hangs without VPN. The error message is misleading.",
        ts: endedAt - 2000_000,
        sessionId: id,
        role: "assistant",
        filePath: `/tmp/fake/${id}.jsonl`,
      },
    ],
    inlineRefs: [],
  };
}

function makeFakeHarness(sessions: SessionData[], available = true): SessionLogHarness {
  const summaries: SessionSummary[] = sessions.map((s) => s.ref);
  return {
    name: "claude-code",
    isAvailable: () => available,
    *readEvents() {
      // not used by extract — keep empty
    },
    listSessions: (input?: { sinceMs?: number }) => {
      const since = input?.sinceMs ?? 0;
      return summaries.filter((s) => (s.endedAt ?? 0) >= since);
    },
    readSession: (ref: SessionRef): SessionData => {
      const found = sessions.find((s) => s.ref.sessionId === ref.sessionId);
      if (!found) throw new Error(`session not found: ${ref.sessionId}`);
      return found;
    },
  };
}

// ── parseSinceArg ───────────────────────────────────────────────────────────

describe("parseSinceArg", () => {
  test("defaults to 24h cutoff when empty", () => {
    const now = 1_700_000_000_000;
    expect(parseSinceArg(undefined, now)).toBe(now - 24 * 3_600_000);
    expect(parseSinceArg("", now)).toBe(now - 24 * 3_600_000);
  });
  test("parses relative durations: 30m / 7h / 14d", () => {
    const now = 1_700_000_000_000;
    expect(parseSinceArg("30m", now)).toBe(now - 30 * 60_000);
    expect(parseSinceArg("7h", now)).toBe(now - 7 * 3_600_000);
    expect(parseSinceArg("14d", now)).toBe(now - 14 * 86_400_000);
  });
  test("parses ISO timestamps", () => {
    const iso = "2026-05-26T10:00:00.000Z";
    expect(parseSinceArg(iso, Date.now())).toBe(Date.parse(iso));
  });
  test("throws UsageError on garbage input", () => {
    expect(() => parseSinceArg("not-a-duration", Date.now())).toThrow(UsageError);
  });
});

// ── akmExtract ──────────────────────────────────────────────────────────────

describe("akmExtract — input validation", () => {
  test("throws when --type is missing or empty", async () => {
    const stash = makeStashDir();
    await expect(akmExtract({ type: "", stashDir: stash, config: configEnabled(stash) })).rejects.toThrow(UsageError);
  });
});

describe("akmExtract — feature gate", () => {
  test("returns empty envelope when session_extraction is disabled", async () => {
    const stash = makeStashDir();
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configDisabled(stash),
      harnesses: [makeFakeHarness([fakeSession("a", Date.now())])],
      chat: async () => JSON.stringify({ candidates: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/disabled/);
  });
});

describe("akmExtract — harness resolution", () => {
  test("returns warning when type matches no available harness", async () => {
    const stash = makeStashDir();
    const result = await akmExtract({
      type: "made-up-harness",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [],
      chat: async () => "{}",
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/no available harness/);
  });

  test("returns warning when harness reports not-available", async () => {
    const stash = makeStashDir();
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([], /* available */ false)],
      chat: async () => "{}",
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/not-available/);
  });
});

describe("akmExtract — discovery mode", () => {
  test("processes sessions newer than the since cutoff", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const recent = fakeSession("recent", now - 10 * 60_000); // 10m ago
    const old = fakeSession("old", now - 8 * 86_400_000); // 8 days ago

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([recent, old])],
      since: "24h",
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
      },
    });
    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(1); // only recent session processed
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("recent");
  });
});

describe("akmExtract — single-session mode", () => {
  test("processes only the specified sessionId", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const target = fakeSession("target", now - 10 * 60_000);
    const other = fakeSession("other", now - 5 * 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "target",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([target, other])],
      chat: async () => JSON.stringify({ candidates: [] }),
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("target");
  });

  test("returns warning when sessionId does not exist", async () => {
    const stash = makeStashDir();
    const result = await akmExtract({
      type: "claude-code",
      sessionId: "missing",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([fakeSession("present", Date.now())])],
      chat: async () => "{}",
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/not found/);
  });
});

describe("akmExtract — candidate → proposal routing", () => {
  test("creates one proposal per valid candidate, with merged body frontmatter", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_abc", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_abc",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "lesson",
              name: "vpn-before-deploy",
              description:
                "Always connect to corporate VPN before running deploy.sh — otherwise the rollout hangs silently.",
              when_to_use: "When initiating a production deploy from a fresh shell or after a laptop reboot.",
              body: "Deploy.sh hangs at the 'pushing to stage' step when VPN is not connected. The error message reports a misleading network failure.",
              confidence: 0.92,
              evidence: "agent message at session midpoint, then user correction",
            },
            {
              type: "memory",
              name: "auth-uses-jwt-24h",
              description: "Auth pipeline uses JWT tokens with 24h TTL — switched from session cookies in May.",
              body: "The auth module switched from session-cookie storage to short-lived JWT tokens. TTL is 24h.",
              confidence: 0.85,
              evidence: "user correction mid-session",
            },
          ],
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.candidatesCreated).toBe(2);
    expect(result.proposals).toHaveLength(2);

    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract");
    expect(pending).toHaveLength(2);
    const lessonProp = pending.find((p) => p.ref === "lesson:vpn-before-deploy");
    expect(lessonProp).toBeDefined();
    // Body must contain description in YAML frontmatter so accept-time validator passes
    expect(lessonProp?.payload.content).toMatch(/description:.*VPN/);
    expect(lessonProp?.payload.content).toMatch(/when_to_use:/);
    // Sources field tracks the originating session
    expect(lessonProp?.payload.content).toMatch(/sources:/);
    expect(lessonProp?.payload.content).toMatch(/session:claude-code:ses_abc/);
  });

  test("repairs a truncated description so the auto-accept validator passes (#556)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_trunc", Date.now() - 60_000);

    // The LLM produced a description sliced mid-clause (ends with "to"). On the
    // pre-#556 path this lands as-is and the description-quality validator
    // rejects it at accept time. The repair pass must complete it first.
    const truncatedDesc = "Always connect to the corporate VPN before running deploy.sh to";
    expect(detectTruncatedDescription(truncatedDesc)).not.toBeNull();
    expect(isValidDescription(truncatedDesc, "lesson:vpn-before-deploy").ok).toBe(false);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_trunc",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "lesson",
              name: "vpn-before-deploy",
              description: truncatedDesc,
              when_to_use: "When initiating a production deploy from a fresh shell or after a laptop reboot.",
              body: "Deploy.sh hangs at the 'pushing to stage' step when the VPN is not connected. The error message reports a misleading network failure.",
              confidence: 0.92,
              evidence: "agent message at session midpoint, then user correction",
            },
          ],
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.candidatesCreated).toBe(1);

    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract");
    const prop = pending.find((p) => p.ref === "lesson:vpn-before-deploy");
    expect(prop).toBeDefined();

    // The persisted content's frontmatter description must now be valid.
    const fm = parseFrontmatter(prop?.payload.content ?? "").data as Record<string, unknown>;
    expect(typeof fm.description).toBe("string");
    expect(detectTruncatedDescription(fm.description as string)).toBeNull();
    expect(isValidDescription(fm.description, "lesson:vpn-before-deploy").ok).toBe(true);

    // The payload frontmatter mirror must carry the same repaired value.
    const payloadDesc = (prop?.payload.frontmatter as Record<string, unknown> | undefined)?.description;
    expect(payloadDesc).toBe(fm.description as string);
  });

  test("dry-run reports candidates without creating proposals", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_dry", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_dry",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      dryRun: true,
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "memory",
              name: "fact-1",
              description: "Description of length above 20 characters for the schema check to pass.",
              body: "Body content that is at least 50 characters long so the parser keeps the candidate.",
              confidence: 0.85,
              evidence: "evidence one",
            },
          ],
        }),
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidatesCreated).toBe(1);
    expect(result.proposals[0]).toMatch(/^dry-run:memory:fact-1$/);
    // No actual proposal queued
    expect(listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract")).toEqual([]);
  });

  test("handles empty-candidates response by emitting rationale", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_empty", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_empty",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [],
          rationale_if_empty: "Session contained only akm meta-ops; nothing rose to durable-insight level.",
        }),
    });

    expect(result.candidatesCreated).toBe(0);
    expect(result.sessions[0]?.rationaleIfEmpty).toContain("durable-insight");
  });
});

describe("akmExtract — LLM call wiring", () => {
  test("passes EXTRACT_JSON_SCHEMA as responseSchema", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_schema", Date.now() - 60_000);

    let receivedSchema: unknown;
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_schema",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, _messages, options) => {
        receivedSchema = options?.responseSchema;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedSchema).toBe(EXTRACT_JSON_SCHEMA);
  });

  test("passes a prompt that mentions the session title + harness", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_prompt", Date.now() - 60_000);

    let receivedPrompt = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_prompt",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, messages) => {
        receivedPrompt = messages[0]?.content ?? "";
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedPrompt).toContain("claude-code");
    expect(receivedPrompt).toContain("Session ses_prompt");
  });
});

// ── per-process profile + config support ────────────────────────────────────

describe("akmExtract — profile + config resolution", () => {
  function configWithProfile(stashDir: string, processOverride: Record<string, unknown>): AkmConfig {
    return {
      semanticSearchMode: "auto",
      stashDir,
      sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
      defaultWriteTarget: "stash",
      profiles: {
        llm: {
          default: {
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "default-model",
            supportsJsonSchema: true,
          },
          "extract-special": {
            endpoint: "http://192.168.0.205:1234/v1/chat/completions",
            model: "extract-special-model",
            supportsJsonSchema: true,
            timeoutMs: 90_000,
            contextLength: 131_072,
          },
        },
        improve: {
          default: { processes: { extract: { enabled: true, ...processOverride } } },
        },
      },
      defaults: { llm: "default" },
    } as AkmConfig;
  }

  test("honors profiles.improve.default.processes.extract.profile to pick a non-default LLM", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_profile", Date.now() - 60_000);
    let receivedEndpoint = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_profile",
      stashDir: stash,
      config: configWithProfile(stash, { mode: "llm", profile: "extract-special" }),
      harnesses: [makeFakeHarness([session])],
      chat: async (cfg) => {
        receivedEndpoint = cfg.endpoint;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedEndpoint).toBe("http://192.168.0.205:1234/v1/chat/completions");
  });

  test("falls back to defaults.llm when the process config has no profile override", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_default", Date.now() - 60_000);
    let receivedModel = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_default",
      stashDir: stash,
      config: configWithProfile(stash, {}),
      harnesses: [makeFakeHarness([session])],
      chat: async (cfg) => {
        receivedModel = cfg.model;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedModel).toBe("default-model");
  });

  test("rejects non-llm mode in the process config", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_bad_mode", Date.now() - 60_000);
    // Build a config where the agent profile EXISTS so the runner resolver
    // succeeds and akmExtract's own kind-check fires (not the resolver's
    // missing-profile guard).
    const config = configWithProfile(stash, { mode: "agent", profile: "fake-agent" }) as AkmConfig & {
      profiles: { agent?: Record<string, unknown> };
    };
    config.profiles.agent = {
      "fake-agent": { platform: "opencode" as const, bin: "opencode", args: ["run"] },
    };
    await expect(
      akmExtract({
        type: "claude-code",
        sessionId: "ses_bad_mode",
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([session])],
        chat: async () => JSON.stringify({ candidates: [] }),
      }),
    ).rejects.toThrow(/only supports mode/);
  });

  test("honors process timeoutMs override", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_to", Date.now() - 60_000);
    let receivedTimeout = 0;
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_to",
      stashDir: stash,
      config: configWithProfile(stash, { mode: "llm", profile: "extract-special", timeoutMs: 45_000 }),
      harnesses: [makeFakeHarness([session])],
      chat: async (_cfg, _msgs, opts) => {
        receivedTimeout = opts?.timeoutMs ?? 0;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedTimeout).toBe(45_000);
  });

  test("explicit options.timeoutMs overrides the process config", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_to2", Date.now() - 60_000);
    let receivedTimeout = 0;
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_to2",
      stashDir: stash,
      config: configWithProfile(stash, { mode: "llm", profile: "extract-special", timeoutMs: 45_000 }),
      harnesses: [makeFakeHarness([session])],
      timeoutMs: 30_000,
      chat: async (_cfg, _msgs, opts) => {
        receivedTimeout = opts?.timeoutMs ?? 0;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedTimeout).toBe(30_000);
  });

  test("honors defaultSince when --since is not passed", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    // session is 5 days old — would be excluded by the default 24h window
    // but defaultSince: 7d should keep it.
    const old = fakeSession("ses_5d", now - 5 * 86_400_000);
    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configWithProfile(stash, { defaultSince: "7d" }),
      harnesses: [makeFakeHarness([old])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(chatCalls).toBe(1);
    expect(result.sessions).toHaveLength(1);
  });

  test("honors maxTotalChars override for the pre-filter budget", async () => {
    const stash = makeStashDir();
    // Build a session with many fat events. Run extract twice — once with a
    // tight budget, once with a generous one — and assert the tight-budget
    // prompt is meaningfully smaller. This verifies the wiring without baking
    // a brittle absolute size assertion against the prompt template.
    const fatSession: SessionData = {
      ref: {
        harness: "claude-code",
        sessionId: "ses_budget",
        filePath: "/tmp/fake/ses_budget.jsonl",
        startedAt: Date.now() - 3600_000,
        endedAt: Date.now(),
      },
      events: Array.from({ length: 20 }, (_, i) => ({
        harness: "claude-code",
        text: `event ${i} `.padEnd(800, "x"),
        ts: Date.now() - 60_000 * (20 - i),
        sessionId: "ses_budget",
        role: "user" as const,
        filePath: "/tmp/fake/ses_budget.jsonl",
      })),
      inlineRefs: [],
    };

    let tightPromptLen = 0;
    let generousPromptLen = 0;
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_budget",
      stashDir: stash,
      config: configWithProfile(stash, { maxTotalChars: 1500 }),
      harnesses: [makeFakeHarness([fatSession])],
      chat: async (_cfg, msgs) => {
        tightPromptLen = msgs[0]?.content.length ?? 0;
        return JSON.stringify({ candidates: [] });
      },
    });
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_budget",
      stashDir: stash,
      config: configWithProfile(stash, { maxTotalChars: 100_000 }),
      harnesses: [makeFakeHarness([fatSession])],
      chat: async (_cfg, msgs) => {
        generousPromptLen = msgs[0]?.content.length ?? 0;
        return JSON.stringify({ candidates: [] });
      },
    });
    // Tight budget should drop ~15-18 of the 20 events; generous keeps all.
    expect(tightPromptLen).toBeLessThan(generousPromptLen);
    expect(generousPromptLen - tightPromptLen).toBeGreaterThan(8000);
  });
});
