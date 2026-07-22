/**
 * Tests for the OpenAI Codex harness adapter (P2, plan §"The adapter contract"
 * / §"Capability matrix" / §"Structured-output normalization"):
 *   - harnesses/codex/agent-builder.ts    — codexBuilder argv construction,
 *     native --output-schema temp file, codexResumeArgs
 *   - harnesses/codex/result-extractor.ts — JSONL (both dialects) / plain
 *     stdout normalization into { text, sessionId? }
 *
 * The adapter is intentionally NOT registered in HARNESS_REGISTRY /
 * BUILTIN_BUILDERS yet (a follow-up integration task wires it), so everything
 * here imports the modules directly. No real binaries are spawned.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentDispatchRequest } from "../../../src/integrations/agent/builder-shared";
import type { AgentProfile } from "../../../src/integrations/agent/profiles";
import type { AgentRunResult } from "../../../src/integrations/agent/spawn";
import {
  codexBuilder,
  codexResumeArgs,
  writeCodexOutputSchemaFile,
} from "../../../src/integrations/harnesses/codex/agent-builder";
import { codexResultExtractor } from "../../../src/integrations/harnesses/codex/result-extractor";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeCodexProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  // Mirrors the built-in `codex` / `codex-headless` profiles: bin "codex",
  // empty base args (the builder owns the `exec` subcommand).
  return {
    name: "codex",
    bin: "codex",
    args: [],
    stdio: "captured",
    envPassthrough: ["PATH", "OPENAI_API_KEY"],
    parseOutput: "text",
    ...overrides,
  };
}

function makeRunResult(stdout: string, overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { ok: true, exitCode: 0, stdout, stderr: "", durationMs: 42, ...overrides };
}

/** Extract the value following a flag in argv, asserting the flag is present. */
function flagValue(argv: readonly string[], flag: string): string {
  const idx = argv.indexOf(flag);
  expect(idx).toBeGreaterThan(-1);
  return argv[idx + 1] as string;
}

// ── codexBuilder — basic dispatch ─────────────────────────────────────────────

describe("codexBuilder — basic dispatch", () => {
  test("plain prompt: argv includes sandbox default then --json", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "do work" });
    expect(cmd.argv).toEqual(["codex", "exec", "--sandbox", "workspace-write", "--json", "--", "do work"]);
  });

  test("platform id is 'codex' (canonical harness id)", () => {
    expect(codexBuilder.platform).toBe("codex");
  });

  test("`exec` subcommand comes first and is not doubled when the profile pins it", () => {
    const cmd = codexBuilder.build(makeCodexProfile({ args: ["exec"] }), { prompt: "go" });
    expect(cmd.argv).toEqual(["codex", "exec", "--sandbox", "workspace-write", "--json", "--", "go"]);
  });

  test("extra profile args are kept after `exec`, before builder flags", () => {
    const cmd = codexBuilder.build(makeCodexProfile({ args: ["--skip-git-repo-check"] }), { prompt: "go" });
    expect(cmd.argv).toEqual([
      "codex",
      "exec",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--json",
      "--",
      "go",
    ]);
  });

  test("--json is always emitted (JSONL event stream is the extractor's input)", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "task" });
    expect((cmd.argv as string[]).includes("--json")).toBe(true);
  });

  test("prompt is preceded by the '--' end-of-options separator and is last", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "do work" });
    const argv = cmd.argv as string[];
    const sepIdx = argv.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(argv[sepIdx + 1]).toBe("do work");
    expect(argv[argv.length - 1]).toBe("do work");
  });

  test("systemPrompt is folded into the prompt (codex exec has no system-prompt flag)", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), {
      prompt: "do work",
      systemPrompt: "You are terse.",
    });
    const argv = cmd.argv as string[];
    expect(argv[argv.length - 1]).toBe("You are terse.\n\ndo work");
    expect(argv.includes("--system-prompt")).toBe(false);
  });

  test("tool policy is NOT emitted (codex governs tools via its own sandbox config)", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "do work", tools: "read,write" });
    const argv = cmd.argv as string[];
    expect(argv.includes("--allowedTools")).toBe(false);
    expect(argv.join(" ")).not.toContain("read,write");
  });

  test("sandbox flag is injected by default (codex exec defaults to read-only)", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go" });
    const argv = cmd.argv as string[];
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  test("profile-supplied --sandbox is preserved, not duplicated", () => {
    const cmd = codexBuilder.build(makeCodexProfile({ args: ["--sandbox", "danger-full-access"] }), { prompt: "go" });
    const argv = cmd.argv as string[];
    expect(argv.filter((a) => a === "--sandbox").length).toBe(1);
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    expect(argv.join(" ")).not.toContain("workspace-write");
  });

  test("short-form -s in profile args suppresses injection of long form", () => {
    const cmd = codexBuilder.build(makeCodexProfile({ args: ["-s", "workspace-write"] }), {
      prompt: "go",
    });
    const argv = cmd.argv as string[];
    expect(argv).not.toContain("--sandbox");
    expect(argv.filter((a) => a === "-s").length).toBe(1);
  });

  test("--ask-for-approval is NOT injected (only valid on interactive codex, not exec)", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go" });
    const argv = cmd.argv as string[];
    expect(argv).not.toContain("--ask-for-approval");
    expect(argv).not.toContain("-a");
  });
});

