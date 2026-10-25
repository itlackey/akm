// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each harness shell hands its program, one table for all of them: argv,
 * stdin and env for a prompt, an interactive launch, a model, a persona and model
 * work; the env names it passes through; and the authored args it tolerates. No
 * real binary runs: `build` only turns a request into a command.
 */
import { describe, expect, test } from "bun:test";
import { getHarness, HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import type { AgentDispatchRequest, BuiltCommand } from "../../src/integrations/harnesses/harness";

const PROMPT = "do work";

interface Shell {
  /** The command for `PROMPT`. */
  headless: BuiltCommand;
  /** The command with no prompt: the program started for a person to use. */
  interactive: BuiltCommand;
  /** The command for `PROMPT` with `model: "m-1"`. */
  model: BuiltCommand;
  /** The args that follow the program in its built-in profile. */
  authored?: readonly string[];
  /** The env names its profile passes through beyond the common set. */
  passthrough: readonly string[];
  /** The flag its authored `--model` is dropped for, when the model is not carried by env. */
  modelFlag?: true;
}

const SHELLS: Record<string, Shell> = {
  claude: {
    headless: { argv: ["claude", "-p"], stdin: PROMPT },
    interactive: { argv: ["claude"] },
    model: { argv: ["claude", "--model", "m-1", "-p"], stdin: PROMPT },
    passthrough: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    modelFlag: true,
  },
  codex: {
    headless: {
      argv: ["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--", PROMPT],
    },
    interactive: { argv: ["codex"] },
    model: {
      argv: ["codex", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--model", "m-1", "--", PROMPT],
    },
    passthrough: ["OPENAI_API_KEY", "CODEX_HOME"],
    modelFlag: true,
  },
  pi: {
    headless: { argv: ["pi", "-p", PROMPT] },
    interactive: { argv: ["pi"] },
    model: { argv: ["pi", "--model", "m-1", "-p", PROMPT] },
    passthrough: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    modelFlag: true,
  },
  copilot: {
    headless: { argv: ["copilot", "--allow-all-tools", "-p", PROMPT] },
    interactive: { argv: ["copilot"] },
    model: { argv: ["copilot", "--model", "m-1", "--allow-all-tools", "-p", PROMPT] },
    passthrough: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    modelFlag: true,
  },
  gemini: {
    headless: { argv: ["gemini", "-p", PROMPT] },
    interactive: { argv: ["gemini"] },
    model: { argv: ["gemini", "--model", "m-1", "-p", PROMPT] },
    passthrough: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    modelFlag: true,
  },
  aider: {
    headless: { argv: ["aider", "--no-auto-commits", "--yes-always", "--no-pretty", `--message=${PROMPT}`] },
    interactive: { argv: ["aider", "--no-auto-commits"] },
    model: {
      argv: ["aider", "--no-auto-commits", "--model", "m-1", "--yes-always", "--no-pretty", `--message=${PROMPT}`],
    },
    passthrough: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    modelFlag: true,
  },
  amazonq: {
    headless: { argv: ["q", "chat", "--no-interactive", "--trust-all-tools", "--", PROMPT] },
    interactive: { argv: ["q", "chat"] },
    model: { argv: ["q", "chat", "--no-interactive", "--trust-all-tools", "--model", "m-1", "--", PROMPT] },
    passthrough: ["AWS_PROFILE", "AWS_REGION"],
    modelFlag: true,
  },
  openhands: {
    headless: { argv: ["openhands", "--headless", `--task=${PROMPT}`] },
    interactive: { argv: ["openhands"] },
    model: { argv: ["openhands", "--headless", `--task=${PROMPT}`], env: { LLM_MODEL: "m-1" } },
    passthrough: ["LLM_MODEL", "LLM_API_KEY", "LLM_BASE_URL"],
  },
  // The OpenCode 1 CLI transport; OpenCode 2 runs embedded and builds no command.
  opencode: {
    headless: { argv: ["opencode", "run"], stdin: PROMPT },
    interactive: { argv: ["opencode"] },
    model: { argv: ["opencode", "run", "--model", "m-1"], stdin: PROMPT },
    passthrough: ["OPENCODE_API_KEY", "OPENCODE_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME"],
    modelFlag: true,
  },
};

function build(id: string, request: AgentDispatchRequest, args?: readonly string[]): BuiltCommand {
  const harness = getHarness(id);
  if (!harness) throw new Error(`no harness "${id}"`);
  return harness.build({ bin: harness.profile.bin, args: args ?? harness.profile.args }, request);
}

describe("every registered harness has a shell here", () => {
  test("the table and the registry list the same harnesses", () => {
    expect(Object.keys(SHELLS).sort()).toEqual(HARNESS_REGISTRY.map((h) => h.id as string).sort());
  });
});

describe.each(Object.entries(SHELLS))("harness shell: %s", (id, shell) => {
  test("a prompt builds the headless command", () => {
    expect(build(id, { prompt: PROMPT })).toEqual(shell.headless);
  });

  test("no prompt builds the program started for a person: no prompt flag, no empty turn", () => {
    expect(build(id, {})).toEqual(shell.interactive);
  });

  test("a model is passed once", () => {
    expect(build(id, { prompt: PROMPT, model: "m-1" })).toEqual(shell.model);
  });

  test("the profile passes through the env names the program reads", () => {
    const harness = getHarness(id);
    expect(harness?.profile.envPassthrough).toEqual(expect.arrayContaining([...shell.passthrough]));
    // Names a program never reads are not passed: these were invented, not real.
    for (const invented of ["CLAUDE_CONFIG", "CODEX_CONFIG", "PI_API_KEY"]) {
      expect(harness?.profile.envPassthrough).not.toContain(invented);
    }
  });

  if (shell.modelFlag) {
    test("an authored --model is replaced by the request's, in either spelling", () => {
      for (const authored of [["--model", "old"], ["--model=old"]]) {
        const built = build(id, { prompt: PROMPT, model: "m-1" }, [
          ...(getHarness(id)?.profile.args ?? []),
          ...authored,
        ]);
        expect(built.argv.filter((arg) => arg === "--model")).toHaveLength(1);
        expect(built.argv).not.toContain("old");
        expect(built.argv).not.toContain("--model=old");
        expect(built.argv).toContain("m-1");
      }
    });

    test("an authored --model stays when the request names no model", () => {
      const built = build(id, { prompt: PROMPT }, [...(getHarness(id)?.profile.args ?? []), "--model", "old"]);
      expect(built.argv).toContain("old");
    });
  }
});

describe("authored subcommands are not doubled", () => {
  test("codex: a leading `exec`", () => {
    expect(build("codex", { prompt: PROMPT }, ["exec"])).toEqual(SHELLS.codex?.headless as BuiltCommand);
    expect(build("codex", { prompt: PROMPT }, ["exec", "--profile", "work"]).argv.slice(0, 4)).toEqual([
      "codex",
      "exec",
      "--profile",
      "work",
    ]);
  });

  test("amazonq: a leading `chat`", () => {
    expect(build("amazonq", { prompt: PROMPT }, ["chat"])).toEqual(SHELLS.amazonq?.headless as BuiltCommand);
  });

  test("opencode: `run` is the headless subcommand, dropped for an interactive launch", () => {
    expect(build("opencode", { prompt: PROMPT }, ["run"]).argv).toEqual(["opencode", "run"]);
    expect(build("opencode", {}, ["run"]).argv).toEqual(["opencode"]);
  });
});

describe("what a request adds", () => {
  test("claude: a native agent, a persona as an appended system prompt, and the model, before -p", () => {
    expect(build("claude", { prompt: PROMPT, agent: "reviewer", systemPrompt: "be terse", model: "m-1" })).toEqual({
      argv: ["claude", "--agent", "reviewer", "--append-system-prompt", "be terse", "--model", "m-1", "-p"],
      stdin: PROMPT,
    });
  });

  test("pi: a persona as the system prompt", () => {
    expect(build("pi", { prompt: PROMPT, systemPrompt: "be terse" }).argv).toEqual([
      "pi",
      "--system-prompt",
      "be terse",
      "-p",
      PROMPT,
    ]);
  });

  test("opencode: a native agent", () => {
    expect(build("opencode", { prompt: PROMPT, agent: "Review-Team.Exact" }).argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "Review-Team.Exact",
    ]);
  });

  test("codex: the authored sandbox is kept, in any spelling, and not doubled", () => {
    for (const authored of [
      ["--sandbox", "danger-full-access"],
      ["-s", "danger-full-access"],
      ["--sandbox=danger-full-access"],
    ]) {
      const argv = build("codex", { prompt: PROMPT }, authored).argv;
      expect(argv).not.toContain("workspace-write");
      expect(argv.filter((arg) => arg === "--sandbox" || arg === "-s" || arg.startsWith("--sandbox="))).toHaveLength(1);
    }
  });
});

describe("model work", () => {
  test("claude: read and akm search/show/curate only, no Edit, no transcript, the config's args left out", () => {
    const built = build("claude", { prompt: PROMPT, modelWork: true }, ["--add-dir", "/", "--model", "from-args"]);
    const argv = [...built.argv];
    expect(argv[0]).toBe("claude");
    expect(argv.slice(1, 4)).toEqual(["--restricted", "--strict-mcp-config", "--tools"]);
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Bash");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      "Read,Bash(akm search *),Bash(akm show *),Bash(akm curate *)",
    );
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(argv).toContain("--no-session-persistence");
    expect(argv.join(" ")).not.toContain("Edit");
    expect(argv).not.toContain("--add-dir");
    // Only the model the args name survives, and an explicit one replaces it.
    expect(argv[argv.indexOf("--model") + 1]).toBe("from-args");
    expect(build("claude", { prompt: PROMPT, modelWork: true, model: "m-1" }, ["--model", "from-args"]).argv).toContain(
      "m-1",
    );
    expect(built.stdin).toBe(PROMPT);
    expect(argv.at(-1)).toBe("-p");
  });

  test("codex: a read-only sandbox, whatever the config pins", () => {
    const argv = build("codex", { prompt: PROMPT, modelWork: true, model: "m-1" }, [
      "--sandbox",
      "danger-full-access",
    ]).argv;
    expect(argv).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "m-1",
      "--",
      PROMPT,
    ]);
  });

  test("a harness akm cannot confine says so: it is not confinable, so it runs the request as given", () => {
    expect(HARNESS_REGISTRY.filter((h) => h.confinable).map((h) => h.id)).toEqual(["opencode", "claude", "codex"]);
    expect(build("gemini", { prompt: PROMPT, modelWork: true }).argv).toEqual(["gemini", "-p", PROMPT]);
  });
});
