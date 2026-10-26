// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * What each harness shell hands its program, one table for all of them: argv,
 * stdin and env for a prompt, an interactive launch, a model, a persona and model
 * work, and the authored args it tolerates. No real binary runs: `build` only turns
 * a request into a command.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { getHarness, HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import type { AgentDispatchRequest, BuiltCommand } from "../../src/integrations/harnesses/harness";
import { fakeOpencodeMajor, withOpencodeOnPath } from "../_helpers/opencode-version";
import { withEnvSync } from "../_helpers/sandbox";
import { overrideSeam } from "../_helpers/seams";

const PROMPT = "do work";

// The opencode shell asks the binary's major only for model work, which flags it takes. OpenCode 1 is the baseline here,
// so no test reaches a real `opencode`; the cases that depend on the major run through a fake `opencode` on PATH.
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
  /** The flag its authored `--model` is dropped for, when the model is not carried by env. */
  modelFlag?: true;
}

const SHELLS: Record<string, Shell> = {
  claude: {
    headless: { argv: ["claude", "-p"], stdin: PROMPT },
    interactive: { argv: ["claude"] },
    model: { argv: ["claude", "--model", "m-1", "-p"], stdin: PROMPT },
    modelFlag: true,
  },
  codex: {
    headless: {
      argv: ["codex", "exec", "--skip-git-repo-check", "--", PROMPT],
    },
    interactive: { argv: ["codex"] },
    model: {
      argv: ["codex", "exec", "--skip-git-repo-check", "--model", "m-1", "--", PROMPT],
    },
    modelFlag: true,
  },
  pi: {
    headless: { argv: ["pi", "-p"], stdin: PROMPT },
    interactive: { argv: ["pi"] },
    model: { argv: ["pi", "--model", "m-1", "-p"], stdin: PROMPT },
    modelFlag: true,
  },
  copilot: {
    headless: { argv: ["copilot", "--allow-all-tools", "-p", PROMPT] },
    interactive: { argv: ["copilot"] },
    model: { argv: ["copilot", "--model", "m-1", "--allow-all-tools", "-p", PROMPT] },
    modelFlag: true,
  },
  gemini: {
    headless: { argv: ["gemini", "-p", PROMPT] },
    interactive: { argv: ["gemini"] },
    model: { argv: ["gemini", "--model", "m-1", "-p", PROMPT] },
    modelFlag: true,
  },
  aider: {
    headless: { argv: ["aider", "--yes-always", "--no-pretty", `--message=${PROMPT}`] },
    interactive: { argv: ["aider"] },
    model: {
      argv: ["aider", "--model", "m-1", "--yes-always", "--no-pretty", `--message=${PROMPT}`],
    },
    modelFlag: true,
  },
  amazonq: {
    headless: { argv: ["q", "chat", "--no-interactive", "--trust-all-tools", "--", PROMPT] },
    interactive: { argv: ["q", "chat"] },
    model: { argv: ["q", "chat", "--no-interactive", "--trust-all-tools", "--model", "m-1", "--", PROMPT] },
    modelFlag: true,
  },
  openhands: {
    headless: { argv: ["openhands", "--headless", `--task=${PROMPT}`] },
    interactive: { argv: ["openhands"] },
    model: { argv: ["openhands", "--headless", `--task=${PROMPT}`], env: { LLM_MODEL: "m-1" } },
  },
  // Agent work adds nothing on either major; model work is under "opencode by major".
  opencode: {
    headless: { argv: ["opencode", "run"], stdin: PROMPT },
    interactive: { argv: ["opencode"] },
    model: { argv: ["opencode", "run", "--model", "m-1"], stdin: PROMPT },
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

  test("opencode on OpenCode 1: unrestricted, in the scratch directory dispatch makes, with one warning; the config's args left out, their model kept", async () => {
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const authored = ["run", "--agent", "build", "--attach", "http://elsewhere", "--model", "from-args"];
    await withOpencodeOnPath(1, async () => {
      const built = build("opencode", { prompt: PROMPT, modelWork: true }, authored);
      expect(built).toEqual({ argv: ["opencode", "run", "--model", "from-args"], env: NO_FREE_MODELS, stdin: PROMPT });
      expect(build("opencode", { prompt: PROMPT, modelWork: true, model: "m-1" }, authored).argv).toEqual([
        "opencode",
        "run",
        "--model",
        "m-1",
      ]);
    });
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

  test("agent work adds nothing on either major: the authored args as written, the prompt on stdin, no environment", async () => {
    for (const major of [1, 2] as const) {
      await withOpencodeOnPath(major, async () => {
        expect(build("opencode", { prompt: PROMPT })).toEqual({ argv: ["opencode", "run"], stdin: PROMPT });
        const named = build("opencode", { prompt: PROMPT, agent: "reviewer", model: "p/m" }, ["run", "--model", "old"]);
        expect(named).toEqual({
          argv: ["opencode", "run", "--agent", "reviewer", "--model", "p/m"],
          stdin: PROMPT,
        });
      });
    }
  });

  test("agent work passes an authored --server, --standalone or --title as written", async () => {
    const authored = ["run", "--server", "http://elsewhere", "--standalone", "--title=mine", "--print-logs"];
    for (const major of [1, 2] as const) {
      await withOpencodeOnPath(major, async () => {
        expect(build("opencode", { prompt: PROMPT }, authored)).toEqual({
          argv: ["opencode", ...authored],
          stdin: PROMPT,
        });
      });
    }
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
      // The agent is passed with the run, in OpenCode 2's native `agents` map, and merges over the user's config; it
      // is written nowhere. Default-deny, then the reading tools: the last matching rule wins, so the order is the policy.
      const content = JSON.parse(built.env?.OPENCODE_CONFIG_CONTENT ?? "");
      const allow = (action: string) => ({ action, resource: "*", effect: "allow" });
      expect(content).toEqual({
        agents: {
          "akm-model-work": {
            mode: "primary",
            permissions: [
              { action: "*", resource: "*", effect: "deny" },
              allow("read"),
              allow("glob"),
              allow("grep"),
              allow("akm_search"),
              allow("akm_show"),
              allow("akm_curate"),
            ],
          },
        },
      });
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
    };
    type Inline = typeof INLINE & {
      agent?: Record<string, unknown>;
      agents: Record<string, unknown>;
    };
    const inlineConfig = (content: string | undefined): Promise<Inline> =>
      withOpencodeOnPath(2, async () =>
        JSON.parse(
          withEnvSync({ OPENCODE_CONFIG_CONTENT: content }, () =>
            build("opencode", { prompt: PROMPT, modelWork: true }),
          ).env?.OPENCODE_CONFIG_CONTENT ?? "",
        ),
      );
    /** A same-named entry that only labels the agent, and one that would allow every tool, in each shape. */
    const DESCRIBED = { mode: "primary", description: "Label for automated model calls" };
    const PERMISSIVE = {
      legacy: { mode: "primary", permission: { "*": "allow" } },
      native: { mode: "primary", permissions: [{ action: "*", resource: "*", effect: "allow" }] },
    };

    test("model work keeps all of it and sets its own agent in the native map, over a same-named entry in either map", async () => {
      const own = (await inlineConfig(undefined)).agents["akm-model-work"];
      const cases = [
        { agent: { "akm-model-work": PERMISSIVE.legacy }, agents: { "akm-model-work": DESCRIBED } },
        { agent: { "akm-model-work": DESCRIBED }, agents: { "akm-model-work": PERMISSIVE.native } },
        { agent: { "akm-model-work": PERMISSIVE.legacy } },
        { agents: { "akm-model-work": DESCRIBED } },
      ];
      for (const entries of cases) {
        const user = {
          ...INLINE,
          ...entries,
          agent: { reviewer: { mode: "subagent" }, ...entries.agent },
          agents: { planner: { mode: "subagent" }, ...entries.agents },
        };
        const merged = await inlineConfig(JSON.stringify(user));
        expect(merged.model).toBe("mine/fast");
        expect(merged.provider).toEqual(INLINE.provider);
        // OpenCode 2 reads the native map over the legacy one: akm's agent is there, and nowhere else.
        expect(merged.agents).toEqual({ planner: { mode: "subagent" }, "akm-model-work": own });
        expect(merged.agent).toEqual({ reviewer: { mode: "subagent" } });
      }
    });

    test("content written as JSONC, as OpenCode reads it, keeps all of it and is passed on as JSON", async () => {
      // A comment, a `//` inside a string, a `{env:...}` placeholder and trailing commas.
      const jsonc = `{
        // the user's own provider
        "model": "mine/fast",
        "provider": { "mine": { "options": { "baseURL": "http://127.0.0.1:1/v1", "apiKey": "{env:MINE_KEY}", }, }, },
        /* a block comment */
        "agents": { "planner": { "mode": "subagent" }, },
      }`;
      const merged = await inlineConfig(jsonc);
      expect(merged.model).toBe("mine/fast");
      expect(merged.provider).toEqual({
        mine: { options: { baseURL: "http://127.0.0.1:1/v1", apiKey: "{env:MINE_KEY}" } },
      });
      expect(merged.agents).toEqual({
        planner: { mode: "subagent" },
        "akm-model-work": (await inlineConfig(undefined)).agents["akm-model-work"],
      });
    });

    test("content that is not valid JSONC holding an object is left out, with one warning that names the variable", async () => {
      _resetWarnOnceForTests();
      const warnings: string[] = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level === "warn") warnings.push(args.map(String).join(" "));
      });
      const own = await inlineConfig(undefined);
      for (const content of ["{not json", '{"model": "a" // never closed', "[1]", '"text"']) {
        expect(await inlineConfig(content)).toEqual(own);
      }
      const named = warnings.filter((line) => line.includes("OPENCODE_CONFIG_CONTENT"));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain("not valid JSONC");
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
  });

  test("model work on a binary whose version cannot be read gets OpenCode 1's command, with one warning that says so", async () => {
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    await withOpencodeOnPath(
      "unreadable",
      async () => {
        // Agent work and an interactive launch take no flag that depends on the version, so neither reads it.
        expect(build("opencode", { prompt: PROMPT }).argv).toEqual(["opencode", "run"]);
        build("opencode", {});
        expect(warnings.filter((line) => line.includes("Could not read the version"))).toHaveLength(0);
        expect(build("opencode", { prompt: PROMPT, modelWork: true }).argv).toEqual(["opencode", "run"]);
      },
      { exclusive: true },
    );
    const unreadable = warnings.filter((line) => line.includes("Could not read the version of opencode"));
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toContain("OpenCode 1");
    expect(unreadable[0]).toContain("no --standalone");
    expect(unreadable[0]).toContain("unrestricted");
    expect(unreadable[0]).toContain("`opencode --version`");
  });
});
