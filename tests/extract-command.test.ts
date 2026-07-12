// Integration-style tests for akmExtract. Real proposal queue + real
// filesystem, but harness + LLM chat are injected so no network / no
// platform install needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmExtract, parseSinceArg, resolveStandaloneExtractPlan } from "../src/commands/improve/extract";
import { EXTRACT_JSON_SCHEMA } from "../src/commands/improve/extract-prompt";
import { listProposals } from "../src/commands/proposal/repository";
import { isValidDescription } from "../src/commands/proposal/validators/proposal-quality-validators";
import { parseFrontmatter } from "../src/core/asset/frontmatter";
import type { AkmConfig } from "../src/core/config/config";
import { ImproveProcessConfigSchema, ImproveProfileConfigSchema } from "../src/core/config/config-schema";
import { UsageError } from "../src/core/errors";
import { detectTruncatedDescription } from "../src/core/text-truncation";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../src/integrations/session-logs/types";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage } from "./_helpers/sandbox";

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
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    engines: {
      default: {
        kind: "llm",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "test-model",
        supportsJsonSchema: true,
      },
    },
    improve: {
      strategies: {
        // #561 — these tests assert the distillation chat-call count / schema.
        // Session indexing (default-on) would add a second chat call per session,
        // so disable it here; the session-indexing behaviour has dedicated
        // coverage in tests/session-indexing.test.ts.
        extract: {
          processes: { extract: { enabled: true, indexSessions: false, triage: { enabled: false } } },
        },
      },
    },
    defaults: { llmEngine: "default", improveStrategy: "extract" },
  } as AkmConfig;
}
function configDisabled(stashDir: string): AkmConfig {
  return {
    configVersion: "0.9.0",
    semanticSearchMode: "auto",
    stashDir,
    sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
    defaultWriteTarget: "stash",
    engines: {
      default: { kind: "llm", endpoint: "http://localhost:11434/v1/chat/completions", model: "test-model" },
    },
    improve: { strategies: { disabled: { processes: { extract: { enabled: false } } } } },
    defaults: { llmEngine: "default", improveStrategy: "disabled" },
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

describe("akmExtract — explicit command is not gated by the improve-stage toggle", () => {
  // Bug fix: an explicit `akm extract` invocation (no `improveProfile` — the
  // standalone command / cron) must RUN even when the default improve profile
  // has `processes.extract.enabled: false`. The toggle gates extract as a STAGE
  // of `akm improve` (the active-profile path), NOT the dedicated command —
  // previously dropping extract from the daily improve profile silently disabled
  // the standalone command (and its LLM calls via the shared feature gate).
  test("standalone extract runs even when default.processes.extract.enabled is false", async () => {
    const stash = makeStashDir();
    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: configDisabled(stash), // default.extract.enabled === false
      harnesses: [makeFakeHarness([fakeSession("a", Date.now())])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(result.ok).toBe(true);
    // The session is actually processed (not short-circuited as "disabled")...
    expect(result.sessionsProcessed).toBe(1);
    // ...the extract LLM call fires (feature gate no longer blocks it)...
    expect(chatCalls).toBeGreaterThan(0);
    // ...and there is no "disabled" warning.
    expect(result.warnings.join(" ")).not.toMatch(/disabled/);
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

  // Behaviour fix (#563): resolveHarness now normalizes the requested --type
  // AND each provider's runtime name through the id-normalization bridge, so
  // the CANONICAL id "claude" resolves to the provider whose runtime name is
  // "claude-code". Before the fix only the exact runtime string matched, so
  // `--type claude` (the id used by agent profiles / config schema) silently
  // resolved to nothing. The legacy `--type claude-code` (asserted elsewhere)
  // must keep working too.
  test("--type claude (canonical id) resolves to the claude-code provider via the bridge", async () => {
    const stash = makeStashDir();
    const result = await akmExtract({
      type: "claude",
      stashDir: stash,
      config: configEnabled(stash),
      // provider.name is the runtime id "claude-code"; canonical "claude" must
      // still resolve to it. `available:false` lets us confirm resolution
      // happened (we hit the not-available path, not the no-harness path).
      harnesses: [makeFakeHarness([], /* available */ false)],
      chat: async () => "{}",
    });
    expect(result.ok).toBe(false);
    // Resolved to the provider (not-available), NOT a "no available harness" miss.
    expect(result.warnings.join(" ")).toMatch(/not-available/);
    expect(result.warnings.join(" ")).not.toMatch(/no available harness/);
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

  test("maxSessionsPerRun caps LLM-processed sessions; overflow stays unseen for the next run", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const sessions = Array.from({ length: 5 }, (_, i) => fakeSession(`s${i}`, now - (i + 1) * 60_000));
    const cfg = configEnabled(stash) as AkmConfig & {
      improve: { strategies: { extract: { processes: { extract: Record<string, unknown> } } } };
    };
    cfg.improve.strategies.extract.processes.extract.maxSessionsPerRun = 3;

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      stashDir: stash,
      config: cfg,
      harnesses: [makeFakeHarness(sessions)],
      since: "24h",
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(result.ok).toBe(true);
    expect(chatCalls).toBe(3); // capped at 3, not all 5
    expect(result.sessionsProcessed).toBe(3);
    expect(result.warnings.join(" ")).toMatch(/maxSessionsPerRun=3.*deferred/);
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

  // ── #615 WS-0: orderedActions + outcomeData preserved in proposal ──────────

  test("#615 WS-0: orderedActions and outcomeData are preserved in the proposal content and frontmatter", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_ordered", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_ordered",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "lesson",
              name: "vpn-deploy-sequence",
              description: "Connecting to VPN before running deploy.sh prevents silent hangs at the stage-push step.",
              when_to_use: "When initiating a production deploy from a fresh shell or after a laptop reboot.",
              body: "Deploy.sh hangs at the 'pushing to stage' step when VPN is not active. The fix: check VPN, connect if needed, then run deploy.sh.",
              confidence: 0.9,
              evidence: "tool failure at session midpoint",
              orderedActions: ["check vpn status", "connect to corporate vpn", "run deploy.sh"],
              outcomeData: "deploy succeeded after VPN reconnect",
            },
          ],
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.candidatesCreated).toBe(1);

    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract");
    const prop = pending.find((p) => p.ref === "lesson:vpn-deploy-sequence");
    expect(prop).toBeDefined();

    // orderedActions must appear in the proposal content body (YAML frontmatter)
    expect(prop?.payload.content).toMatch(/orderedActions:/);
    expect(prop?.payload.content).toMatch(/check vpn status/);
    expect(prop?.payload.content).toMatch(/connect to corporate vpn/);
    expect(prop?.payload.content).toMatch(/run deploy\.sh/);

    // outcomeData must appear in the proposal content
    expect(prop?.payload.content).toMatch(/outcomeData:/);
    expect(prop?.payload.content).toMatch(/deploy succeeded after VPN reconnect/);

    // The proposal frontmatter mirror must carry the structured data
    const fm = prop?.payload.frontmatter as Record<string, unknown> | undefined;
    expect(Array.isArray(fm?.orderedActions)).toBe(true);
    expect(fm?.orderedActions).toEqual(["check vpn status", "connect to corporate vpn", "run deploy.sh"]);
    expect(fm?.outcomeData).toBe("deploy succeeded after VPN reconnect");
  });

  test("#615 WS-0: candidates without orderedActions produce proposals without those fields", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_no_actions", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude-code",
      sessionId: "ses_no_actions",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "memory",
              name: "auth-uses-jwt-24h",
              description: "Auth pipeline uses JWT tokens with 24h TTL switched from session cookies in May.",
              body: "The auth module switched from session-cookie storage to short-lived JWT tokens. TTL is 24h.",
              confidence: 0.85,
              evidence: "user correction mid-session",
              // No orderedActions or outcomeData
            },
          ],
        }),
    });

    expect(result.ok).toBe(true);
    expect(result.candidatesCreated).toBe(1);

    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract");
    const prop = pending.find((p) => p.ref === "memory:auth-uses-jwt-24h");
    expect(prop).toBeDefined();

    // orderedActions/outcomeData must NOT appear when not provided
    expect(prop?.payload.content).not.toMatch(/orderedActions:/);
    expect(prop?.payload.content).not.toMatch(/outcomeData:/);
    const fm = prop?.payload.frontmatter as Record<string, unknown> | undefined;
    expect(fm?.orderedActions).toBeUndefined();
    expect(fm?.outcomeData).toBeUndefined();
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

// ── minContentChars config schema (#595) ────────────────────────────────────

describe("minContentChars improve-process config schema", () => {
  test("accepts 0 (disabled) and positive integers; rejects negatives and floats", () => {
    expect(ImproveProcessConfigSchema.safeParse({ minContentChars: 0 }).success).toBe(true);
    expect(ImproveProcessConfigSchema.safeParse({ minContentChars: 500 }).success).toBe(true);
    expect(ImproveProcessConfigSchema.safeParse({ minContentChars: -1 }).success).toBe(false);
    expect(ImproveProcessConfigSchema.safeParse({ minContentChars: 1.5 }).success).toBe(false);
  });

  test("parses inside a profile's extract process block", () => {
    const result = ImproveProfileConfigSchema.safeParse({
      processes: { extract: { enabled: true, minContentChars: 10 } },
    });
    expect(result.success).toBe(true);
  });
});

// ── per-process engine + strategy config support ────────────────────────────

describe("akmExtract — engine + strategy config resolution", () => {
  function configWithStrategy(stashDir: string, processOverride: Record<string, unknown>): AkmConfig {
    return {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      stashDir,
      sources: [{ type: "filesystem", name: "stash", path: stashDir, writable: true }],
      defaultWriteTarget: "stash",
      engines: {
        default: {
          kind: "llm",
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "default-model",
          supportsJsonSchema: true,
        },
        "extract-special": {
          kind: "llm",
          endpoint: "http://192.168.0.205:1234/v1/chat/completions",
          model: "extract-special-model",
          supportsJsonSchema: true,
          timeoutMs: 90_000,
          contextLength: 131_072,
        },
      },
      improve: {
        strategies: {
          // #561 — default-off session indexing here so these resolution tests
          // keep asserting the single distillation chat call. Overridable via
          // processOverride for any test that wants to exercise it.
          extract: {
            processes: {
              extract: { enabled: true, indexSessions: false, triage: { enabled: false }, ...processOverride },
            },
          },
        },
      },
      defaults: { llmEngine: "default", improveStrategy: "extract" },
    } as AkmConfig;
  }

  test("standalone selection rejects simultaneous --engine and --strategy", () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, {});
    expect(() => resolveStandaloneExtractPlan(config, { engine: "extract-special", strategy: "extract" })).toThrow(
      "--engine and --strategy are mutually exclusive",
    );
  });

  test("an explicitly selected strategy supplies settings but cannot disable standalone extract", () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, { enabled: false, maxTotalChars: 4321 });
    const plan = resolveStandaloneExtractPlan(config, { strategy: "extract" });
    expect(plan).toMatchObject({ strategy: "extract", enabled: true, timeoutMs: 600_000 });
    expect(plan.process.enabled).toBe(false);
    expect(plan.process.maxTotalChars).toBe(4321);
  });

  test("an unset symbolic credential does not block dry-run planning with no dispatch", async () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, {});
    const engine = config.engines?.["extract-special"];
    if (engine?.kind !== "llm") throw new Error("fixture must use an LLM engine");
    engine.apiKey = "$EXTRACT_REQUIRED_API_KEY";

    await withEnv({ EXTRACT_REQUIRED_API_KEY: undefined }, async () => {
      const plan = resolveStandaloneExtractPlan(config, { engine: "extract-special" });
      expect(plan.runner?.credential).toEqual({ names: ["EXTRACT_REQUIRED_API_KEY"], required: true });
      expect(plan.runner?.connection.apiKey).toBeUndefined();

      const result = await akmExtract({
        type: "claude-code",
        dryRun: true,
        stashDir: stash,
        config,
        resolvedPlan: plan,
        harnesses: [makeFakeHarness([])],
        skipTracking: true,
      });
      expect(result.ok).toBe(true);
      expect(result.sessionsProcessed).toBe(0);
    });
  });

  test("a standalone plan freezes named-engine and process settings for repeated triggers", async () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, {
      engine: "default",
      model: "process-model",
      timeoutMs: 55_000,
      llm: { temperature: 0.2, maxTokens: 321 },
      maxTotalChars: 1234,
      hotProbation: { enabled: true },
      schemaSimilarity: { enabled: false },
    });
    const strategy = config.improve?.strategies?.extract;
    if (strategy) {
      strategy.engine = "default";
      strategy.model = "strategy-model";
      strategy.timeoutMs = 70_000;
      strategy.llm = { temperature: 0.1, supportsJsonSchema: false };
    }
    const plan = resolveStandaloneExtractPlan(config, { engine: "extract-special" });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.process)).toBe(true);
    expect(Object.isFrozen(plan.process.hotProbation)).toBe(true);
    expect(plan).toMatchObject({ strategy: "extract", engine: "extract-special", timeoutMs: 55_000 });
    expect(plan.runner?.connection).toMatchObject({
      endpoint: "http://192.168.0.205:1234/v1/chat/completions",
      model: "process-model",
      temperature: 0.2,
      maxTokens: 321,
      supportsJsonSchema: false,
    });
    expect(plan.process.maxTotalChars).toBe(1234);

    const timeoutOverridePlan = resolveStandaloneExtractPlan(config, {
      engine: "extract-special",
      timeoutMs: 45_000,
    });
    expect(timeoutOverridePlan.timeoutMs).toBe(45_000);
    expect(timeoutOverridePlan.runner?.timeoutMs).toBe(45_000);
    expect(timeoutOverridePlan.runner?.connection.model).toBe("process-model");

    const engine = config.engines?.["extract-special"];
    if (engine?.kind === "llm") engine.model = "changed-after-watch-start";
    const process = config.improve?.strategies?.extract?.processes?.extract;
    if (process) {
      process.maxTotalChars = 9999;
      if (process.hotProbation) process.hotProbation.enabled = false;
    }

    let receivedModel = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "frozen",
      stashDir: stash,
      config,
      resolvedPlan: plan,
      harnesses: [makeFakeHarness([fakeSession("frozen", Date.now())])],
      chat: async (cfg) => {
        receivedModel = cfg.model;
        return JSON.stringify({
          candidates: [
            {
              type: "memory",
              name: "frozen-hot-probation",
              description: "Frozen extract settings remain stable throughout a long-running watch invocation.",
              body: "The invocation plan captures nested extract behavior before watch triggers begin.",
              confidence: 0.9,
              evidence: "frozen plan regression test",
            },
          ],
        });
      },
    });
    expect(receivedModel).toBe("process-model");
    expect(plan.engine).toBe("extract-special");
    expect(plan.process.hotProbation?.enabled).toBe(true);
    const proposal = listProposals(stash, { status: "pending" }).find(
      (item) => item.ref === "memory:frozen-hot-probation",
    );
    expect(proposal?.payload.frontmatter?.captureMode).toBe("hot-probation");
  });

  test("a resolved null runner never falls back to live config at the extract leaf", async () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, {});
    await expect(
      akmExtract({
        type: "claude-code",
        stashDir: stash,
        config,
        resolvedPlan: Object.freeze({
          strategy: "extract",
          engine: "extract-special",
          enabled: true,
          process: Object.freeze({ enabled: true }),
          runner: null,
          timeoutMs: 600_000,
          embeddingConfig: config.embedding,
        }),
        harnesses: [makeFakeHarness([fakeSession("no-fallback", Date.now())])],
      }),
    ).rejects.toThrow("No LLM engine configured for extract");
  });

  test("honors processes.extract.engine to pick a non-default LLM", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_profile", Date.now() - 60_000);
    let receivedEndpoint = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_profile",
      stashDir: stash,
      config: configWithStrategy(stash, { engine: "extract-special" }),
      harnesses: [makeFakeHarness([session])],
      chat: async (cfg) => {
        receivedEndpoint = cfg.endpoint;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedEndpoint).toBe("http://192.168.0.205:1234/v1/chat/completions");
  });

  test("falls back to defaults.llmEngine when the process has no engine override", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_default", Date.now() - 60_000);
    let receivedModel = "";
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_default",
      stashDir: stash,
      config: configWithStrategy(stash, {}),
      harnesses: [makeFakeHarness([session])],
      chat: async (cfg) => {
        receivedModel = cfg.model;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedModel).toBe("default-model");
  });

  test("rejects an explicit non-LLM process engine without fallback", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_bad_mode", Date.now() - 60_000);
    // Build a config where the agent profile EXISTS so the runner resolver
    // succeeds and akmExtract's own kind-check fires (not the resolver's
    // missing-profile guard).
    const config = configWithStrategy(stash, { engine: "fake-agent" });
    config.engines = {
      ...config.engines,
      "fake-agent": { kind: "agent", platform: "opencode", bin: "opencode", args: ["run"] },
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
    ).rejects.toThrow(/is not an LLM engine/);
  });

  test("honors process timeoutMs override", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_to", Date.now() - 60_000);
    let receivedTimeout = 0;
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_to",
      stashDir: stash,
      config: configWithStrategy(stash, { engine: "extract-special", timeoutMs: 45_000 }),
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
      config: configWithStrategy(stash, { engine: "extract-special", timeoutMs: 45_000 }),
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
      config: configWithStrategy(stash, { defaultSince: "7d" }),
      harnesses: [makeFakeHarness([old])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(chatCalls).toBe(1);
    expect(result.sessions).toHaveLength(1);
  });

  // ── #595/#596 — minContentChars pre-LLM gate ──────────────────────────────

  /** Session whose raw content is exactly the given texts (one user event each). */
  function sessionWithTexts(id: string, texts: string[]): SessionData {
    const endedAt = Date.now() - 60_000;
    return {
      ref: {
        harness: "claude-code",
        sessionId: id,
        filePath: `/tmp/fake/${id}.jsonl`,
        startedAt: endedAt - 3600_000,
        endedAt,
      },
      events: texts.map((text, i) => ({
        harness: "claude-code",
        text,
        ts: endedAt - 60_000 * (texts.length - i),
        sessionId: id,
        role: "user" as const,
        filePath: `/tmp/fake/${id}.jsonl`,
      })),
      inlineRefs: [],
    };
  }

  async function runExtract(
    session: SessionData,
    processOverride: Record<string, unknown>,
  ): Promise<{ result: Awaited<ReturnType<typeof akmExtract>>; chatCalls: number }> {
    const stash = makeStashDir();
    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude-code",
      sessionId: session.ref.sessionId,
      stashDir: stash,
      config: configWithStrategy(stash, processOverride),
      harnesses: [makeFakeHarness([session])],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });
    return { result, chatCalls };
  }

  test("minContentChars skips sub-threshold sessions before the LLM call (skipReason too_short)", async () => {
    const tiny = sessionWithTexts("ses_tiny", ["short note"]); // 10 raw chars < 500
    const { result, chatCalls } = await runExtract(tiny, { minContentChars: 500 });
    expect(chatCalls).toBe(0);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsSkipped).toBe(1);
    expect(result.sessions[0]?.skipped).toBe(true);
    expect(result.sessions[0]?.skipReason).toBe("too_short");
  });

  test("minContentChars processes sessions at/above the threshold", async () => {
    const exact = sessionWithTexts("ses_exact", ["x".repeat(500)]); // 500 raw chars
    const { result, chatCalls } = await runExtract(exact, { minContentChars: 500 });
    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(0);
  });

  test("gates on RAW pre-filter size, not post-filter output (#596)", async () => {
    // Every event is noise the pre-filter strips (system reminders), so the
    // post-filter output is empty — but the RAW session is large, so the gate
    // must NOT skip it (gating post-filter wrongly skipped 100% of sessions).
    const noisy = sessionWithTexts(
      "ses_noisy",
      Array.from({ length: 5 }, () => `<system-reminder>${"n".repeat(200)}</system-reminder>`),
    );
    const { result, chatCalls } = await runExtract(noisy, { minContentChars: 500 });
    expect(chatCalls).toBe(1);
    expect(result.sessions[0]?.preFilter.outputCount).toBe(0); // proves the pre-filter stripped everything
    expect(result.sessions[0]?.skipReason).toBeUndefined();
  });

  test("default threshold is 10: empty sessions skip, tiny real sessions process", async () => {
    // No minContentChars in config → in-code default 10.
    const empty = sessionWithTexts("ses_empty_raw", []);
    const emptyRun = await runExtract(empty, {});
    expect(emptyRun.chatCalls).toBe(0);
    expect(emptyRun.result.sessions[0]?.skipReason).toBe("too_short");

    // 22 raw chars — the analysis floor for candidate-yielding sessions (#597).
    const tinyReal = sessionWithTexts("ses_22", ["use jwt 24h ttl always"]);
    const tinyRun = await runExtract(tinyReal, {});
    expect(tinyRun.chatCalls).toBe(1);
    expect(tinyRun.result.sessionsProcessed).toBe(1);
  });

  test("minContentChars: 0 disables the gate entirely", async () => {
    const empty = sessionWithTexts("ses_empty_gate_off", []);
    const { result, chatCalls } = await runExtract(empty, { minContentChars: 0 });
    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
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
      force: true, // re-extract the same session twice to compare prompt budgets
      stashDir: stash,
      config: configWithStrategy(stash, { maxTotalChars: 1500 }),
      harnesses: [makeFakeHarness([fatSession])],
      chat: async (_cfg, msgs) => {
        tightPromptLen = msgs[0]?.content.length ?? 0;
        return JSON.stringify({ candidates: [] });
      },
    });
    await akmExtract({
      type: "claude-code",
      sessionId: "ses_budget",
      force: true, // --force overrides the content-hash skip on the second run
      stashDir: stash,
      config: configWithStrategy(stash, { maxTotalChars: 100_000 }),
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
