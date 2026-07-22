// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * OpenAI Codex CLI agent command builder (P2, plan §"The adapter contract" /
 * §"Capability matrix").
 *
 * Translates a platform-agnostic {@link AgentDispatchRequest} into the exact
 * headless argv the `codex` CLI expects:
 *
 *   codex exec --sandbox workspace-write [--model <m>] --json [--output-schema <file>] -- "<prompt>"
 *
 * Capability-matrix facts this builder encodes (July 2026 research):
 *   - Headless invocation is the `exec` subcommand (`codex exec "<p>"`), not a
 *     flag. The built-in codex profiles carry `args: []`, so the builder
 *     prepends `exec` itself; a user profile that already pins `exec` as its
 *     first arg is not doubled.
 *   - `--json` switches stdout to a JSONL event stream — the input contract of
 *     `./result-extractor.ts`. Always emitted, mirroring how the Claude builder
 *     always emits `--print`: dispatch is the captured, non-interactive path.
 *   - Codex is the NATIVE-SCHEMA tier (plan §"Structured-output
 *     normalization"): `req.schema` is written to a temp file and passed via
 *     `--output-schema <file>`. The file is tiny, uniquely named under the OS
 *     temp dir, and intentionally NOT cleaned up here — `BuiltCommand` has no
 *     post-run hook, and the spawned process reads the file after `build()`
 *     returns. OS temp reaping owns the lifecycle. The engine still validates
 *     the output defensively (the constrained output is trusted but verified).
 *   - `codex exec` has no system-prompt flag; `req.systemPrompt` is folded
 *     into the prompt payload (system text first, blank line, then the task),
 *     after the `--` end-of-options separator so it can never be parsed as a
 *     flag.
 *   - Tool policy is omitted, but the builder DOES inject `--sandbox
 *     workspace-write` so dispatched units can write to their working
 *     directory.  `codex exec` defaults to a read-only sandbox that silently
 *     blocks file writes; without this flag the unit returns "workspace is
 *     read-only" and the engine marks the step complete with no real mutation.
 *     `--ask-for-approval` is NOT injected — that flag only exists on the
 *     interactive `codex` command, not on `codex exec`, and exec mode is
 *     already non-approval-blocking.  Profile-supplied `--sandbox` flags
 *     (long or short form) are preserved (not duplicated).
 *   - Resume is the `codex exec resume <id>` SUBCOMMAND, not a flag, so it is
 *     not expressible through `AgentDispatchRequest` (which has no session
 *     field yet); {@link codexResumeArgs} exposes the argv prefix for the
 *     integration task that wires session-id reuse from `workflow_run_units`.
 *   - `req.effort` stays unconsumed (reserved; codex would take it as
 *     `-c model_reasoning_effort=<v>` — left to the integration task so the
 *     shared request contract's "no builder consumes it yet" note stays true).
 *
 * NOT registered anywhere yet: `HARNESS_REGISTRY` / `BUILTIN_BUILDERS` wiring
 * is a follow-up integration task. Exported cleanly for that task to import.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentCommandBuilder, assertNotFlag, resolveDispatchModel } from "../../agent/builder-shared";

/**
 * Write a node's JSON Schema to a fresh temp file for `--output-schema`.
 *
 * A unique `mkdtemp` directory per build avoids collisions between concurrent
 * fan-out units dispatching in the same process. Returns the absolute file
 * path (the value handed to the flag).
 */
export function writeCodexOutputSchemaFile(schema: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "akm-codex-schema-"));
  const file = join(dir, "output-schema.json");
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Argv prefix that resumes a previous codex session: `exec resume <id>`.
 * Codex resume is a subcommand chain, not a flag. The harness-native session
 * id comes from the unit row (stored opportunistically by the result
 * extractor); akm never depends on it (plan §"Session, MCP, and identity").
 */
export function codexResumeArgs(sessionId: string): readonly string[] {
  assertNotFlag(sessionId, "sessionId");
  return ["exec", "resume", sessionId];
}

/**
 * Return `base` plus the `--sandbox workspace-write` flag that makes `codex exec`
 * able to write to its working directory.  `codex exec` defaults to a read-only
 * sandbox that silently blocks file writes — without this flag the unit returns
 * "workspace is read-only" and the engine marks the step complete with no real
 * mutation.  If the profile already pins `--sandbox` (long or short form) the
 * default is not duplicated.
 *
 * Note: `--ask-for-approval` is an *interactive* codex flag only — `codex exec`
 * does not accept it (it errors with "unexpected argument").  Non-interactive
 * exec mode is implicitly non-approval-blocking; `--sandbox workspace-write`
 * alone is sufficient for dispatched units.
 */
function ensureSandboxFlags(base: readonly string[]): string[] {
  const out = [...base];
  if (!out.includes("--sandbox") && !out.includes("-s")) {
    out.push("--sandbox", "workspace-write");
  }
  return out;
}

/**
 * OpenAI Codex builder.
 * Command shape: codex exec --sandbox workspace-write [--model <m>] --json [--output-schema <file>] -- "<prompt>"
 */
export const codexBuilder: AgentCommandBuilder = {
  platform: "codex",
  build(profile, req) {
    assertNotFlag(req.systemPrompt, "systemPrompt");
    assertNotFlag(req.model, "model");
    // Built-in codex profiles ship `args: []`; headless dispatch is the `exec`
    // subcommand. Don't double it when a user profile already pins it.
    const extra = profile.args[0] === "exec" ? profile.args.slice(1) : [...profile.args];
    // `codex exec` defaults to a read-only sandbox that silently blocks file
    // writes — dispatched units would return "workspace is read-only" and the
    // engine would mark them complete with no real mutation.  Force
    // `workspace-write` (writes scoped to cwd) unless the profile already pins
    // its own --sandbox flag (`--ask-for-approval` is not injectable here —
    // see ensureSandboxFlags).
    const sandboxArgs = ensureSandboxFlags(extra);
    const args: string[] = ["exec", ...sandboxArgs];
    if (req.model) {
      const resolved = resolveDispatchModel(req, profile, "codex") as string;
      args.push("--model", resolved);
    }
    // JSONL event stream on stdout — the codex result extractor's input.
    args.push("--json");
    if (req.schema) {
      // Native-schema tier: pass the node schema straight through.
      args.push("--output-schema", writeCodexOutputSchemaFile(req.schema));
    }
    // No system-prompt flag exists on `codex exec` — fold it into the prompt.
    const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
    args.push("--");
    args.push(prompt);
    return { argv: [profile.bin, ...args] };
  },
};
