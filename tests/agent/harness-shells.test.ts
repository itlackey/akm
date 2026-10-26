// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each harness shell hands its program, one table for all of them: argv,
 * stdin and env for a prompt, an interactive launch, a model, a persona and model
 * work; the env names it passes through; and the authored args it tolerates. No
 * real binary runs: `build` only turns a request into a command.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { isEnvPassthroughValueSafeToExpose } from "../../src/core/redaction";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { collectDispatchSensitiveValues } from "../../src/integrations/agent/runner-dispatch";
import { getHarness, HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import type { AgentDispatchRequest, BuiltCommand } from "../../src/integrations/harnesses/harness";
import { fakeOpencodeMajor, withOpencodeOnPath } from "../_helpers/opencode-version";
import { withEnvSync } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const PROMPT = "do work";

// The opencode shell asks the binary's major which flags to pass. OpenCode 1 is pinned for the table below; OpenCode 2
// has its own cases further down, through a fake `opencode` on PATH.
beforeEach(() => fakeOpencodeMajor(1));

/** Set on opencode model work only: on agent work it would override the user's chosen free model. */
const NO_FREE_MODELS = { OPENCODE_DISABLE_FREE_MODELS: "1" };

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
    headless: { argv: ["pi", "-p"], stdin: PROMPT },
    interactive: { argv: ["pi"] },
    model: { argv: ["pi", "--model", "m-1", "-p"], stdin: PROMPT },
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
  // OpenCode 1's command (pinned above); OpenCode 2's flags are under "opencode by major".
  opencode: {
    headless: { argv: ["opencode", "run"], stdin: PROMPT },
    interactive: { argv: ["opencode"] },
    model: { argv: ["opencode", "run", "--model", "m-1"], stdin: PROMPT },
    passthrough: [
      "OPENCODE_API_KEY",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "OPENCODE_CONFIG_CONTENT",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ],
    modelFlag: true,
  },
};

