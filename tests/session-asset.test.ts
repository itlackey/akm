// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the `session` asset type (#561):
 *   - the type is registered through the single-source-of-truth registry and
 *     therefore appears in the asset-type union, the renderer/action maps, and
 *     the ref grammar;
 *   - the pure session-asset builders (frontmatter, access instructions,
 *     duration gate, content assembly, summary parsing) behave as specified.
 *
 * No filesystem / LLM / network — all functions under test are pure except
 * `writeSessionAsset`, which is covered in tests/session-indexing.test.ts.
 */

import { describe, expect, test } from "bun:test";
import {
  buildSessionAccessInstructions,
  buildSessionAssetContent,
  buildSessionAssetName,
  parseSessionSummary,
  resolveSessionAssetPath,
  sessionMeetsDurationGate,
} from "../src/commands/improve/session-asset";
import { ACTION_BUILDERS, TYPE_TO_RENDERER } from "../src/core/asset/asset-registry";
import { getAssetTypes, TYPE_DIRS } from "../src/core/asset/asset-spec";
import { parseFrontmatter } from "../src/core/asset/frontmatter";
import { ASSET_TYPE_SET, ASSET_TYPES, isAssetType } from "../src/core/common";
import type { SessionData } from "../src/integrations/session-logs/types";

function fakeSession(overrides: Partial<SessionData["ref"]> = {}): SessionData {
  const startedAt = Date.parse("2026-06-07T14:22:00Z");
  const endedAt = Date.parse("2026-06-07T17:05:00Z");
  return {
    ref: {
      harness: "claude-code",
      sessionId: "ca894f15-1234-5678-9abc-def012345678",
      filePath: "/home/u/.claude/projects/-p/ca894f15.jsonl",
      startedAt,
      endedAt,
      projectHint: "itlackey/akm",
      title: "node compat",
      ...overrides,
    },
    events: [
      { harness: "claude-code", text: "user: investigate bun sqlite", role: "user" },
      { harness: "claude-code", text: "agent: designed runtime boundary", role: "assistant" },
    ],
    inlineRefs: [],
  };
}

describe("session asset type is registered via the single source of truth", () => {
  test("session appears in the registry key set and the derived union", () => {
    expect(getAssetTypes()).toContain("session");
    expect(ASSET_TYPES).toContain("session");
    expect(ASSET_TYPE_SET.has("session" as (typeof ASSET_TYPES)[number])).toBe(true);
    // Runtime type guard accepts it.
    expect(isAssetType("session")).toBe(true);
  });

  test("session has a stash dir, renderer, and action builder", () => {
    expect(TYPE_DIRS.session).toBe("sessions");
    expect(TYPE_TO_RENDERER.session).toBe("session-md");
    expect(typeof ACTION_BUILDERS.session).toBe("function");
    expect(ACTION_BUILDERS.session?.("session:claude/x")).toMatch(/akm show session:claude\/x/);
  });

  test("session resolves under sessions/<harness>/<id>.md", () => {
    const p = resolveSessionAssetPath("/stash", "claude-code", "abc123");
    expect(p.replace(/\\/g, "/")).toBe("/stash/sessions/claude/abc123.md");
  });
});

describe("buildSessionAccessInstructions", () => {
  test("claude harness gets cat + jq message-parse instructions", () => {
    const access = buildSessionAccessInstructions("claude-code", "/x/y.jsonl");
    expect(access).toContain("cat /x/y.jsonl");
    expect(access).toContain("jq");
    expect(access).toContain("/x/y.jsonl");
  });
  test("opencode harness gets cat + jq inspect instructions", () => {
    const access = buildSessionAccessInstructions("opencode", "/x/y.json");
    expect(access).toContain("cat /x/y.json");
    expect(access).toContain("jq");
  });
  test("unknown harness falls back to a generic cat hint", () => {
    const access = buildSessionAccessInstructions("future-harness", "/x/y.log");
    expect(access).toBe("Read with: cat /x/y.log");
  });
});

describe("buildSessionAssetName", () => {
  test("slug is <harness>-session-<date>-<shortId>", () => {
    const name = buildSessionAssetName("claude-code", "ca894f15-rest", Date.parse("2026-06-07T14:22:00Z"));
    expect(name).toBe("claude-session-2026-06-07-ca894f15");
  });
  test("missing started_at degrades to unknown-date", () => {
    const name = buildSessionAssetName("opencode", "deadbeefcafe", undefined);
    expect(name).toBe("opencode-session-unknown-date-deadbeef");
  });
});