// ── codexBuilder — model resolution ───────────────────────────────────────────

describe("codexBuilder — model alias resolution (platform 'codex')", () => {
  test("exact model ID passes through verbatim", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go", model: "gpt-5-codex" });
    expect(flagValue(cmd.argv, "--model")).toBe("gpt-5-codex");
  });

  test("profile.modelAliases resolves a custom alias", () => {
    const profile = makeCodexProfile({ modelAliases: { fast: "o4-mini" } });
    const cmd = codexBuilder.build(profile, { prompt: "go", model: "fast" });
    expect(flagValue(cmd.argv, "--model")).toBe("o4-mini");
  });

  test("globalModelAliases codex column resolves a tier alias", () => {
    const profile = makeCodexProfile({
      globalModelAliases: { deep: { codex: "o3-pro", "*": "generic-deep" } },
    });
    const cmd = codexBuilder.build(profile, { prompt: "go", model: "deep" });
    expect(flagValue(cmd.argv, "--model")).toBe("o3-pro");
  });

  test("globalModelAliases '*' fallback applies when no codex column exists", () => {
    const profile = makeCodexProfile({ globalModelAliases: { deep: { "*": "generic-deep" } } });
    const cmd = codexBuilder.build(profile, { prompt: "go", model: "deep" });
    expect(flagValue(cmd.argv, "--model")).toBe("generic-deep");
  });

  test("profile.modelAliases beats globalModelAliases", () => {
    const profile = makeCodexProfile({
      modelAliases: { fast: "profile-wins" },
      globalModelAliases: { fast: { codex: "global-loses" } },
    });
    const cmd = codexBuilder.build(profile, { prompt: "go", model: "fast" });
    expect(flagValue(cmd.argv, "--model")).toBe("profile-wins");
  });

  test("builtin alias with no codex column passes through verbatim (resolveModel contract)", () => {
    // "opus" is a builtin alias but has no codex platform entry — resolveModel
    // returns the raw string; pinning this documents the current behaviour.
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go", model: "opus" });
    expect(flagValue(cmd.argv, "--model")).toBe("opus");
  });

  test("no model requested → no --model flag", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--model")).toBe(false);
  });
});

// ── codexBuilder — native schema (--output-schema) ────────────────────────────

