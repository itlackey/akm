// Integration-style tests for akmExtract. Real proposal queue + real
// filesystem, but harness + LLM chat are injected so no network / no
// platform install needed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  akmExtract,
  deriveExtractCandidateRef,
  parseSinceArg,
  resolveStandaloneExtractPlan,
} from "../../src/commands/improve/extract";
import { EXTRACT_JSON_SCHEMA } from "../../src/commands/improve/extract-prompt";
import { listProposals } from "../../src/commands/proposal/repository";
import { isValidDescription } from "../../src/commands/proposal/validators/proposal-quality-validators";
import { parseFrontmatter } from "../../src/core/asset/frontmatter";
import type { AkmConfig } from "../../src/core/config/config";
import { ImproveProcessConfigSchema, ImproveProfileConfigSchema } from "../../src/core/config/config-schema";
import { ConfigError, UsageError } from "../../src/core/errors";
import { readEvents } from "../../src/core/events";
import { createLockPayload } from "../../src/core/file-lock";
import { getStateDbPath, openStateDatabase } from "../../src/core/state-db";
import { detectTruncatedDescription } from "../../src/core/text-truncation";
import { ClaudeCodeProvider } from "../../src/integrations/harnesses/claude/session-log";
import type {
  SessionData,
  SessionLogHarness,
  SessionRef,
  SessionSummary,
} from "../../src/integrations/session-logs/types";
import {
  getExtractedSessionsMap,
  upsertExtractedSession,
} from "../../src/storage/repositories/extract-sessions-repository";
import { durableItemRef } from "../_helpers/durable-ref";
import { type IsolatedAkmStorage, mutateScopedEnv, withEnv, withIsolatedAkmStorage } from "../_helpers/sandbox";

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
function snapshotTree(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  if (!fs.existsSync(root)) return snapshot;
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot.set(`${relative}/`, "directory");
        visit(absolute);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        snapshot.set(relative, `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`);
      }
    }
  };
  visit(root);
  return snapshot;
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
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
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
    bundles: { stash: { path: stashDir, writable: true } },
    defaultBundle: "stash",
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
      harness: "claude",
      sessionId: id,
      filePath: `/tmp/fake/${id}.jsonl`,
      startedAt: endedAt - 3600_000,
      endedAt,
      title: `Session ${id}`,
    },
    events: [
      {
        harness: "claude",
        text: "user message: explain how to recover from VPN-disconnect during deploy",
        ts: endedAt - 3000_000,
        sessionId: id,
        role: "user",
        filePath: `/tmp/fake/${id}.jsonl`,
      },
      {
        harness: "claude",
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
    name: "claude",
    isAvailable: () => available,
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

describe("extract candidate placement", () => {
  test("uses flat fallback instead of trusting a model-provided knowledge domain", () => {
    const candidate = {
      type: "knowledge" as const,
      name: "project-a/oauth-refresh-race",
      description: "OAuth refresh races can invalidate a newly rotated token during concurrent requests.",
      body: "Concurrent refresh requests must serialize token rotation so an older response cannot replace a newer token.",
      confidence: 0.95,
      evidence: "concurrent refresh failure in the session",
    };
    const source = { harness: "claude", sessionId: "s1", filePath: "/tmp/s1", projectHint: "project-a" };

    expect(deriveExtractCandidateRef(candidate, source)).toBe("knowledge/oauth-refresh-race");
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
      type: "claude",
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
      type: "claude",
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
      type: "claude",
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
      type: "claude",
      stashDir: stash,
      config: cfg,
      harnesses: [makeFakeHarness(sessions)],
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

  test("an explicit --since bypasses maxSessionsPerRun", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const sessions = Array.from({ length: 5 }, (_, i) => fakeSession(`s${i}`, now - (i + 1) * 60_000));
    const cfg = configEnabled(stash) as AkmConfig & {
      improve: { strategies: { extract: { processes: { extract: Record<string, unknown> } } } };
    };
    cfg.improve.strategies.extract.processes.extract.maxSessionsPerRun = 3;

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude",
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
    expect(chatCalls).toBe(5); // cap bypassed — all 5 processed
    expect(result.sessionsProcessed).toBe(5);
    expect(result.warnings.join(" ")).not.toMatch(/maxSessionsPerRun/);
  });
});

// ── #912/#913: skip-reason aggregation + resolved engine on the envelope ────
describe("akmExtract — skip aggregation + resolved engine (#912, #913)", () => {
  function fakeSessionWithText(id: string, endedAt: number, text: string): SessionData {
    return {
      ref: {
        harness: "claude",
        sessionId: id,
        filePath: `/tmp/fake/${id}.jsonl`,
        startedAt: endedAt - 3600_000,
        endedAt,
        title: `Session ${id}`,
      },
      events: [
        {
          harness: "claude",
          text,
          ts: endedAt - 3000_000,
          sessionId: id,
          role: "user",
          filePath: `/tmp/fake/${id}.jsonl`,
        },
      ],
      inlineRefs: [],
    };
  }

  test("every discovered session llm_unavailable → ok:true, aggregate warning naming the engine, skipReasons + envelope/session engine", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const sessions = Array.from({ length: 3 }, (_, i) => fakeSession(`down-${i}`, now - (i + 1) * 60_000));

    const result = await akmExtract({
      type: "claude",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness(sessions)],
      since: "24h",
      chat: async () => {
        throw new Error("llm endpoint unreachable");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.sessionsSkipped).toBe(3);
    expect(result.sessions.every((s) => s.skipReason === "llm_unavailable")).toBe(true);
    expect(result.warnings).toContain('3 of 3 sessions skipped: llm_unavailable (engine "default")');
    expect(result.skipReasons).toEqual({ llm_unavailable: 3 });
    expect(result.engine).toBe("default");
    expect(result.engineKind).toBe("llm");
    expect(result.sessions.every((s) => s.engine === "default")).toBe(true);
  });

  test("a mix of llm_unavailable and too_short only warns for the infrastructure reason; skipReasons counts both", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    // Below the 50-char minContentChars floor set below → skipped too_short,
    // never reaching the (throwing) LLM call.
    const short = fakeSessionWithText("short", now - 60_000, "hi");
    // Above the floor → reaches the LLM call, which always throws → llm_unavailable.
    const long = fakeSessionWithText(
      "long",
      now - 120_000,
      "a session transcript long enough to clear the minContentChars floor for this test",
    );
    const cfg = configEnabled(stash) as AkmConfig & {
      improve: { strategies: { extract: { processes: { extract: Record<string, unknown> } } } };
    };
    cfg.improve.strategies.extract.processes.extract.minContentChars = 50;

    const result = await akmExtract({
      type: "claude",
      stashDir: stash,
      config: cfg,
      harnesses: [makeFakeHarness([short, long])],
      since: "24h",
      chat: async () => {
        throw new Error("llm endpoint unreachable");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sessionsSkipped).toBe(2);
    expect(result.skipReasons).toEqual({ llm_unavailable: 1, too_short: 1 });
    const infraWarnings = result.warnings.filter((w) => w.includes("sessions skipped"));
    expect(infraWarnings).toEqual(['1 of 2 sessions skipped: llm_unavailable (engine "default")']);
  });

  test("a fully successful run has no skipReasons key", async () => {
    const stash = makeStashDir();
    const session = fakeSession("clean", Date.now());

    const result = await akmExtract({
      type: "claude",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    expect(result.ok).toBe(true);
    expect(result.sessionsSkipped).toBe(0);
    expect(result.skipReasons).toBeUndefined();
    expect(result.engine).toBe("default");
    expect(result.engineKind).toBe("llm");
  });
});

describe("akmExtract — single-session mode", () => {
  test("processes only the specified sessionId", async () => {
    const stash = makeStashDir();
    const now = Date.now();
    const target = fakeSession("target", now - 10 * 60_000);
    const other = fakeSession("other", now - 5 * 60_000);

    const result = await akmExtract({
      type: "claude",
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
      type: "claude",
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

describe("akmExtract — subagent transcripts are never extracted as their own session (#839)", () => {
  // Real ClaudeCodeProvider (not the fake harness) driven against
  // `withIsolatedAkmStorage()`'s isolated `AKM_CLAUDE_PROJECTS_DIR`, so
  // `listSessions()`'s subagents-exclusion (#830) and the folding in
  // `readSession()` both run for real. `chat` is still injected so no LLM
  // call happens.
  function writeClaudeSessionJsonl(filePath: string, lines: object[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  }

  function seedParentAndSubagent(root: string): { parentId: string; subagentId: string } {
    const project = path.join(root, "-home-user-akm");
    const parentId = "session-1";
    writeClaudeSessionJsonl(path.join(project, `${parentId}.jsonl`), [
      {
        type: "user",
        timestamp: "2026-08-01T10:00:00.000Z",
        message: { role: "user", content: "Please delegate the release-branch audit to a subagent." },
      },
      {
        type: "assistant",
        timestamp: "2026-08-01T10:30:00.000Z",
        message: { role: "assistant", content: "Delegated it; the subagent reported back and the audit is done." },
      },
    ]);
    const subagentId = "abc123";
    writeClaudeSessionJsonl(path.join(project, parentId, "subagents", `agent-${subagentId}.jsonl`), [
      {
        type: "assistant",
        timestamp: "2026-08-01T10:15:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "SUBAGENT_MARKER: audited every release branch, all clean." }],
        },
      },
    ]);
    fs.writeFileSync(
      path.join(project, parentId, "subagents", `agent-${subagentId}.meta.json`),
      JSON.stringify({ agentType: "general-purpose", description: "Audit release branches" }),
    );
    return { parentId, subagentId };
  }

  test("discovery mode processes exactly one session, subagent transcript never surfaced as its own", async () => {
    const stash = makeStashDir();
    const { parentId } = seedParentAndSubagent(storage.sessionLogsDir);

    let chatCalls = 0;
    let capturedPrompt = "";
    const result = await akmExtract({
      type: "claude",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [new ClaudeCodeProvider()],
      since: "24h",
      chat: async (_cfg, msgs) => {
        chatCalls += 1;
        capturedPrompt = msgs[0]?.content ?? "";
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(result.ok).toBe(true);
    // Exactly one session — the subagent transcript never surfaces as its own.
    expect(chatCalls).toBe(1);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe(parentId);
    expect(result.sessions[0]?.contentHash).toBeDefined();
    // #840 — harvest-without-prompting hybrid: the folded subagent transcript
    // is still read and hashed under the parent's identity (no double
    // extraction), but its raw text is never sent to the LLM — only
    // parent-origin events reach the prompt. The subagent's provenance-
    // prefixed text ("[subagent:...]") must NOT appear here.
    expect(capturedPrompt).not.toContain("SUBAGENT_MARKER");
    expect(capturedPrompt).not.toContain("[subagent:");
  });

  test("--session-id agent-<hash> returns the not-found result, not an extraction", async () => {
    const stash = makeStashDir();
    const { subagentId } = seedParentAndSubagent(storage.sessionLogsDir);

    let chatCalls = 0;
    const result = await akmExtract({
      type: "claude",
      sessionId: `agent-${subagentId}`,
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [new ClaudeCodeProvider()],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [] });
      },
    });

    expect(result.ok).toBe(false);
    expect(result.sessionsProcessed).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/not found/);
    expect(chatCalls).toBe(0);
  });
});

describe("akmExtract — candidate → proposal routing", () => {
  test("creates one proposal per valid candidate, with merged body frontmatter", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_abc", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude",
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
    const lessonProp = pending.find((p) => p.ref === durableItemRef(stash, "lesson", "vpn-before-deploy"));
    expect(lessonProp).toBeDefined();
    // Body must contain description in YAML frontmatter so accept-time validator passes
    expect(lessonProp?.payload.content).toMatch(/description:.*VPN/);
    expect(lessonProp?.payload.content).toMatch(/when_to_use:/);
    // Session indexing is disabled, so the proposal must not cite an asset that
    // does not exist.
    expect(parseFrontmatter(lessonProp?.payload.content ?? "").data.xrefs).toBeUndefined();
    const event = readEvents({ type: "extract_invoked" }).events.at(-1);
    expect(event?.ref).toBeUndefined();
    expect(event?.metadata?.sessionId).toBe("ses_abc");
  });

  test("adds session xrefs only after the session asset is written", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_live", Date.now() - 60_000);
    const config = configEnabled(stash);
    const extractProcess = config.improve?.strategies?.extract?.processes?.extract;
    if (extractProcess) extractProcess.indexSessions = true;

    await akmExtract({
      type: "claude",
      sessionId: "ses_live",
      stashDir: stash,
      config,
      harnesses: [makeFakeHarness([session])],
      generateSessionSummary: async () => ({
        summary: "The session established a reliable deployment ordering rule.",
        keyTopics: ["deployments"],
        tags: ["deploy"],
      }),
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "lesson",
              name: "vpn-before-deploy",
              description: "Production deployments require the VPN connection before the deployment script starts.",
              when_to_use: "When starting a production deployment from a new shell.",
              body: "Connect the VPN before invoking the deployment script.",
              confidence: 0.95,
              evidence: "The session demonstrated the required ordering.",
            },
          ],
        }),
    });

    const proposal = listProposals(stash, { status: "pending" }).find((p) => p.source === "extract");
    expect(fs.existsSync(path.join(stash, "sessions", "claude", "ses_live.md"))).toBe(true);
    expect(parseFrontmatter(proposal?.payload.content ?? "").data.xrefs).toEqual(["sessions/claude/ses_live"]);
  });

  test("places scope-born candidates under the canonical project slug", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_scoped", Date.now() - 60_000);
    session.ref.projectHint = "Project A";

    await akmExtract({
      type: "claude",
      sessionId: "ses_scoped",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async () =>
        JSON.stringify({
          candidates: [
            {
              type: "memory",
              name: "vpn-deploy-order",
              description: "Production deploys require the VPN connection before the deployment script starts.",
              body: "The deployment script stalls during its stage push when the corporate VPN is disconnected.",
              confidence: 0.95,
              evidence: "the deploy failed before the VPN was connected",
            },
          ],
        }),
    });

    const pending = listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract");
    expect(pending.map((p) => p.ref)).toEqual([durableItemRef(stash, "memory", "project-a/vpn-deploy-order")]);
    const parsed = parseFrontmatter(pending[0]?.payload.content ?? "");
    expect(parsed.data.xrefs).toBeUndefined();
  });

  test("repairs a truncated description so the auto-accept validator passes (#556)", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_trunc", Date.now() - 60_000);
    const proposalRef = durableItemRef(stash, "lesson", "vpn-before-deploy");

    // The LLM produced a description sliced mid-clause (ends with "to"). On the
    // pre-#556 path this lands as-is and the description-quality validator
    // rejects it at accept time. The repair pass must complete it first.
    const truncatedDesc = "Always connect to the corporate VPN before running deploy.sh to";
    expect(detectTruncatedDescription(truncatedDesc)).not.toBeNull();
    expect(isValidDescription(truncatedDesc, proposalRef).ok).toBe(false);

    const result = await akmExtract({
      type: "claude",
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
    const prop = pending.find((p) => p.ref === proposalRef);
    expect(prop).toBeDefined();

    // The persisted content's frontmatter description must now be valid.
    const fm = parseFrontmatter(prop?.payload.content ?? "").data as Record<string, unknown>;
    expect(typeof fm.description).toBe("string");
    expect(detectTruncatedDescription(fm.description as string)).toBeNull();
    expect(isValidDescription(fm.description, proposalRef).ok).toBe(true);

    // The payload frontmatter mirror must carry the same repaired value.
    const payloadDesc = (prop?.payload.frontmatter as Record<string, unknown> | undefined)?.description;
    expect(payloadDesc).toBe(fm.description as string);
  });

  test("dry-run reports candidates without creating proposals", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_dry", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude",
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
    expect(result.proposals[0]).toMatch(/^dry-run:memories\/fact-1$/);
    // No actual proposal queued
    expect(listProposals(stash, { status: "pending" }).filter((p) => p.source === "extract")).toEqual([]);
  });

  test("handles empty-candidates response by emitting rationale", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_empty", Date.now() - 60_000);

    const result = await akmExtract({
      type: "claude",
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
  test("repairs malformed output once when the engine lacks JSON Schema support", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_repair", Date.now() - 60_000);
    const config = configEnabled(stash);
    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.supportsJsonSchema = false;
    const responses = [
      "I found nothing worth keeping.",
      JSON.stringify({ candidates: [], rationale_if_empty: "No durable candidates were identified." }),
    ];
    const prompts: string[] = [];

    const result = await akmExtract({
      type: "claude",
      sessionId: session.ref.sessionId,
      stashDir: stash,
      config,
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, messages) => {
        prompts.push(messages.at(-1)?.content ?? "");
        return responses.shift() ?? "";
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toBe(prompts[0]);
    expect(prompts[1]).toContain("ONLY a JSON object");
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(0);
    expect(result.sessions[0]?.rationaleIfEmpty).toContain("No durable candidates");
    expect(result.warnings).toEqual([]);
  });

  test("injects only conventions for candidate output types", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_standards", Date.now() - 60_000);
    const conventions = path.join(stash, "facts", "conventions", "assets");
    fs.mkdirSync(conventions, { recursive: true });
    fs.writeFileSync(path.join(conventions, "memory.md"), "---\ncategory: convention\n---\n\nMEMORY_OUTPUT_RULE\n");
    fs.writeFileSync(path.join(conventions, "skill.md"), "---\ncategory: convention\n---\n\nSKILL_OUTPUT_RULE\n");
    let prompt = "";

    await akmExtract({
      type: "claude",
      sessionId: "ses_standards",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, messages) => {
        prompt = messages.at(-1)?.content ?? "";
        return JSON.stringify({ candidates: [], rationale_if_empty: "No durable candidates were identified." });
      },
    });

    expect(prompt).toContain("MEMORY_OUTPUT_RULE");
    expect(prompt).not.toContain("SKILL_OUTPUT_RULE");
  });

  test("passes EXTRACT_JSON_SCHEMA as responseSchema", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_schema", Date.now() - 60_000);

    let receivedSchema: unknown;
    await akmExtract({
      type: "claude",
      sessionId: "ses_schema",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, _messages, options) => {
        receivedSchema = options?.responseSchema;
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedSchema).toEqual(EXTRACT_JSON_SCHEMA);
  });

  test("passes a prompt that mentions the session title + harness", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_prompt", Date.now() - 60_000);

    let receivedPrompt = "";
    await akmExtract({
      type: "claude",
      sessionId: "ses_prompt",
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [makeFakeHarness([session])],
      chat: async (_config, messages) => {
        receivedPrompt = messages[0]?.content ?? "";
        return JSON.stringify({ candidates: [] });
      },
    });
    expect(receivedPrompt).toContain("claude");
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
  test("a live lock created while classification reads the session suppresses credential materialization", async () => {
    const stash = storage.stashDir;
    const session = fakeSession("credential-lock-race", Date.now());
    const config = configEnabled(stash);
    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.apiKey = "$AKM_EXTRACT_LOCK_RACE_REQUIRED_KEY";
    const stateDbPath = getStateDbPath();
    const lockPath = path.join(
      path.dirname(stateDbPath),
      "extract-locks",
      `extract-claude-${session.ref.sessionId}.lock`,
    );
    const baseHarness = makeFakeHarness([session]);
    let lockBytes = "";
    let chatCalls = 0;
    const harness: SessionLogHarness = {
      ...baseHarness,
      readSession: (ref) => {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        lockBytes ||= createLockPayload();
        if (!fs.existsSync(lockPath)) fs.writeFileSync(lockPath, lockBytes, "utf8");
        return baseHarness.readSession(ref);
      },
    };

    const result = await withEnv({ AKM_EXTRACT_LOCK_RACE_REQUIRED_KEY: undefined }, () =>
      akmExtract({
        type: "claude",
        sessionId: session.ref.sessionId,
        stashDir: stash,
        stateDbPath,
        config,
        harnesses: [harness],
        chat: async () => {
          chatCalls += 1;
          throw new Error("locked session dispatched an LLM request");
        },
      }),
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ skipped: true, skipReason: "locked_concurrent" });
    expect(chatCalls).toBe(0);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(lockBytes);
    expect(fs.existsSync(stateDbPath)).toBe(false);
  });

  test("a newly locked first candidate frees its maxSessionsPerRun slot for the next candidate", async () => {
    const stash = storage.stashDir;
    const first = fakeSession("lock-cap-first", Date.now());
    const second = fakeSession("lock-cap-second", Date.now() - 1);
    const config = configEnabled(stash);
    const process = config.improve?.strategies?.extract?.processes?.extract;
    if (process) process.maxSessionsPerRun = 1;
    const stateDbPath = getStateDbPath();
    const firstLockPath = path.join(
      path.dirname(stateDbPath),
      "extract-locks",
      `extract-claude-${first.ref.sessionId}.lock`,
    );
    const baseHarness = makeFakeHarness([first, second]);
    let chatCalls = 0;
    const harness: SessionLogHarness = {
      ...baseHarness,
      readSession: (ref) => {
        if (ref.sessionId === first.ref.sessionId && !fs.existsSync(firstLockPath)) {
          fs.mkdirSync(path.dirname(firstLockPath), { recursive: true });
          fs.writeFileSync(firstLockPath, createLockPayload(), "utf8");
        }
        return baseHarness.readSession(ref);
      },
    };

    const result = await akmExtract({
      type: "claude",
      since: "24h",
      stashDir: stash,
      stateDbPath,
      config,
      harnesses: [harness],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
      },
    });

    expect(result.sessions.map((item) => [item.sessionId, item.skipReason ?? null])).toEqual([
      [first.ref.sessionId, "locked_concurrent"],
      [second.ref.sessionId, null],
    ]);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(1);
    expect(chatCalls).toBe(1);
    expect(result.warnings.join(" ")).not.toContain("deferred");
    const stateDb = openStateDatabase(stateDbPath);
    try {
      expect(getExtractedSessionsMap(stateDb, "claude", [first.ref.sessionId]).size).toBe(0);
      expect(getExtractedSessionsMap(stateDb, "claude", [second.ref.sessionId]).size).toBe(1);
    } finally {
      stateDb.close();
    }
  });

  test("a lock acquired after the final planning probe refills the capped slot at execution", async () => {
    const stash = storage.stashDir;
    const first = fakeSession("post-probe-lock-first", Date.now());
    const second = fakeSession("post-probe-lock-second", Date.now() - 1);
    const config = configEnabled(stash);
    const process = config.improve?.strategies?.extract?.processes?.extract;
    if (process) process.maxSessionsPerRun = 1;
    const stateDbPath = getStateDbPath();
    const firstLockPath = path.join(
      path.dirname(stateDbPath),
      "extract-locks",
      `extract-claude-${first.ref.sessionId}.lock`,
    );
    const baseHarness = makeFakeHarness([first, second]);
    let scheduled = false;
    let chatCalls = 0;
    const harness: SessionLogHarness = {
      ...baseHarness,
      readSession: (ref) => {
        if (ref.sessionId === first.ref.sessionId && !scheduled) {
          scheduled = true;
          queueMicrotask(() => {
            fs.mkdirSync(path.dirname(firstLockPath), { recursive: true });
            fs.writeFileSync(firstLockPath, createLockPayload(), "utf8");
          });
        }
        return baseHarness.readSession(ref);
      },
    };

    const result = await akmExtract({
      type: "claude",
      since: "24h",
      stashDir: stash,
      stateDbPath,
      config,
      harnesses: [harness],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
      },
    });

    expect(result.sessions.map((item) => [item.sessionId, item.skipReason ?? null])).toEqual([
      [first.ref.sessionId, "locked_concurrent"],
      [second.ref.sessionId, null],
    ]);
    expect(chatCalls).toBe(1);
    expect(result.warnings.join(" ")).not.toContain("deferred");
  });

  test("execution rereads and gates the current session revision after acquiring its lock", async () => {
    const stash = storage.stashDir;
    const initial = fakeSession("content-race", Date.now());
    const current = fakeSession(initial.ref.sessionId, initial.ref.endedAt ?? Date.now());
    const currentEvent = current.events[0];
    if (!currentEvent) throw new Error("test fixture requires a session event");
    current.events = [
      { ...currentEvent, text: "CURRENT_REVISION_MARKER durable insight from the latest session bytes" },
    ];
    const baseHarness = makeFakeHarness([initial]);
    let reads = 0;
    let prompt = "";
    const harness: SessionLogHarness = {
      ...baseHarness,
      readSession: () => {
        reads += 1;
        return reads === 1 ? initial : current;
      },
    };

    const result = await akmExtract({
      type: "claude",
      sessionId: initial.ref.sessionId,
      stashDir: stash,
      config: configEnabled(stash),
      harnesses: [harness],
      chat: async (_connection, messages) => {
        prompt = messages.at(-1)?.content ?? "";
        return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
      },
    });

    expect(reads).toBeGreaterThanOrEqual(2);
    expect(prompt).toContain("CURRENT_REVISION_MARKER");
    expect(result.sessions[0]?.contentHash).toBe(
      createHash("sha256").update(`user\n${current.events[0]?.text}`).digest("hex"),
    );
  });

  test("an under-lock content regate frees its capped slot for the next candidate", async () => {
    const stash = storage.stashDir;
    const first = fakeSession("content-regate-first", Date.now());
    const second = fakeSession("content-regate-second", Date.now() - 1);
    const shortened = fakeSession(first.ref.sessionId, first.ref.endedAt ?? Date.now());
    const firstEvent = shortened.events[0];
    if (!firstEvent) throw new Error("test fixture requires a session event");
    shortened.events = [{ ...firstEvent, text: "tiny" }];
    const config = configEnabled(stash);
    const process = config.improve?.strategies?.extract?.processes?.extract;
    if (process) {
      process.maxSessionsPerRun = 1;
      process.minContentChars = 100;
    }
    const baseHarness = makeFakeHarness([first, second]);
    let firstReads = 0;
    let chatCalls = 0;
    const harness: SessionLogHarness = {
      ...baseHarness,
      readSession: (ref) => {
        if (ref.sessionId !== first.ref.sessionId) return baseHarness.readSession(ref);
        firstReads += 1;
        return firstReads === 1 ? first : shortened;
      },
    };

    const result = await akmExtract({
      type: "claude",
      since: "24h",
      stashDir: stash,
      config,
      harnesses: [harness],
      chat: async () => {
        chatCalls += 1;
        return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
      },
    });

    expect(result.sessions.map((item) => [item.sessionId, item.skipReason ?? null])).toEqual([
      [first.ref.sessionId, "too_short"],
      [second.ref.sessionId, null],
    ]);
    expect(result.sessionsProcessed).toBe(1);
    expect(result.sessionsSkipped).toBe(1);
    expect(chatCalls).toBe(1);
    expect(result.warnings.join(" ")).not.toContain("deferred");
  });

  test("missing required symbolic credential aborts without proposals, session assets, or session-state rows", async () => {
    const stash = makeStashDir();
    const session = fakeSession("credential", Date.now());
    const config = configEnabled(stash);
    const defaultEngine = config.engines?.default;
    if (!defaultEngine || defaultEngine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    defaultEngine.apiKey = "$AKM_EXTRACT_REQUIRED_KEY";
    let chatCalls = 0;
    const stateDb = openStateDatabase();
    try {
      const failure = withEnv({ AKM_EXTRACT_REQUIRED_KEY: undefined }, () =>
        akmExtract({
          type: "claude",
          sessionId: session.ref.sessionId,
          stashDir: stash,
          config,
          harnesses: [makeFakeHarness([session])],
          stateDb,
          chat: async () => {
            chatCalls += 1;
            return JSON.stringify({ candidates: [] });
          },
        }),
      );

      await expect(failure).rejects.toBeInstanceOf(ConfigError);
      await expect(failure).rejects.toMatchObject({ code: "INVALID_CONFIG_FILE" });
      expect(chatCalls).toBe(0);
      expect(listProposals(stash)).toEqual([]);
      expect(fs.existsSync(path.join(stash, "sessions")) ? fs.readdirSync(path.join(stash, "sessions")) : []).toEqual(
        [],
      );
      expect(getExtractedSessionsMap(stateDb, "claude", [session.ref.sessionId]).size).toBe(0);
    } finally {
      stateDb.close();
    }
  });

  test("an extract run keeps its preflight credential snapshot across multiple session mutations", async () => {
    const stash = makeStashDir();
    const first = fakeSession("lease-first", Date.now());
    const second = fakeSession("lease-second", Date.now() - 1);
    const config = configEnabled(stash);
    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.apiKey = "$AKM_EXTRACT_LEASE_KEY";
    const secret = "extract-lease-original-092";
    const observed: Array<string | undefined> = [];
    const stateDb = openStateDatabase();
    try {
      const result = await withEnv({ AKM_EXTRACT_LEASE_KEY: secret }, () =>
        akmExtract({
          type: "claude",
          since: "24h",
          stashDir: stash,
          config,
          harnesses: [makeFakeHarness([first, second])],
          stateDb,
          chat: async (connection) => {
            observed.push(connection.apiKey);
            if (observed.length === 1) mutateScopedEnv("AKM_EXTRACT_LEASE_KEY", undefined);
            return JSON.stringify({ candidates: [], rationale_if_empty: "nothing durable" });
          },
        }),
      );

      expect(result.sessionsProcessed).toBe(2);
      expect(observed).toEqual([secret, secret]);
      expect(getExtractedSessionsMap(stateDb, "claude", [first.ref.sessionId, second.ref.sessionId]).size).toBe(2);
    } finally {
      stateDb.close();
    }
  });

  test("missing required symbolic credential does not create state.db, tracking, session, or proposal assets", async () => {
    const stash = makeStashDir();
    const session = fakeSession("credential-no-state", Date.now());
    const config = configEnabled(stash);
    const defaultEngine = config.engines?.default;
    if (!defaultEngine || defaultEngine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    defaultEngine.apiKey = "$AKM_EXTRACT_NO_STATE_REQUIRED_KEY";
    const stateDbPath = getStateDbPath();
    const beforeTree = fs.readdirSync(stash, { recursive: true }).map(String).sort();
    let chatCalls = 0;

    const failure = withEnv({ AKM_EXTRACT_NO_STATE_REQUIRED_KEY: undefined }, () =>
      akmExtract({
        type: "claude",
        sessionId: session.ref.sessionId,
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([session])],
        chat: async () => {
          chatCalls += 1;
          return JSON.stringify({ candidates: [] });
        },
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    expect(chatCalls).toBe(0);
    expect(fs.existsSync(stateDbPath)).toBe(false);
    expect(fs.readdirSync(stash, { recursive: true }).map(String).sort()).toEqual(beforeTree);
  });

  test("default discovery validates a required credential before creating any durable state", async () => {
    const stash = storage.stashDir;
    const session = fakeSession("credential-discovery-no-state", Date.now());
    const config = configEnabled(stash);
    const defaultEngine = config.engines?.default;
    if (!defaultEngine || defaultEngine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    defaultEngine.apiKey = "$AKM_EXTRACT_DISCOVERY_REQUIRED_KEY";
    const stateDbPath = getStateDbPath();
    const dataTreeBefore = snapshotTree(storage.dataDir);
    const storageTreeBefore = snapshotTree(storage.root);
    let chatCalls = 0;

    const failure = withEnv({ AKM_EXTRACT_DISCOVERY_REQUIRED_KEY: undefined }, () =>
      akmExtract({
        type: "claude",
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([session])],
        chat: async () => {
          chatCalls += 1;
          return JSON.stringify({ candidates: [] });
        },
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    await expect(failure).rejects.toMatchObject({
      code: "INVALID_CONFIG_FILE",
      message: "Required engine credential AKM_EXTRACT_DISCOVERY_REQUIRED_KEY is not set.",
    });
    expect(chatCalls).toBe(0);
    expect(fs.existsSync(stateDbPath)).toBe(false);
    expect(fs.existsSync(`${stateDbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${stateDbPath}-shm`)).toBe(false);
    expect(snapshotTree(storage.dataDir)).toEqual(dataTreeBefore);
    expect(snapshotTree(storage.root)).toEqual(storageTreeBefore);
  });

  test.each([
    {
      reason: "too_short" as const,
      key: "AKM_EXTRACT_TOO_SHORT_REQUIRED_KEY",
      configure: (config: AkmConfig) => {
        const process = config.improve?.strategies?.extract?.processes?.extract;
        if (process) process.minContentChars = 100_000;
      },
      harness: (session: SessionData) => makeFakeHarness([session]),
    },
    {
      reason: "triaged_out" as const,
      key: "AKM_EXTRACT_TRIAGED_REQUIRED_KEY",
      configure: (config: AkmConfig) => {
        const process = config.improve?.strategies?.extract?.processes?.extract;
        if (process) process.triage = { enabled: true, minScore: 10 };
      },
      harness: (session: SessionData) => makeFakeHarness([session]),
    },
    {
      reason: "read_failed" as const,
      key: "AKM_EXTRACT_READ_FAILED_REQUIRED_KEY",
      configure: (_config: AkmConfig) => {},
      harness: (session: SessionData): SessionLogHarness => ({
        ...makeFakeHarness([session]),
        readSession: () => {
          throw new Error("fixture read failure");
        },
      }),
    },
  ])("missing required credential is not materialized for $reason", async ({ reason, key, configure, harness }) => {
    const stash = storage.stashDir;
    const session = fakeSession(`credential-${reason}`, Date.now());
    const config = configEnabled(stash);
    configure(config);
    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.apiKey = `$${key}`;
    const before = snapshotTree(storage.root);
    let chatCalls = 0;

    const result = await withEnv({ [key]: undefined }, () =>
      akmExtract({
        type: "claude",
        sessionId: session.ref.sessionId,
        stashDir: stash,
        config,
        harnesses: [harness(session)],
        chat: async () => {
          chatCalls += 1;
          throw new Error(`deterministic ${reason} gate dispatched an LLM request`);
        },
      }),
    );

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ skipped: true, skipReason: reason });
    expect(chatCalls).toBe(0);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("missing required credential is not materialized for an unchanged already-extracted session", async () => {
    const stash = storage.stashDir;
    const session = fakeSession("credential-already-extracted", Date.now());
    const config = configEnabled(stash);
    await akmExtract({
      type: "claude",
      sessionId: session.ref.sessionId,
      stashDir: stash,
      config,
      harnesses: [makeFakeHarness([session])],
      chat: async () => JSON.stringify({ candidates: [] }),
    });

    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.apiKey = "$AKM_EXTRACT_ALREADY_REQUIRED_KEY";
    const before = snapshotTree(storage.root);
    let chatCalls = 0;

    const result = await withEnv({ AKM_EXTRACT_ALREADY_REQUIRED_KEY: undefined }, () =>
      akmExtract({
        type: "claude",
        sessionId: session.ref.sessionId,
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([session])],
        chat: async () => {
          chatCalls += 1;
          throw new Error("already-extracted gate dispatched an LLM request");
        },
      }),
    );

    expect(result.sessions[0]).toMatchObject({ skipped: true, skipReason: "already_extracted" });
    expect(chatCalls).toBe(0);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("a deterministic skip plus eligible session fails before any partial tracking, lock, or proposal mutation", async () => {
    const stash = storage.stashDir;
    const short = fakeSession("credential-mixed-short", Date.now());
    const firstEvent = short.events[0];
    if (!firstEvent) throw new Error("test fixture requires one session event");
    short.events = [{ ...firstEvent, text: "tiny" }];
    const eligible = fakeSession("credential-mixed-eligible", Date.now() - 1);
    const config = configEnabled(stash);
    const process = config.improve?.strategies?.extract?.processes?.extract;
    if (process) process.minContentChars = 20;
    const engine = config.engines?.default;
    if (!engine || engine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    engine.apiKey = "$AKM_EXTRACT_MIXED_REQUIRED_KEY";
    const before = snapshotTree(storage.root);
    let chatCalls = 0;

    const failure = withEnv({ AKM_EXTRACT_MIXED_REQUIRED_KEY: undefined }, () =>
      akmExtract({
        type: "claude",
        since: "24h",
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([short, eligible])],
        chat: async () => {
          chatCalls += 1;
          return JSON.stringify({ candidates: [] });
        },
      }),
    );

    await expect(failure).rejects.toBeInstanceOf(ConfigError);
    expect(chatCalls).toBe(0);
    expect(snapshotTree(storage.root)).toEqual(before);
  });

  test("default discovery reads a held-WAL watermark without mutating state or materializing a no-work credential", async () => {
    const stash = storage.stashDir;
    const stateDbPath = getStateDbPath();
    const stateDb = openStateDatabase(stateDbPath);
    const watermark = Date.now() - 10 * 24 * 60 * 60 * 1000;
    upsertExtractedSession(stateDb, {
      harness: "claude",
      sessionId: "prior-watermark",
      processedAt: new Date(watermark).toISOString(),
      outcome: "no_candidates",
      candidateCount: 0,
      proposalCount: 0,
      contentHash: "prior-content",
    });
    expect(fs.existsSync(stateDbPath)).toBe(true);
    expect(fs.existsSync(`${stateDbPath}-wal`)).toBe(true);
    expect(fs.existsSync(`${stateDbPath}-shm`)).toBe(true);
    const config = configEnabled(stash);
    const defaultEngine = config.engines?.default;
    if (!defaultEngine || defaultEngine.kind !== "llm") throw new Error("test fixture requires the default LLM engine");
    defaultEngine.apiKey = "$AKM_EXTRACT_NO_WORK_REQUIRED_KEY";
    const baseHarness = makeFakeHarness([]);
    let observedSinceMs: number | undefined;
    let chatCalls = 0;
    const harness: SessionLogHarness = {
      ...baseHarness,
      listSessions: (input) => {
        observedSinceMs = input?.sinceMs;
        return [];
      },
    };
    const storageTreeBefore = snapshotTree(storage.root);

    try {
      const result = await withEnv({ AKM_EXTRACT_NO_WORK_REQUIRED_KEY: undefined }, () =>
        akmExtract({
          type: "claude",
          stashDir: stash,
          stateDbPath,
          config,
          harnesses: [harness],
          chat: async () => {
            chatCalls += 1;
            throw new Error("no-work discovery dispatched an LLM request");
          },
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.sessionsProcessed).toBe(0);
      expect(observedSinceMs).toBe(watermark);
      expect(chatCalls).toBe(0);
      expect(snapshotTree(storage.root)).toEqual(storageTreeBefore);
    } finally {
      stateDb.close();
    }
  });

  function configWithStrategy(stashDir: string, processOverride: Record<string, unknown>): AkmConfig {
    return {
      configVersion: "0.9.0",
      semanticSearchMode: "auto",
      bundles: { stash: { path: stashDir, writable: true } },
      defaultBundle: "stash",
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

  test("standalone planning preserves an explicit unbounded timeout", () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, { timeoutMs: null });
    const plan = resolveStandaloneExtractPlan(config, { strategy: "extract" });

    expect(plan.timeoutMs).toBeNull();
    expect(plan.runner?.timeoutMs).toBeNull();
  });

  test("an unset symbolic credential does not block default-discovery dry-run planning with no dispatch or writes", async () => {
    const stash = storage.stashDir;
    const config = configWithStrategy(stash, {});
    const engine = config.engines?.["extract-special"];
    if (engine?.kind !== "llm") throw new Error("fixture must use an LLM engine");
    engine.apiKey = "$EXTRACT_REQUIRED_API_KEY";
    const stateDbPath = getStateDbPath();
    const storageTreeBefore = snapshotTree(storage.root);
    let chatCalls = 0;

    await withEnv({ EXTRACT_REQUIRED_API_KEY: undefined }, async () => {
      const plan = resolveStandaloneExtractPlan(config, { engine: "extract-special" });
      expect(plan.runner?.credential).toEqual({ names: ["EXTRACT_REQUIRED_API_KEY"], required: true });
      expect(plan.runner?.connection.apiKey).toBeUndefined();

      const result = await akmExtract({
        type: "claude",
        dryRun: true,
        stashDir: stash,
        config,
        resolvedPlan: plan,
        harnesses: [makeFakeHarness([])],
        chat: async () => {
          chatCalls += 1;
          throw new Error("dry-run with no candidates dispatched an LLM request");
        },
      });
      expect(result.ok).toBe(true);
      expect(result.sessionsProcessed).toBe(0);
      expect(chatCalls).toBe(0);
      expect(fs.existsSync(stateDbPath)).toBe(false);
      expect(fs.existsSync(`${stateDbPath}-wal`)).toBe(false);
      expect(fs.existsSync(`${stateDbPath}-shm`)).toBe(false);
      expect(snapshotTree(storage.root)).toEqual(storageTreeBefore);
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
      // minScore 2 (the default). This freeze test only needs the session to
      // clear triage so the frozen `process-model` is exercised on the LLM call;
      // it does not assert the threshold value. The shared `fakeSession` scores
      // 2.0 on the kept toolDensity/editCommit/markers sub-scores — it cleared a
      // minScore-3 bar only via the #641 proceduralAwareFloor, deleted in WI-7.3.
      triage: { enabled: true, minScore: 2 },
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
    expect(Object.isFrozen(plan.process.triage)).toBe(true);
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
      if (process.triage) process.triage.enabled = false;
    }

    let receivedModel = "";
    await akmExtract({
      type: "claude",
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
              name: "frozen-triage",
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
    expect(plan.process.triage?.enabled).toBe(true);
    const proposal = listProposals(stash, { status: "pending" }).find(
      (item) => item.ref === durableItemRef(stash, "memory", "frozen-triage"),
    );
    expect(proposal).toBeDefined();
  });

  test("a resolved null runner never falls back to live config at the extract leaf", async () => {
    const stash = makeStashDir();
    const config = configWithStrategy(stash, {});
    await expect(
      akmExtract({
        type: "claude",
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
      type: "claude",
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
      type: "claude",
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
        type: "claude",
        sessionId: "ses_bad_mode",
        stashDir: stash,
        config,
        harnesses: [makeFakeHarness([session])],
        chat: async () => JSON.stringify({ candidates: [] }),
      }),
    ).rejects.toThrow(/no llm engine configured for extract/i);
  });

  test("honors process timeoutMs override", async () => {
    const stash = makeStashDir();
    const session = fakeSession("ses_to", Date.now() - 60_000);
    let receivedTimeout = 0;
    await akmExtract({
      type: "claude",
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
      type: "claude",
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
      type: "claude",
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
        harness: "claude",
        sessionId: id,
        filePath: `/tmp/fake/${id}.jsonl`,
        startedAt: endedAt - 3600_000,
        endedAt,
      },
      events: texts.map((text, i) => ({
        harness: "claude",
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
      type: "claude",
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
        harness: "claude",
        sessionId: "ses_budget",
        filePath: "/tmp/fake/ses_budget.jsonl",
        startedAt: Date.now() - 3600_000,
        endedAt: Date.now(),
      },
      events: Array.from({ length: 20 }, (_, i) => ({
        harness: "claude",
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
      type: "claude",
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
      type: "claude",
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
