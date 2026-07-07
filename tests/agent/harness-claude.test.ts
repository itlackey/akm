// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Tests for the Claude Code harness adapter's structured-output path (Codex
 * round-3 finding A):
 *   - harnesses/claude/agent-builder.ts    — claudeBuilder: `--output-format
 *     json` + schema directive when a schema is present; byte-identical
 *     plain-prompt argv otherwise.
 *   - harnesses/claude/result-extractor.ts — unwrap the `claude -p
 *     --output-format json` result envelope; plain-text passthrough otherwise.
 *
 * No real `claude` binary is spawned.
 */
import { describe, expect, test } from "bun:test";
import type { AgentDispatchRequest } from "../../src/integrations/agent/builder-shared";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { claudeBuilder } from "../../src/integrations/harnesses/claude/agent-builder";
import { claudeResultExtractor } from "../../src/integrations/harnesses/claude/result-extractor";

function makeClaudeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "claude",
    bin: "claude",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH", "ANTHROPIC_API_KEY"],
    parseOutput: "text",
    ...overrides,
  };
}

function makeRunResult(stdout: string, overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 42, ...overrides };
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
};

describe("claudeBuilder — schemaless dispatch (unchanged)", () => {
  test("plain prompt: no --output-format, argv ends with --print -- <prompt>", () => {
    const cmd = claudeBuilder.build(makeClaudeProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["claude", "--print", "--", "do work"]);
    expect(cmd.argv).not.toContain("--output-format");
  });

  test("system prompt stays a --system-prompt flag; prompt is untouched", () => {
    const req: AgentDispatchRequest = { prompt: "do work", systemPrompt: "be terse" };
    const argv = claudeBuilder.build(makeClaudeProfile(), req).argv;
    expect(argv).toContain("--system-prompt");
    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("be terse");
    // The positional prompt is the bare task prompt (no schema directive).
    expect(argv[argv.length - 1]).toBe("do work");
  });
});

describe("claudeBuilder — schema-bearing dispatch (native-json path)", () => {
  test("schema unit emits --output-format json and appends the schema directive", () => {
    const req: AgentDispatchRequest = { prompt: "classify it", schema: SCHEMA };
    const argv = claudeBuilder.build(makeClaudeProfile(), req).argv;
    const fmtIdx = argv.indexOf("--output-format");
    expect(fmtIdx).toBeGreaterThan(-1);
    expect(argv[fmtIdx + 1]).toBe("json");
    // The positional prompt carries the same schema directive the engine uses.
    const prompt = argv[argv.length - 1];
    expect(prompt).toContain("classify it");
    expect(prompt).toContain("Respond with ONLY a JSON value matching this JSON Schema");
    expect(prompt).toContain(JSON.stringify(SCHEMA));
  });

  test("--print and -- still frame the prompt with a schema present", () => {
    const argv = claudeBuilder.build(makeClaudeProfile(), { prompt: "p", schema: SCHEMA }).argv;
    expect(argv).toContain("--print");
    // -- immediately precedes the positional prompt.
    expect(argv[argv.length - 2]).toBe("--");
  });
});

describe("claudeResultExtractor — result envelope + plain text", () => {
  test("unwraps the --output-format json result envelope: result + session_id", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: '{"verdict":"pass"}',
      session_id: "sess-123",
      total_cost_usd: 0.01,
    });
    const extraction = claudeResultExtractor(makeRunResult(stdout));
    expect(extraction.text).toBe('{"verdict":"pass"}');
    expect(extraction.sessionId).toBe("sess-123");
  });

  test("plain-text stdout passes through verbatim (schemaless run)", () => {
    const extraction = claudeResultExtractor(makeRunResult("just some text\n"));
    expect(extraction.text).toBe("just some text\n");
    expect(extraction.sessionId).toBeUndefined();
  });

  test("a bare JSON answer with no envelope markers is NOT unwrapped (schema validator sees the whole object)", () => {
    const stdout = '{"verdict":"pass"}';
    const extraction = claudeResultExtractor(makeRunResult(stdout));
    expect(extraction.text).toBe(stdout);
  });

  test("falls back to the raw result's sessionId when the envelope carries none", () => {
    const extraction = claudeResultExtractor(makeRunResult("plain", { sessionId: "spawn-sess" }));
    expect(extraction.text).toBe("plain");
    expect(extraction.sessionId).toBe("spawn-sess");
  });
});