describe("codexBuilder — native --output-schema temp file", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
    required: ["verdict"],
  };

  test("schema request emits --output-schema <file> whose content round-trips", () => {
    const req: AgentDispatchRequest = { prompt: "judge it", schema };
    const cmd = codexBuilder.build(makeCodexProfile(), req);
    const argv = cmd.argv as string[];
    const file = flagValue(argv, "--output-schema");
    try {
      expect(file.endsWith("output-schema.json")).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(schema);
      // Prompt still terminates argv after the separator.
      expect(argv[argv.length - 1]).toBe("judge it");
      const sepIdx = argv.indexOf("--");
      expect(sepIdx).toBeGreaterThan(argv.indexOf("--output-schema"));
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  test("each build writes a distinct file (concurrent fan-out units cannot collide)", () => {
    const a = flagValue(codexBuilder.build(makeCodexProfile(), { prompt: "x", schema }).argv, "--output-schema");
    const b = flagValue(codexBuilder.build(makeCodexProfile(), { prompt: "y", schema }).argv, "--output-schema");
    try {
      expect(a).not.toBe(b);
    } finally {
      rmSync(dirname(a), { recursive: true, force: true });
      rmSync(dirname(b), { recursive: true, force: true });
    }
  });

  test("no schema → no --output-schema flag", () => {
    const cmd = codexBuilder.build(makeCodexProfile(), { prompt: "go" });
    expect((cmd.argv as string[]).includes("--output-schema")).toBe(false);
  });

  test("writeCodexOutputSchemaFile returns an absolute path to valid JSON", () => {
    const file = writeCodexOutputSchemaFile(schema);
    try {
      expect(file.startsWith("/")).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(schema);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});

// ── codexBuilder — injection guards ───────────────────────────────────────────

describe("codexBuilder — argument injection guards", () => {
  test('model starting with "--" throws UsageError', () => {
    expect(() => codexBuilder.build(makeCodexProfile(), { prompt: "task", model: "--evil" })).toThrow(
      /model must not start with "--"/,
    );
  });

  test('systemPrompt starting with "--" throws UsageError', () => {
    expect(() => codexBuilder.build(makeCodexProfile(), { prompt: "task", systemPrompt: "--injected" })).toThrow(
      /systemPrompt must not start with "--"/,
    );
  });

  test("valid model and systemPrompt do not throw", () => {
    expect(() =>
      codexBuilder.build(makeCodexProfile(), {
        prompt: "task",
        model: "gpt-5-codex",
        systemPrompt: "Be careful.",
      }),
    ).not.toThrow();
  });
});

// ── codexResumeArgs ───────────────────────────────────────────────────────────

describe("codexResumeArgs — resume subcommand prefix", () => {
  test("returns [exec, resume, <id>]", () => {
    expect(codexResumeArgs("0195b2f3-session")).toEqual(["exec", "resume", "0195b2f3-session"]);
  });

  test('session id starting with "--" throws UsageError', () => {
    expect(() => codexResumeArgs("--evil")).toThrow(/sessionId must not start with "--"/);
  });
});

// ── codexResultExtractor — legacy JSONL protocol ──────────────────────────────

/** Representative capture of `codex exec --json` (legacy `msg`-envelope dialect). */
const LEGACY_JSONL = [
  `{"id":"0","msg":{"type":"session_configured","session_id":"c0dex-5e55-1d","model":"gpt-5-codex","history_log_id":1,"history_entry_count":0}}`,
  `{"id":"1","msg":{"type":"task_started"}}`,
  `{"id":"1","msg":{"type":"agent_reasoning","text":"Considering the request..."}}`,
  `{"id":"1","msg":{"type":"agent_message","message":"Working on it."}}`,
  `{"id":"1","msg":{"type":"agent_message","message":"{\\"verdict\\":\\"pass\\"}"}}`,
  `{"id":"1","msg":{"type":"token_count","input_tokens":812,"output_tokens":64}}`,
  `{"id":"1","msg":{"type":"task_complete","last_agent_message":"{\\"verdict\\":\\"pass\\"}"}}`,
].join("\n");

describe("codexResultExtractor — legacy JSONL dialect", () => {
  test("task_complete.last_agent_message wins as text; session id captured", () => {
    const out = codexResultExtractor(makeRunResult(LEGACY_JSONL));
    expect(out.text).toBe(`{"verdict":"pass"}`);
    expect(out.sessionId).toBe("c0dex-5e55-1d");
  });

  test("without task_complete, the LAST agent_message wins", () => {
    const stdout = [
      `{"id":"0","msg":{"type":"session_configured","session_id":"sess-42"}}`,
      `{"id":"1","msg":{"type":"agent_message","message":"first draft"}}`,
      `{"id":"1","msg":{"type":"agent_message","message":"final answer"}}`,
    ].join("\n");
    const out = codexResultExtractor(makeRunResult(stdout));
    expect(out.text).toBe("final answer");
    expect(out.sessionId).toBe("sess-42");
  });

  test("reasoning/token_count events never leak into text", () => {
    const out = codexResultExtractor(makeRunResult(LEGACY_JSONL));
    expect(out.text).not.toContain("Considering the request");
    expect(out.text).not.toContain("token");
  });
});

// ── codexResultExtractor — newer flat-event dialect ───────────────────────────

/** Representative capture of the newer experimental-json event dialect. */
const FLAT_JSONL = [
  `{"type":"thread.started","thread_id":"thread_66b1"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"Thinking..."}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","exit_code":0}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"All three tests pass."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":900,"output_tokens":80}}`,
].join("\n");

describe("codexResultExtractor — newer flat-event dialect", () => {
  test("agent_message item text becomes text; thread_id becomes sessionId", () => {
    const out = codexResultExtractor(makeRunResult(FLAT_JSONL));
    expect(out.text).toBe("All three tests pass.");
    expect(out.sessionId).toBe("thread_66b1");
  });

  test("non-agent-message items (reasoning, command_execution) are ignored", () => {
    const out = codexResultExtractor(makeRunResult(FLAT_JSONL));
    expect(out.text).not.toContain("Thinking");
    expect(out.text).not.toContain("ls");
  });
});

// ── codexResultExtractor — fallbacks and edge cases ───────────────────────────

describe("codexResultExtractor — fallbacks", () => {
  test("plain text stdout (no --json run) falls back to trimmed stdout, no sessionId", () => {
    const out = codexResultExtractor(makeRunResult("  Just a plain answer.\n"));
    expect(out.text).toBe("Just a plain answer.");
    expect(out.sessionId).toBeUndefined();
  });

  test("single bare JSON object (not a codex event) falls back to raw stdout", () => {
    const raw = `{"verdict":"pass"}`;
    const out = codexResultExtractor(makeRunResult(`${raw}\n`));
    // Not framed as a codex event — the engine's embedded-JSON tier gets it intact.
    expect(out.text).toBe(raw);
    expect(out.sessionId).toBeUndefined();
  });

  test("noise lines and malformed JSON between events are skipped", () => {
    const stdout = [
      "[codex] starting session",
      `{"id":"0","msg":{"type":"session_configured","session_id":"s-9"}}`,
      `{"broken json`,
      `{"id":"1","msg":{"type":"agent_message","message":"done"}}`,
      "",
    ].join("\n");
    const out = codexResultExtractor(makeRunResult(stdout));
    expect(out.text).toBe("done");
    expect(out.sessionId).toBe("s-9");
  });

  test("spawn-layer sessionId is kept when events reveal none", () => {
    const out = codexResultExtractor(makeRunResult("plain", { sessionId: "from-spawn" }));
    expect(out.sessionId).toBe("from-spawn");
  });

  test("event-derived session id overrides the spawn-layer one", () => {
    const stdout = `{"type":"thread.started","thread_id":"thread_real"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}`;
    const out = codexResultExtractor(makeRunResult(stdout, { sessionId: "stale" }));
    expect(out.sessionId).toBe("thread_real");
  });

  test("empty stdout yields empty text", () => {
    const out = codexResultExtractor(makeRunResult(""));
    expect(out.text).toBe("");
    expect(out.sessionId).toBeUndefined();
  });
});
