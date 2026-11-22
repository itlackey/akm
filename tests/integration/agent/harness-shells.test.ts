// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The command each harness shell builds where the command line is the contract with the program: its subcommands, a
 * persona, a native agent, the read-only restriction of model work, and OpenCode's inline config and major. No real
 * binary runs: `build` only turns a request into a command. What a program receives for a prompt, a model or an
 * interactive launch is read from a stand-in program in `harness-stand-ins.test.ts`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../../src/core/warn";
import { getHarness, HARNESS_REGISTRY } from "../../../src/integrations/harnesses";
import type { AgentDispatchRequest, BuiltCommand } from "../../../src/integrations/harnesses/harness";
import { readOpencode1Run } from "../../../src/integrations/harnesses/opencode/run-events";
import { fakeOpencodeMajor, withOpencodeOnPath } from "../../_helpers/opencode-version";
import { withEnvSync } from "../../_helpers/sandbox";
import { overrideSeam } from "../../_helpers/seams";

const PROMPT = "do work";

// The opencode shell asks the binary's major, which flags and which report it takes. OpenCode 1 is the baseline here,
// so no test reaches a real `opencode`; the cases that depend on the major run through a fake `opencode` on PATH.
beforeEach(() => fakeOpencodeMajor(1));

/** Set on opencode model work only: on agent work it would override the user's chosen free model. */
const NO_FREE_MODELS = { OPENCODE_DISABLE_FREE_MODELS: "1" };

function build(id: string, request: AgentDispatchRequest, args?: readonly string[]): BuiltCommand {
  const harness = getHarness(id);
  if (!harness) throw new Error(`no harness "${id}"`);
  // opencode's profile bin follows PATH (`opencode2` when it is there); the shell is handed the plain name.
  const bin = id === "opencode" ? "opencode" : harness.profile.bin;
  return harness.build({ bin, args: args ?? harness.profile.args }, request);
}

describe("authored subcommands are not doubled", () => {
  test("codex: a leading `exec`", () => {
    expect(build("codex", { prompt: PROMPT }, ["exec"])).toEqual({
      argv: ["codex", "exec", "--skip-git-repo-check", "-"],
      stdin: PROMPT,
      failureStream: "stderr",
    });
    expect(build("codex", { prompt: PROMPT }, ["exec", "--profile", "work"]).argv.slice(0, 4)).toEqual([
      "codex",
      "exec",
      "--profile",
      "work",
    ]);
  });

  test("amazonq: a leading `chat`", () => {
    expect(build("amazonq", { prompt: PROMPT }, ["chat"])).toEqual({
      argv: ["q", "chat", "--no-interactive", "--trust-all-tools", "--", PROMPT],
      failureStream: "stderr",
    });
  });

  test("opencode: `run` is the headless subcommand, dropped for an interactive launch", () => {
    expect(build("opencode", { prompt: PROMPT }, ["run"]).argv).toEqual(["opencode", "run", "--format", "json"]);
    expect(build("opencode", { prompt: PROMPT }, ["--print-logs"]).argv).toEqual([
      "opencode",
      "run",
      "--print-logs",
      "--format",
      "json",
    ]);
    expect(build("opencode", {}, ["run"]).argv).toEqual(["opencode"]);
  });
});

