/**
 * Tests for the Aider CLI harness adapter (P2, plan §"The adapter contract" /
 * §"Capability matrix" / §"Structured-output normalization", tier "none"):
 *   - harnesses/aider/agent-builder.ts    — headless argv construction
 *   - harnesses/aider/result-extractor.ts — stdout → { text, sessionId? }
 *
 * The builder/extractor are exercised directly (they are NOT registered in
 * builders.ts / harnesses/index.ts yet — wiring is a follow-up integration
 * task). No real binaries are spawned; extractor fixtures are representative
 * captures of aider's documented plain-text terminal output (aider has no
 * structured output mode at all).
 */
import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../src/integrations/agent/spawn";
import { AIDER_PLATFORM, aiderBuilder } from "../../src/integrations/harnesses/aider/agent-builder";
import { aiderResultExtractor } from "../../src/integrations/harnesses/aider/result-extractor";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAiderProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "aider",
    bin: "aider",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH"],
    parseOutput: "text",
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    ok: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 42,
    ...overrides,
  };
}

/** The trailing `--message=<payload>` argument's payload part. */
function messagePayload(argv: readonly string[]): string {
  const last = argv[argv.length - 1] as string;
  expect(last).toStartWith("--message=");
  return last.slice("--message=".length);
}

/** A representative aider banner + status capture wrapped around a reply. */
function aiderCapture(reply: string): string {
  return [
    "aider v0.85.1",
    "Main model: claude-sonnet-4-6 with diff edit format",
    "Weak model: claude-haiku-4-5",
    "Git repo: .git with 143 files",
    "Repo-map: using 4096 tokens, auto refresh",
    "────────────────────────────────────────",
    reply,
    "Tokens: 4.2k sent, 310 received. Cost: $0.02 message, $0.02 session.",
  ].join("\n");
}

// ── Builder — plain prompt ────────────────────────────────────────────────────

describe("aiderBuilder — plain prompt", () => {
  test("argv = [aider, --yes-always, --no-pretty, --message=<p>] (matrix headless shape)", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["aider", "--yes-always", "--no-pretty", "--message=do work"]);
  });

  test("platform id is 'aider'", () => {
    expect(aiderBuilder.platform).toBe("aider");
    expect(AIDER_PLATFORM).toBe("aider");
  });

  test("profile.args are preserved ahead of builder flags", () => {
    const cmd = aiderBuilder.build(makeAiderProfile({ args: ["--no-git"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["aider", "--no-git", "--yes-always", "--no-pretty", "--message=go"]);
  });

  test("systemPrompt is folded into the message payload (no system-prompt flag exists)", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "do work", systemPrompt: "You are terse." });
    expect(messagePayload(cmd.argv)).toBe("You are terse.\n\ndo work");
    expect((cmd.argv as string[]).includes("--system-prompt")).toBe(false);
  });

  test("dash-leading prompt stays glued to --message= and cannot become a flag", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "--not-a-flag actually prose" });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 1]).toBe("--message=--not-a-flag actually prose");
    // No bare argv element starts the payload as its own token.
    expect(argv.includes("--not-a-flag actually prose")).toBe(false);
  });

  test("tool policy is deliberately dropped (no allowlist flags invented)", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go", tools: ["read", "shell"] });
    expect(cmd.argv).toEqual(["aider", "--yes-always", "--no-pretty", "--message=go"]);
  });
});

// ── Builder — model alias resolution ─────────────────────────────────────────

describe("aiderBuilder — model resolution via resolveModel('aider')", () => {
  test("profile.modelAliases resolves a custom alias for the aider platform", () => {
    const profile = makeAiderProfile({ modelAliases: { fast: "gpt-5-mini" } });
    const cmd = aiderBuilder.build(profile, { prompt: "go", model: "fast" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5-mini");
  });

  test("globalModelAliases aider column wins over '*' fallback", () => {
    const profile = makeAiderProfile({
      globalModelAliases: { deep: { aider: "claude-sonnet-4-6", "*": "generic-deep" } },
    });
    const cmd = aiderBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  test("globalModelAliases '*' fallback applies when no aider column exists", () => {
    const profile = makeAiderProfile({
      globalModelAliases: { deep: { "*": "generic-deep" } },
    });
    const cmd = aiderBuilder.build(profile, { prompt: "go", model: "deep" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("generic-deep");
  });

  test("builtin alias without an aider column passes through verbatim (user aliases own aider ids)", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go", model: "sonnet" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("sonnet");
  });

  test("exact model id passes through verbatim", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go", model: "gpt-5" });
    const argv = cmd.argv as string[];
    expect(argv[argv.indexOf("--model") + 1]).toBe("gpt-5");
  });

  test("no model → no --model flag", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });

  test("--model precedes the headless flags and the message payload", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go", model: "gpt-5" });
    expect(cmd.argv).toEqual(["aider", "--model", "gpt-5", "--yes-always", "--no-pretty", "--message=go"]);
  });
});

// ── Builder — schema (prompt-injected; tier "none") ──────────────────────────

describe("aiderBuilder — schema injection (no structured output mode)", () => {
  const schema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };

  test("schema directive is appended to the message payload", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "judge it", schema });
    const payload = messagePayload(cmd.argv);
    expect(payload).toStartWith("judge it");
    expect(payload).toContain("Respond with ONLY a JSON value matching this JSON Schema (no prose, no code fences):");
    expect(payload).toContain(JSON.stringify(schema));
  });

  test("no native schema/json flags leak into argv (aider has none)", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "judge it", schema });
    const argv = cmd.argv as string[];
    expect(argv.includes("--output-schema")).toBe(false);
    expect(argv.includes("--json")).toBe(false);
    expect(argv.includes("--mode")).toBe(false);
  });

  test("systemPrompt + schema compose in order: system, task, directive", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "judge it", systemPrompt: "Be strict.", schema });
    const payload = messagePayload(cmd.argv);
    const sysIdx = payload.indexOf("Be strict.");
    const taskIdx = payload.indexOf("judge it");
    const directiveIdx = payload.indexOf("Respond with ONLY a JSON value");
    expect(sysIdx).toBe(0);
    expect(taskIdx).toBeGreaterThan(sysIdx);
    expect(directiveIdx).toBeGreaterThan(taskIdx);
  });

  test("no schema → payload is exactly the prompt", () => {
    const cmd = aiderBuilder.build(makeAiderProfile(), { prompt: "go" });
    expect(messagePayload(cmd.argv)).toBe("go");
  });
});