describe("sessionMeetsDurationGate", () => {
  test("passes when duration >= threshold", () => {
    expect(sessionMeetsDurationGate(fakeSession(), 5)).toBe(true);
  });
  test("fails when duration below threshold", () => {
    const started = Date.parse("2026-06-07T14:22:00Z");
    const short = fakeSession({ startedAt: started, endedAt: started + 60_000 }); // 1 min
    expect(sessionMeetsDurationGate(short, 5)).toBe(false);
  });
  test("threshold 0 disables the gate", () => {
    const started = Date.parse("2026-06-07T14:22:00Z");
    const short = fakeSession({ startedAt: started, endedAt: started + 1000 });
    expect(sessionMeetsDurationGate(short, 0)).toBe(true);
  });
  test("missing timestamps fail open (indexed)", () => {
    const noTimes = fakeSession({ startedAt: undefined, endedAt: undefined });
    expect(sessionMeetsDurationGate(noTimes, 5)).toBe(true);
  });
});

describe("buildSessionAssetContent", () => {
  test("assembles frontmatter (name/type/harness/log_path/access/tags) + Summary + Key topics", () => {
    const { name, frontmatter, content } = buildSessionAssetContent(fakeSession(), {
      summary: "Investigated Bun/Node compatibility. Designed a runtime boundary abstraction.",
      keyTopics: ["src/storage/database.ts", "issue #560"],
      tags: ["node-compat"],
    });

    expect(name).toBe("claude-session-2026-06-07-ca894f15");
    expect(frontmatter.type).toBe("session");
    expect(frontmatter.harness).toBe("claude-code");
    expect(frontmatter.session_id).toBe("ca894f15-1234-5678-9abc-def012345678");
    expect(frontmatter.log_path).toBe("/home/u/.claude/projects/-p/ca894f15.jsonl");
    expect(frontmatter.project).toBe("itlackey/akm");
    expect(frontmatter.started_at).toBe("2026-06-07T14:22:00.000Z");
    expect(frontmatter.ended_at).toBe("2026-06-07T17:05:00.000Z");
    expect(frontmatter.access).toContain("jq");
    expect(frontmatter.tags).toEqual(expect.arrayContaining(["session", "claude", "node-compat"]));

    expect(content).toContain("## Summary");
    expect(content).toContain("Designed a runtime boundary abstraction.");
    expect(content).toContain("## Key topics");
    expect(content).toContain("- src/storage/database.ts");
    expect(content).toContain("- issue #560");

    // Round-trips through the frontmatter parser with the durable correlation key intact.
    const parsed = parseFrontmatter(content);
    expect(parsed.data.type).toBe("session");
    expect(parsed.data.log_path).toBe("/home/u/.claude/projects/-p/ca894f15.jsonl");
    expect(parsed.data.access).toContain("jq");
  });

  test("empty key topics renders a sentinel bullet", () => {
    const { content } = buildSessionAssetContent(fakeSession(), { summary: "Did a thing.", keyTopics: [] });
    expect(content).toContain("- (none extracted)");
  });
});

describe("parseSessionSummary", () => {
  test("parses a clean JSON object", () => {
    const r = parseSessionSummary(JSON.stringify({ summary: "Did work.", key_topics: ["a", "b"], tags: ["t"] }));
    expect(r?.summary).toBe("Did work.");
    expect(r?.keyTopics).toEqual(["a", "b"]);
    expect(r?.tags).toEqual(["t"]);
  });
  test("tolerates prose around the JSON", () => {
    const r = parseSessionSummary('Here you go:\n{"summary":"S","key_topics":[]}\nThanks!');
    expect(r?.summary).toBe("S");
  });
  test("returns undefined on empty / unparseable / missing-summary input", () => {
    expect(parseSessionSummary("")).toBeUndefined();
    expect(parseSessionSummary("not json at all")).toBeUndefined();
    expect(parseSessionSummary(JSON.stringify({ key_topics: ["a"] }))).toBeUndefined();
  });
});