describe("what a request adds", () => {
  test("claude: a native agent, a persona as an appended system prompt, and the model, before -p", () => {
    expect(build("claude", { prompt: PROMPT, agent: "reviewer", systemPrompt: "be terse", model: "m-1" })).toEqual({
      argv: ["claude", "--agent", "reviewer", "--append-system-prompt", "be terse", "--model", "m-1", "-p"],
      stdin: PROMPT,
      failureStream: "stdout",
    });
  });

  test("pi: a persona appended to pi's own system prompt, and the prompt on stdin whatever it starts with", () => {
    expect(build("pi", { prompt: PROMPT, systemPrompt: "be terse" })).toEqual({
      argv: ["pi", "--append-system-prompt", "be terse", "-p"],
      stdin: PROMPT,
      failureStream: "stderr",
    });
    // As an argument these would be read as an option, an unknown flag and a file include.
    for (const prompt of ["- item one", "--word", "@file"]) {
      expect(build("pi", { prompt })).toEqual({ argv: ["pi", "-p"], stdin: prompt, failureStream: "stderr" });
    }
  });

  test("opencode: a native agent", () => {
    expect(build("opencode", { prompt: PROMPT, agent: "Review-Team.Exact" }).argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "Review-Team.Exact",
      "--format",
      "json",
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
    const built = build("codex", { prompt: PROMPT, modelWork: true, model: "m-1" }, [
      "--sandbox",
      "danger-full-access",
    ]);
    expect(built.argv).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--model",
      "m-1",
      "-",
    ]);
    expect(built.stdin).toBe(PROMPT);
  });

  test("opencode on OpenCode 1: limited to reading and searching like OpenCode 2, no warning; the config's args left out, their model kept", async () => {
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    const authored = ["run", "--agent", "build", "--attach", "http://elsewhere", "--model", "from-args"];
    await withOpencodeOnPath(1, async () => {
      const built = build("opencode", { prompt: PROMPT, modelWork: true }, authored);
      // The agent is selected and the title is given, so there is no title request; the inline config carries the
      // agent's one-line prompt in OpenCode 1's singular `agent` map, with every tool denied but the reading ones
      // (the last matching rule wins, so the `*` deny comes first).
      expect(built.argv).toEqual([
        "opencode",
        "run",
        "--format",
        "json",
        "--title",
        "akm",
        "--agent",
        "akm-model-work",
        "--model",
        "from-args",
      ]);
      expect(built.stdin).toBe(PROMPT);
      expect(built.env).toMatchObject(NO_FREE_MODELS);
      expect(JSON.parse(built.env?.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
        agent: {
          "akm-model-work": {
            mode: "primary",
            prompt: "Do the task in the message. Reply with exactly what it asks for.",
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
      const rules = JSON.parse(built.env?.OPENCODE_CONFIG_CONTENT ?? "").agent["akm-model-work"].permission;
      expect(Object.keys(rules)[0]).toBe("*");
      expect(build("opencode", { prompt: PROMPT, modelWork: true, model: "m-1" }, authored).argv).toEqual([
        "opencode",
        "run",
        "--format",
        "json",
        "--title",
        "akm",
        "--agent",
        "akm-model-work",
        "--model",
        "m-1",
      ]);
      // The user's own inline config stays, with the agent added to its `agent` map.
      const user = { model: "mine/fast", agent: { reviewer: { mode: "subagent" } } };
      const merged = withEnvSync({ OPENCODE_CONFIG_CONTENT: JSON.stringify(user) }, () =>
        build("opencode", { prompt: PROMPT, modelWork: true }),
      );
      const content = JSON.parse(merged.env?.OPENCODE_CONFIG_CONTENT ?? "");
      expect(content.model).toBe("mine/fast");
      expect(Object.keys(content.agent)).toEqual(["reviewer", "akm-model-work"]);
    });
    expect(warnings.filter((line) => line.includes("restrict"))).toEqual([]);
  });

  test("a harness akm cannot confine says so: it is not confinable, so it runs the request as given", () => {
    expect(HARNESS_REGISTRY.filter((h) => h.confinable).map((h) => h.id)).toEqual(["opencode", "claude", "codex"]);
    expect(build("gemini", { prompt: PROMPT, modelWork: true }).argv).toEqual(["gemini", "-p", PROMPT]);
  });
});

describe("opencode by major", () => {
  // Through a fake `opencode` on PATH that reports the major, so the real version probe decides.
  const STANDALONE = ["--standalone", "--title", "akm"];

  test("OpenCode 2 agent work is `run`, the authored args as written, the prompt on stdin, no environment and no report", async () => {
    await withOpencodeOnPath(2, async () => {
      expect(build("opencode", { prompt: PROMPT })).toEqual({
        argv: ["opencode", "run"],
        stdin: PROMPT,
        failureStream: "stderr",
      });
      const named = build("opencode", { prompt: PROMPT, agent: "reviewer", model: "p/m" }, ["run", "--model", "old"]);
      expect(named).toEqual({
        argv: ["opencode", "run", "--agent", "reviewer", "--model", "p/m"],
        stdin: PROMPT,
        failureStream: "stderr",
      });
      expect(build("opencode", { prompt: PROMPT }, ["--format", "json"]).argv).toEqual([
        "opencode",
        "run",
        "--format",
        "json",
      ]);
    });
  });

  test("OpenCode 1 agent and model work read the event stream: one --format json, an authored --format replaced", async () => {
    await withOpencodeOnPath(1, async () => {
      for (const authored of [["--format", "default"], ["--format=default"], ["run", "--format", "default"], []]) {
        const built = build("opencode", { prompt: PROMPT }, authored);
        expect(built.argv).toEqual(["opencode", "run", "--format", "json"]);
        expect(built.report).toBe(readOpencode1Run);
      }
      const model = build("opencode", { prompt: PROMPT, modelWork: true }, ["--format", "default"]);
      expect(model.argv.filter((arg) => arg === "--format")).toHaveLength(1);
      expect(model.argv).toContain("json");
      expect(model.report).toBe(readOpencode1Run);
      expect(build("opencode", {}).report).toBeUndefined();
      expect(build("opencode", {}, ["--format", "default"]).argv).toEqual(["opencode", "--format", "default"]);
    });
    await withOpencodeOnPath(2, async () => {
      expect(build("opencode", { prompt: PROMPT, modelWork: true }).report).toBeUndefined();
      expect(build("opencode", { prompt: PROMPT, modelWork: true }).argv).not.toContain("--format");
    });
  });

  test("the harness writes `run` itself, so authored args that do not start with it still run headless", async () => {
    for (const major of [1, 2] as const) {
      await withOpencodeOnPath(major, async () => {
        const json = major === 1 ? ["--format", "json"] : [];
        expect(build("opencode", { prompt: PROMPT }, ["--print-logs"]).argv).toEqual([
          "opencode",
          "run",
          "--print-logs",
          ...json,
        ]);
        expect(build("opencode", { prompt: PROMPT }, ["run", "--x"]).argv).toEqual(["opencode", "run", "--x", ...json]);
      });
    }
    await withOpencodeOnPath(2, async () => {
      expect(build("opencode", { prompt: PROMPT }, ["--standalone"]).argv).toEqual(["opencode", "run", "--standalone"]);
    });
  });

  test("agent work passes an authored --server, --standalone or --title as written", async () => {
    const authored = ["run", "--server", "http://elsewhere", "--standalone", "--title=mine", "--print-logs"];
    for (const major of [1, 2] as const) {
      await withOpencodeOnPath(major, async () => {
        expect(build("opencode", { prompt: PROMPT }, authored).argv).toEqual([
          "opencode",
          ...authored,
          ...(major === 1 ? ["--format", "json"] : []),
        ]);
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
        // OpenCode's browser plugin is removed: from 2.2.0 its own rules would keep the `skill` tool listed.
        plugins: ["-opencode.browser"],
        agents: {
          "akm-model-work": {
            mode: "primary",
            system: "Do the task in the message. Reply with exactly what it asks for.",
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
      plugin?: unknown[];
      plugins: unknown[];
    };
    const inlineConfig = (content: string | undefined, env: Record<string, string | undefined> = {}): Promise<Inline> =>
      withOpencodeOnPath(2, async () =>
        JSON.parse(
          withEnvSync({ OPENCODE_CONFIG_CONTENT: content, ...env }, () =>
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
        expect(merged.plugins).toEqual(["-opencode.browser"]);
        // OpenCode 2 reads the native map over the legacy one: akm's agent is there, and nowhere else.
        expect(merged.agents).toEqual({ planner: { mode: "subagent" }, "akm-model-work": own });
        expect(merged.agent).toEqual({ reviewer: { mode: "subagent" } });
      }
    });

    test("the user's plugins stay, in either key, with OpenCode's browser plugin removed after them", async () => {
      const plugins = ["mine-plugin", { package: "/opt/plugin", options: { a: 1 } }];
      const merged = await inlineConfig(JSON.stringify({ ...INLINE, plugin: ["legacy-plugin"], plugins }));
      expect(merged.plugin).toEqual(["legacy-plugin"]);
      expect(merged.plugins).toEqual([...plugins, "-opencode.browser"]);
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

    describe("{env:NAME} references, which OpenCode replaces before it parses the content", () => {
      /** The user's provider options, with `timeout` and `apiKey` written as given. */
      const withOptions = (timeout: string, apiKey: string): string =>
        `{"model": "mine/fast", "provider": {"mine": {"options": {"timeout": ${timeout}, "apiKey": ${apiKey}}}}}`;
      const optionsOf = (inline: Inline): unknown => (inline.provider.mine as { options?: unknown }).options;

      test("one written outside a string that names a number is read as that number, as OpenCode reads it", async () => {
        const merged = await inlineConfig(withOptions("{env:AKM_TEST_OC_TIMEOUT}", '"{env:AKM_TEST_OC_KEY}"'), {
          AKM_TEST_OC_TIMEOUT: "30000",
          AKM_TEST_OC_KEY: "SYNTHETIC_KEY",
        });
        expect(merged.model).toBe("mine/fast");
        // OpenCode replaces every reference in the content, so the one in a string is its value too.
        expect(optionsOf(merged)).toEqual({ timeout: 30000, apiKey: "SYNTHETIC_KEY" });
        expect(Object.keys(merged.agents)).toEqual(["akm-model-work"]);
      });

      test("content that reads as written keeps a quoted one unchanged, for the OpenCode akm runs to replace", async () => {
        const merged = await inlineConfig(withOptions("30000", '"{env:AKM_TEST_OC_KEY}"'), {
          AKM_TEST_OC_KEY: "SYNTHETIC_KEY",
        });
        expect(optionsOf(merged)).toEqual({ timeout: 30000, apiKey: "{env:AKM_TEST_OC_KEY}" });
      });

      test("an unset variable is replaced by nothing, as OpenCode does: in a string it is empty, outside one the content does not read", async () => {
        _resetWarnOnceForTests();
        const warnings: string[] = [];
        overrideSeam(_setWarnSinkForTests, (level, args) => {
          if (level === "warn") warnings.push(args.map(String).join(" "));
        });
        const unset = { AKM_TEST_OC_TIMEOUT: "30000", AKM_TEST_OC_KEY: undefined };
        const quoted = await inlineConfig(withOptions("{env:AKM_TEST_OC_TIMEOUT}", '"{env:AKM_TEST_OC_KEY}"'), unset);
        expect(optionsOf(quoted)).toEqual({ timeout: 30000, apiKey: "" });
        expect(warnings).toEqual([]);

        const own = await inlineConfig(undefined);
        expect(await inlineConfig(withOptions("{env:AKM_TEST_OC_KEY}", '"x"'), unset)).toEqual(own);
        expect(warnings.filter((line) => line.includes("OPENCODE_CONFIG_CONTENT is not valid JSONC"))).toHaveLength(1);
      });

      test("a value that would end its string early is escaped, as OpenCode escapes it when the content does not read", async () => {
        const merged = await inlineConfig(withOptions("{env:AKM_TEST_OC_TIMEOUT}", '"{env:AKM_TEST_OC_KEY}"'), {
          AKM_TEST_OC_TIMEOUT: "30000",
          AKM_TEST_OC_KEY: 'SYN"THETIC\\KEY',
        });
        expect(optionsOf(merged)).toEqual({ timeout: 30000, apiKey: 'SYN"THETIC\\KEY' });
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

  test("a binary whose version cannot be read gets OpenCode 1's command for agent and model work, with one warning that says so", async () => {
    _resetWarnOnceForTests();
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    await withOpencodeOnPath(
      "unreadable",
      async () => {
        // An interactive launch takes no flag that depends on the version, so it does not read it.
        build("opencode", {});
        expect(warnings.filter((line) => line.includes("Could not read the version"))).toHaveLength(0);
        const agent = build("opencode", { prompt: PROMPT });
        expect(agent.argv).toEqual(["opencode", "run", "--format", "json"]);
        expect(agent.report).toBe(readOpencode1Run);
        expect(build("opencode", { prompt: PROMPT, modelWork: true }).argv).toEqual([
          "opencode",
          "run",
          "--format",
          "json",
          "--title",
          "akm",
          "--agent",
          "akm-model-work",
        ]);
      },
      { exclusive: true },
    );
    const unreadable = warnings.filter((line) => line.includes("Could not read the version of opencode"));
    expect(unreadable).toHaveLength(1);
    expect(warnings.filter((line) => line.includes("[deprecated]"))).toEqual([]);
    expect(unreadable[0]).toContain("OpenCode 1");
    expect(unreadable[0]).toContain("agent and model work");
    expect(unreadable[0]).toContain("no --standalone");
    expect(unreadable[0]).toContain("`opencode --version`");
  });
});