// ── Builder — injection guards ────────────────────────────────────────────────

describe("aiderBuilder — assertNotFlag guards", () => {
  test("model starting with '--' throws", () => {
    expect(() => aiderBuilder.build(makeAiderProfile(), { prompt: "go", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test("systemPrompt starting with '--' throws", () => {
    expect(() => aiderBuilder.build(makeAiderProfile(), { prompt: "go", systemPrompt: "--inject" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("valid values do not throw", () => {
    expect(() =>
      aiderBuilder.build(makeAiderProfile(), { prompt: "go", model: "gpt-5", systemPrompt: "Be helpful." }),
    ).not.toThrow();
  });
});

// ── Extractor — representative aider captures ────────────────────────────────

describe("aiderResultExtractor — banner/status/footer stripping", () => {
  test("full capture: banner, separator, and usage footer are stripped; reply survives", () => {
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture("The bug is in parse().") }));
    expect(extraction).toEqual({ text: "The bug is in parse()." });
  });

  test("multi-line reply is preserved intact between announcements", () => {
    const reply = "Line one of the answer.\n\nLine two after a blank line.";
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture(reply) }));
    expect(extraction.text).toBe(reply);
  });

  test("edit/commit/undo notices after the reply are stripped", () => {
    const stdout = [
      "aider v0.85.1",
      "Main model: gpt-5 with diff edit format",
      "Done — I renamed the helper as requested.",
      "Applied edit to src/foo.py",
      "Commit a1b2c3d refactor: rename helper",
      "You can use /undo to undo and discard each aider commit.",
    ].join("\n");
    const extraction = aiderResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "Done — I renamed the helper as requested." });
  });

  test("chat-history and file-add notices are stripped", () => {
    const stdout = [
      "Restored previous conversation history.",
      "Added src/foo.py to the chat.",
      'Use /help <question> for help, run "aider --help" to see cmd line args',
      "Here is my analysis of foo.py.",
    ].join("\n");
    const extraction = aiderResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "Here is my analysis of foo.py." });
  });

  test("embedded-JSON reply survives stripping for the downstream schema tier", () => {
    const json = '{"verdict":"pass","confidence":0.9}';
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture(json) }));
    expect(extraction.text).toBe(json);
    expect(JSON.parse(extraction.text)).toEqual({ verdict: "pass", confidence: 0.9 });
  });

  test("reply lines that merely mention noise phrases mid-line are NOT stripped (anchored prefixes only)", () => {
    const reply = "See how aider v-strings and the Git repo: label are parsed in render().";
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture(reply) }));
    expect(extraction.text).toBe(reply);
  });

  test("ANSI escape codes are stripped defensively", () => {
    const esc = String.fromCharCode(27);
    const stdout = `${esc}[1maider v0.85.1${esc}[0m\n${esc}[32mAll tests pass.${esc}[0m`;
    const extraction = aiderResultExtractor(makeRunResult({ stdout }));
    expect(extraction).toEqual({ text: "All tests pass." });
  });
});

// ── Extractor — fallbacks + session semantics ────────────────────────────────

describe("aiderResultExtractor — fallbacks and session semantics", () => {
  test("plain reply with no announcements passes through trimmed", () => {
    const extraction = aiderResultExtractor(makeRunResult({ stdout: "  just some prose \n" }));
    expect(extraction).toEqual({ text: "just some prose" });
  });

  test("empty stdout yields empty text", () => {
    const extraction = aiderResultExtractor(makeRunResult({ stdout: "   \n " }));
    expect(extraction).toEqual({ text: "" });
  });

  test("all-noise stdout falls back to full trimmed stdout (never eats everything)", () => {
    const stdout = ["aider v0.85.1", "Main model: gpt-5 with diff edit format", "Git repo: .git with 3 files"].join(
      "\n",
    );
    const extraction = aiderResultExtractor(makeRunResult({ stdout }));
    expect(extraction.text).toBe(stdout);
  });

  test("no session model: output never supplies a sessionId", () => {
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture("done") }));
    expect(extraction.sessionId).toBeUndefined();
  });

  test("a spawn-layer sessionId passes through unchanged", () => {
    const extraction = aiderResultExtractor(makeRunResult({ stdout: aiderCapture("done"), sessionId: "spawn-sess" }));
    expect(extraction).toEqual({ text: "done", sessionId: "spawn-sess" });
  });
});