function build(id: string, request: AgentDispatchRequest, args?: readonly string[]): BuiltCommand {
  const harness = getHarness(id);
  if (!harness) throw new Error(`no harness "${id}"`);
  // opencode's profile bin follows PATH (`opencode2` when it is there); the shell is handed the plain name.
  const bin = id === "opencode" ? "opencode" : harness.profile.bin;
  return harness.build({ bin, args: args ?? harness.profile.args }, request);
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

  test("pi: a persona appended to pi's own system prompt, and the prompt on stdin whatever it starts with", () => {
    expect(build("pi", { prompt: PROMPT, systemPrompt: "be terse" })).toEqual({
      argv: ["pi", "--append-system-prompt", "be terse", "-p"],
      stdin: PROMPT,
    });
    // As an argument these would be read as an option, an unknown flag and a file include.
    for (const prompt of ["- item one", "--word", "@file"]) {
      expect(build("pi", { prompt })).toEqual({ argv: ["pi", "-p"], stdin: prompt });
    }
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

  test("opencode on OpenCode 1: unrestricted, in the scratch directory dispatch makes, with one warning; the config's args left out, their model kept", () => {
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const authored = ["run", "--agent", "build", "--attach", "http://elsewhere", "--model", "from-args"];
    const built = build("opencode", { prompt: PROMPT, modelWork: true }, authored);
    expect(built).toEqual({ argv: ["opencode", "run", "--model", "from-args"], env: NO_FREE_MODELS, stdin: PROMPT });
    expect(build("opencode", { prompt: PROMPT, modelWork: true, model: "m-1" }, authored).argv).toEqual([
      "opencode",
      "run",
      "--model",
      "m-1",
    ]);
    expect(warnings.filter((line) => line.includes("OpenCode 1 cannot restrict"))).toHaveLength(1);
  });

  test("a harness akm cannot confine says so: it is not confinable, so it runs the request as given", () => {
    expect(HARNESS_REGISTRY.filter((h) => h.confinable).map((h) => h.id)).toEqual(["opencode", "claude", "codex"]);
    expect(build("gemini", { prompt: PROMPT, modelWork: true }).argv).toEqual(["gemini", "-p", PROMPT]);
  });
});

describe("opencode by major", () => {
  // Through a fake `opencode` on PATH that reports the major, so the real version probe decides.
  const STANDALONE = ["--standalone", "--title", "akm"];

  test("OpenCode 2 runs one process, titled, with the prompt on stdin", async () => {
    await withOpencodeOnPath(2, async () => {
      expect(build("opencode", { prompt: PROMPT })).toEqual({
        argv: ["opencode", "run", ...STANDALONE],
        stdin: PROMPT,
      });
      const named = build("opencode", { prompt: PROMPT, agent: "reviewer", model: "p/m" }, ["run", "--model", "old"]);
      expect(named).toEqual({
        argv: ["opencode", "run", ...STANDALONE, "--agent", "reviewer", "--model", "p/m"],
        stdin: PROMPT,
      });
    });
  });

  test("OpenCode 2 model work runs as the tool-limited agent defined inline, never the config's args or agent", async () => {
    await withOpencodeOnPath(2, async () => {
      const authored = ["run", "--agent", "build", "--attach", "http://elsewhere", "--model", "from-args"];
      const built = build("opencode", { prompt: PROMPT, modelWork: true }, authored);
      expect(built.argv).toEqual([
        "opencode",
        "run",
        ...STANDALONE,
        "--agent",
        "akm-model-work",
        "--model",
        "from-args",
      ]);
      expect(built.stdin).toBe(PROMPT);
      expect(built.env).toMatchObject(NO_FREE_MODELS);
      // The agent is passed with the run and merges over the user's config; it is written nowhere.
      // Default-deny, then the reading tools: the last matching entry wins, so the order is the policy.
      const content = JSON.parse(built.env?.OPENCODE_CONFIG_CONTENT ?? "");
      expect(content).toEqual({
        agent: {
          "akm-model-work": {
            mode: "primary",
            permission: {
              "*": "deny",
              read: "allow",
              glob: "allow",
              grep: "allow",
              akm_search: "allow",
              akm_show: "allow",
              akm_curate: "allow",
            },
          },
        },
      });
      expect(Object.entries(content.agent["akm-model-work"].permission)[0]).toEqual(["*", "deny"]);
      expect(build("opencode", { prompt: PROMPT, modelWork: true, model: "m-1" }, authored).argv).toEqual([
        "opencode",
        "run",
        ...STANDALONE,
        "--agent",
        "akm-model-work",
        "--model",
        "m-1",
      ]);
    });
  });

  describe("the user's OPENCODE_CONFIG_CONTENT", () => {
    const INLINE = {
      model: "mine/fast",
      provider: { mine: { options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "SYNTHETIC_KEY" } } },
      agent: {
        reviewer: { mode: "subagent" },
        "akm-model-work": { mode: "primary", permission: { "*": "allow" } },
      },
    };
    type Inline = typeof INLINE;
    const inlineConfig = (content: string | undefined): Promise<Inline> =>
      withOpencodeOnPath(2, async () =>
        JSON.parse(
          withEnvSync({ OPENCODE_CONFIG_CONTENT: content }, () =>
            build("opencode", { prompt: PROMPT, modelWork: true }),
          ).env?.OPENCODE_CONFIG_CONTENT ?? "",
        ),
      );

    test("model work keeps all of it and sets its own agent on the one key, which it wins", async () => {
      const merged = await inlineConfig(JSON.stringify(INLINE));
      expect(merged.model).toBe("mine/fast");
      expect(merged.provider).toEqual(INLINE.provider);
      expect(merged.agent.reviewer).toEqual({ mode: "subagent" });
      expect(merged.agent["akm-model-work"]).toEqual((await inlineConfig(undefined)).agent["akm-model-work"]);
      expect(Object.entries(merged.agent["akm-model-work"].permission)[0]).toEqual(["*", "deny"]);
    });

    test("content that is not a JSON object is left out, with one warning that names the variable", async () => {
      _resetWarnOnceForTests();
      const warnings: string[] = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      });
      const own = await inlineConfig(undefined);
      for (const content of ["{not json", "[1]", '"text"']) expect(await inlineConfig(content)).toEqual(own);
      expect(warnings.filter((line) => line.includes("OPENCODE_CONFIG_CONTENT"))).toHaveLength(1);
    });

    test("a blank value is no content, and agent work never sets it", async () => {
      const own = await inlineConfig(undefined);
      expect(await inlineConfig("  ")).toEqual(own);
      await withOpencodeOnPath(2, async () => {
        const built = withEnvSync({ OPENCODE_CONFIG_CONTENT: JSON.stringify(INLINE) }, () =>
          build("opencode", { prompt: PROMPT }),
        );
        expect(built.env).toBeUndefined();
      });
    });

    test("it is passed through to the program, and shown nowhere: it can hold an apiKey", () => {
      const harness = getHarness("opencode");
      expect(harness?.profile.envPassthrough).toContain("OPENCODE_CONFIG_CONTENT");
      const content = JSON.stringify(INLINE);
      expect(isEnvPassthroughValueSafeToExpose("OPENCODE_CONFIG_CONTENT", content)).toBe(false);
      const runner = {
        kind: "harness",
        name: "opencode",
        platform: "opencode",
        bin: "opencode",
        args: [],
        timeoutMs: null,
      } as const;
      expect(collectDispatchSensitiveValues(runner, { OPENCODE_CONFIG_CONTENT: content })).toContain(content);
      // A path-like name is not secret: the contrast that makes the line above mean something.
      expect(collectDispatchSensitiveValues(runner, { OPENCODE_CONFIG_DIR: "/home/me/.config/opencode" })).toEqual([]);
    });
  });

  test("a binary whose version cannot be read gets OpenCode 1's command", () => {
    fakeOpencodeMajor(() => undefined);
    expect(build("opencode", { prompt: PROMPT }).argv).toEqual(["opencode", "run"]);
  });
});
