/**
 * Tests for the staleness-detection pass (Phase 4A,
 * `.plans/0.8.0/self-improvement-enhancements-plan.md` lines 132-145).
 *
 * The LLM client is mocked via `mock.module` so no network call is ever
 * issued. The mock honours a mutable `validator` callback so each test can
 * deterministically shape the response.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AkmConfig } from "../../src/core/config";
import { parseFrontmatter } from "../../src/core/frontmatter";
import type { SearchSource } from "../../src/indexer/search-source";

// ── Module-level LLM stub ───────────────────────────────────────────────────
//
// `mock.module` must run before the module under test is imported. We spread
// the real `client` module exports so unrelated callers (e.g. memory-inference
// importing `parseEmbeddedJsonResponse`) keep working, and override only the
// `chatCompletion` function with our deterministic validator.

let validator: (userContent: string) => string = () => "NO";
let validatorCalls = 0;
const realClient = await import("../../src/llm/client");
mock.module("../../src/llm/client", () => ({
  ...realClient,
  chatCompletion: async (_conn: unknown, messages: Array<{ role: string; content: string }>): Promise<string> => {
    validatorCalls += 1;
    const user = messages.find((m) => m.role === "user");
    return validator(user?.content ?? "");
  },
}));

const { runStalenessDetectionPass, parseStalenessResponse } = await import("../../src/indexer/staleness-detect");

// ── Test fixtures ───────────────────────────────────────────────────────────

let tmpStash = "";

beforeEach(() => {
  tmpStash = fs.mkdtempSync(path.join(os.tmpdir(), "akm-staleness-"));
  fs.mkdirSync(path.join(tmpStash, "memories"), { recursive: true });
  validator = () => "NO";
  validatorCalls = 0;
});

afterEach(() => {
  if (tmpStash) {
    fs.rmSync(tmpStash, { recursive: true, force: true });
    tmpStash = "";
  }
});

function writeMemory(name: string, frontmatter: Record<string, unknown>, body: string): string {
  const fmLines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    fmLines.push(`${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
  fmLines.push("---");
  const content = `${fmLines.join("\n")}\n\n${body}\n`;
  const filePath = path.join(tmpStash, "memories", `${name}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function setOldMtime(filePath: string, daysAgo: number): void {
  const ms = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const sec = ms / 1000;
  fs.utimesSync(filePath, sec, sec);
}

function sources(): SearchSource[] {
  return [{ path: tmpStash, writable: true }];
}

function enabledConfig(opts: { thresholdDays?: number } = {}): AkmConfig {
  return {
    semanticSearchMode: "auto",
    defaults: { llm: "default" },
    profiles: {
      llm: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "validator",
        },
      },
    },
    index: {
      stalenessDetection: {
        enabled: true,
        ...(opts.thresholdDays !== undefined ? { thresholdDays: opts.thresholdDays } : {}),
      },
    },
  };
}

function disabledConfig(): AkmConfig {
  return {
    semanticSearchMode: "auto",
    defaults: { llm: "default" },
    profiles: {
      llm: {
        default: {
          endpoint: "http://localhost:11434/v1/chat/completions",
          model: "validator",
        },
      },
    },
  } as AkmConfig;
}

// ── parseStalenessResponse (pure parser) ────────────────────────────────────

describe("parseStalenessResponse", () => {
  test("NO returns confirmed", () => {
    expect(parseStalenessResponse("NO")).toEqual({ decision: "confirmed" });
    expect(parseStalenessResponse("no\n")).toEqual({ decision: "confirmed" });
  });

  test("YES + SUPERSEDED_BY returns deprecated", () => {
    expect(parseStalenessResponse("YES\nSUPERSEDED_BY: memory:new-fact")).toEqual({
      decision: "deprecated",
      supersededBy: "memory:new-fact",
    });
  });

  test("YES without SUPERSEDED_BY is a parse error", () => {
    expect(parseStalenessResponse("YES")).toBeUndefined();
    expect(parseStalenessResponse("YES\n\n")).toBeUndefined();
  });

  test("garbage response returns undefined", () => {
    expect(parseStalenessResponse("maybe")).toBeUndefined();
    expect(parseStalenessResponse("")).toBeUndefined();
    expect(parseStalenessResponse("YES, the memory is stale.")).toBeUndefined();
  });
});

// ── Feature gate ────────────────────────────────────────────────────────────

describe("runStalenessDetectionPass — feature gate", () => {
  test("returns no-op when feature is disabled (default)", async () => {
    const filePath = writeMemory("old-fact", { description: "old" }, "Old body.");
    setOldMtime(filePath, 365);
    const result = await runStalenessDetectionPass({ config: disabledConfig(), sources: sources() });
    expect(result).toMatchObject({
      considered: 0,
      deprecated: 0,
      confirmed: 0,
      skipped: 0,
    });
    expect(validatorCalls).toBe(0);
    // Memory frontmatter must be unchanged.
    const fm = parseFrontmatter(fs.readFileSync(filePath, "utf8"));
    expect(fm.data.lastConfirmedAt).toBeUndefined();
    expect(fm.data.beliefState).toBeUndefined();
  });
});

// ── Threshold filtering ─────────────────────────────────────────────────────

describe("runStalenessDetectionPass — threshold", () => {
  test("recent memory (lastConfirmedAt within thresholdDays) is not considered", async () => {
    const filePath = writeMemory(
      "fresh",
      { description: "fresh", lastConfirmedAt: new Date().toISOString() },
      "Fresh body.",
    );
    setOldMtime(filePath, 200);
    validator = () => "YES\nSUPERSEDED_BY: memory:other";

    const result = await runStalenessDetectionPass({
      config: enabledConfig({ thresholdDays: 90 }),
      sources: sources(),
    });
    expect(result.considered).toBe(0);
    expect(validatorCalls).toBe(0);
  });

  test("excluded belief states are never considered", async () => {
    const f1 = writeMemory("dep", { description: "dep", beliefState: "deprecated" }, "Body");
    const f2 = writeMemory("ctr", { description: "ctr", beliefState: "contradicted" }, "Body");
    const f3 = writeMemory("arc", { description: "arc", beliefState: "archived" }, "Body");
    for (const p of [f1, f2, f3]) setOldMtime(p, 365);

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.considered).toBe(0);
    expect(validatorCalls).toBe(0);
  });
});

// ── Deprecation path ────────────────────────────────────────────────────────

describe("runStalenessDetectionPass — deprecation", () => {
  test("YES response with a valid superseding ref deprecates the candidate", async () => {
    const stale = writeMemory("stale-fact", { description: "stale" }, "Old way of doing X.");
    setOldMtime(stale, 200);
    // Newer memory to act as the superseder. Must be more recent than the
    // candidate so the prompt builder includes it.
    const fresh = writeMemory("new-fact", { description: "new" }, "New way of doing X.");
    setOldMtime(fresh, 1);

    validator = () => "YES\nSUPERSEDED_BY: memory:new-fact";

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.considered).toBe(1);
    expect(result.deprecated).toBe(1);
    expect(result.confirmed).toBe(0);
    expect(validatorCalls).toBe(1);

    const fm = parseFrontmatter(fs.readFileSync(stale, "utf8"));
    expect(fm.data.beliefState).toBe("deprecated");
    expect(fm.data.supersededBy).toEqual(["memory:new-fact"]);
    expect(typeof fm.data.lastConfirmedAt).toBe("string");
    // Description must remain intact — strict additive write.
    expect(fm.data.description).toBe("stale");
  });
});

// ── Confirmation path ───────────────────────────────────────────────────────

describe("runStalenessDetectionPass — confirmation", () => {
  test("NO response only refreshes lastConfirmedAt; nothing else changes", async () => {
    const stale = writeMemory("still-good", { description: "still good", tags: ["a", "b"] }, "Body.");
    setOldMtime(stale, 200);
    const sibling = writeMemory("sibling", { description: "sibling" }, "Body.");
    setOldMtime(sibling, 1);

    validator = () => "NO";

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.considered).toBe(1);
    expect(result.deprecated).toBe(0);
    expect(result.confirmed).toBe(1);

    const fm = parseFrontmatter(fs.readFileSync(stale, "utf8"));
    expect(fm.data.beliefState).toBeUndefined();
    expect(fm.data.supersededBy).toBeUndefined();
    expect(typeof fm.data.lastConfirmedAt).toBe("string");
    // Description + tags preserved verbatim.
    expect(fm.data.description).toBe("still good");
    expect(fm.data.tags).toEqual(["a", "b"]);
  });
});

// ── Superseding ref must exist ──────────────────────────────────────────────

describe("runStalenessDetectionPass — supersededBy validation", () => {
  test("non-existent supersededBy ref falls through to confirm + warning", async () => {
    const stale = writeMemory("stale", { description: "stale" }, "Body.");
    setOldMtime(stale, 200);
    const fresh = writeMemory("fresh", { description: "fresh" }, "Body.");
    setOldMtime(fresh, 1);

    validator = () => "YES\nSUPERSEDED_BY: memory:does-not-exist";

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.deprecated).toBe(0);
    expect(result.confirmed).toBe(1);
    expect(result.warnings.some((w) => w.includes("memory:does-not-exist"))).toBe(true);

    const fm = parseFrontmatter(fs.readFileSync(stale, "utf8"));
    // Must NOT be deprecated — only refreshed.
    expect(fm.data.beliefState).toBeUndefined();
    expect(fm.data.supersededBy).toBeUndefined();
    expect(typeof fm.data.lastConfirmedAt).toBe("string");
  });
});

// ── Parse error path ────────────────────────────────────────────────────────

describe("runStalenessDetectionPass — malformed responses", () => {
  test("garbage response increments skipped without touching the file", async () => {
    const stale = writeMemory("stale", { description: "stale" }, "Body.");
    setOldMtime(stale, 200);
    const fresh = writeMemory("fresh", { description: "fresh" }, "Body.");
    setOldMtime(fresh, 1);

    validator = () => "I am not sure.";

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.considered).toBe(1);
    expect(result.deprecated).toBe(0);
    expect(result.confirmed).toBe(0);
    expect(result.skipped).toBe(1);

    const fm = parseFrontmatter(fs.readFileSync(stale, "utf8"));
    expect(fm.data.lastConfirmedAt).toBeUndefined();
    expect(fm.data.beliefState).toBeUndefined();
  });
});

// ── No similar memories → confirm without LLM ──────────────────────────────

describe("runStalenessDetectionPass — empty corpus", () => {
  test("no more-recent similar memories → confirmed without LLM call", async () => {
    const stale = writeMemory("alone", { description: "alone" }, "Solo body with unique tokens xyzzy.");
    setOldMtime(stale, 200);

    validator = () => {
      throw new Error("must not be called when there is nothing to compare against");
    };

    const result = await runStalenessDetectionPass({ config: enabledConfig(), sources: sources() });
    expect(result.considered).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(validatorCalls).toBe(0);
  });
});
