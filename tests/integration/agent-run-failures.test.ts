// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What a failed agent run says. Real child processes stand in for the harness CLIs: the reason a program gives for a
 * non-zero exit is on the stream its harness declares, and reaches the error as plain text; a prompt the command line
 * cannot carry is named. Integration: it spawns real programs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { runAgent, runBuiltCommand } from "../../src/integrations/agent/spawn";
import { makeSandboxDir, type SandboxedDir } from "../_helpers/sandbox";

let bins: SandboxedDir;

const PROGRAMS: Record<string, string> = {
  // Claude Code in print mode: its error is on stdout.
  stdoutError: "#!/bin/sh\nprintf 'Invalid API key\\n'\nexit 1\n",
  // A program that colors its error on stderr.
  stderrError: "#!/bin/sh\nprintf '\\033[91mError: \\033[0mboom\\n' >&2\nexit 3\n",
  quiet: "#!/bin/sh\nexit 4\n",
};

beforeAll(() => {
  bins = makeSandboxDir("akm-agent-run-failures-bin");
  for (const [name, script] of Object.entries(PROGRAMS))
    fs.writeFileSync(path.join(bins.dir, name), script, { mode: 0o755 });
});

afterAll(() => bins.cleanup());

const profile = (platform: string, program: string): AgentProfile => ({
  name: "test-agent",
  platform,
  bin: path.join(bins.dir, program),
  args: [],
  stdio: "captured",
});

describe("the reason a program gave for a non-zero exit", () => {
  test("Claude Code's is on stdout: the error ends with that line", async () => {
    const result = await runAgent(profile("claude", "stdoutError"), { dispatch: { prompt: "go" } });
    expect(result).toMatchObject({ ok: false, reason: "non_zero_exit" });
    expect(result.error).toBe('agent CLI "test-agent" exited with code 1: Invalid API key');
  });

  test("Codex's is on stderr: the error ends with that line, with no terminal escape in it", async () => {
    const result = await runAgent(profile("codex", "stderrError"), { dispatch: { prompt: "go" } });
    expect(result.error).toBe('agent CLI "test-agent" exited with code 3: Error: boom');
    expect(result.error).not.toContain("\u001b");
  });

  test("a program that wrote nothing on its stream gets the exit code only", async () => {
    const result = await runAgent(profile("claude", "quiet"), { dispatch: { prompt: "go" } });
    expect(result.error).toBe('agent CLI "test-agent" exited with code 4');
  });

  test("a command that declares no failure stream gets the exit code only, whatever the program wrote", async () => {
    const result = await runBuiltCommand(
      "agent CLI x",
      { argv: [path.join(bins.dir, "stderrError")], env: process.env as Record<string, string> },
      {},
    );
    expect(result.error).toBe("agent CLI x exited with code 3");
  });

  test("a long line is cut to 300 characters", async () => {
    const long = path.join(bins.dir, "long");
    fs.writeFileSync(long, `#!/bin/sh\nprintf '%s\\n' ${"x".repeat(500)} >&2\nexit 2\n`, { mode: 0o755 });
    const result = await runAgent({ ...profile("codex", "long") }, { dispatch: { prompt: "go" } });
    expect(result.error?.split(": ").at(-1)).toHaveLength(300);
  });
});

describe("a prompt the command line cannot carry", () => {
  test("a harness that takes the prompt as an argument names it, with its size", async () => {
    const prompt = "x".repeat(200_000);
    const result = await runAgent(profile("gemini", "quiet"), { dispatch: { prompt } });
    expect(result).toMatchObject({ ok: false, reason: "spawn_failed" });
    expect(result.error).toContain("the command line is longer than the system allows");
    expect(result.error).toContain("200000 bytes in the prompt argument");
    expect(result.error).toContain("takes the prompt on its command line");
  });

  test("an argument other than the prompt is not blamed on it: Claude Code reads the prompt from stdin", async () => {
    const result = await runAgent(profile("claude", "quiet"), {
      dispatch: { prompt: "go", systemPrompt: "x".repeat(200_000) },
    });
    expect(result).toMatchObject({ ok: false, reason: "spawn_failed" });
    expect(result.error).toContain("the command line is longer than the system allows");
    expect(result.error).not.toContain("prompt");
  });
});
