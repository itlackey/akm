/**
 * The OpenCode 1 and OpenCode 2 argv adapters (`harnesses/opencode/agent-builder-v{1,2}.ts`), selected by
 * the major the engine's binary reports (a fake `--version` here). Pure argv; the real binaries are in
 * tests/integration/opencode-cli-argv.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { opencodeBuilder } from "../../src/integrations/harnesses/opencode/agent-builder";
import { MODEL_WORK_OPENCODE_AGENT } from "../../src/integrations/harnesses/opencode/model-work-agent";
import { fakeOpencodeMajor } from "../_helpers/opencode-version";

function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name: "opencode",
    bin: "opencode",
    args: ["run"],
    stdio: "captured",
    envPassthrough: [],
    parseOutput: "text",
    ...overrides,
  };
}

/** The argv built for a binary that reports OpenCode `major`. */
function build(major: 1 | 2, overrides: Partial<AgentProfile>, req: Parameters<typeof opencodeBuilder.build>[1]) {
  fakeOpencodeMajor(major);
  return opencodeBuilder.build(profile(overrides), req);
}

describe("opencode adapter selection", () => {
  test("the major the binary reports picks the adapter", () => {
    expect(build(1, {}, { prompt: "p" }).argv).not.toContain("--standalone");
    expect(build(2, {}, { prompt: "p" }).argv).toContain("--standalone");
  });

  test("a binary whose version cannot be read gets the newest adapter (2)", () => {
    fakeOpencodeMajor(() => undefined);
    expect(opencodeBuilder.build(profile(), { prompt: "p" }).argv).toContain("--standalone");
  });
});

describe("opencode 1 adapter", () => {
  test("is the pre-OpenCode-2 argv: no service flag", () => {
    expect(build(1, {}, { prompt: "p" }).argv).toEqual(["opencode", "run", "--", "p"]);
  });

  test("the engine agent default (#1098) reaches --agent, with the model", () => {
    const { argv } = build(1, {}, { prompt: "p", agent: "akm-workflow", model: "a/b" });
    expect(argv).toEqual(["opencode", "run", "--agent", "akm-workflow", "--model", "a/b", "--", "p"]);
  });

  test("model work runs its confined agent and injects the config", () => {
    const cmd = build(1, {}, { prompt: "p", modelWork: true, model: "a/b" });
    expect(cmd.argv).toEqual(["opencode", "run", "--agent", MODEL_WORK_OPENCODE_AGENT, "--model", "a/b", "--", "p"]);
    expect(cmd.argv).not.toContain("--standalone");
    expect(JSON.parse(cmd.env?.OPENCODE_CONFIG_CONTENT ?? "null").agent[MODEL_WORK_OPENCODE_AGENT].mode).toBe(
      "primary",
    );
  });
});

describe("opencode 2 adapter", () => {
  test("runs standalone, so no background service is started or left behind", () => {
    expect(build(2, {}, { prompt: "p" }).argv).toEqual(["opencode", "run", "--standalone", "--", "p"]);
  });

  test("the engine agent default (#1098) reaches --agent, with the model", () => {
    const { argv } = build(2, {}, { prompt: "p", agent: "akm-workflow", model: "a/b#high" });
    expect(argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "akm-workflow",
      "--model",
      "a/b#high",
      "--standalone",
      "--",
      "p",
    ]);
  });

  test("never passes --auto: native approvals stay native", () => {
    for (const request of [{ prompt: "p" }, { prompt: "p", modelWork: true }]) {
      expect(build(2, {}, request).argv).not.toContain("--auto");
    }
  });

  test("does not duplicate --standalone and leaves an operator's --server alone", () => {
    expect(build(2, { args: ["run", "--standalone"] }, { prompt: "p" }).argv).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--",
      "p",
    ]);
    const argv = build(
      2,
      { args: ["run", "--server", "http://h:1"] },
      {
        prompt: "p",
      },
    ).argv;
    expect(argv).toEqual(["opencode", "run", "--server", "http://h:1", "--", "p"]);
  });

  test("a model named by the request replaces the one in the engine's args", () => {
    const argv = build(
      2,
      { args: ["run", "--model", "x/y"] },
      {
        prompt: "p",
        model: "a/b",
      },
    ).argv;
    expect(argv).toEqual(["opencode", "run", "--model", "a/b", "--standalone", "--", "p"]);
  });

  test("model work: standalone, the confined agent, the engine's model, and the injected agent definition", () => {
    const cmd = build(
      2,
      { args: ["run", "--dir", "/x", "--model", "a/b"] },
      {
        prompt: "p",
        modelWork: true,
        inference: { temperature: 0.2 },
      },
    );
    expect(cmd.argv).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--agent",
      MODEL_WORK_OPENCODE_AGENT,
      "--model",
      "a/b",
      "--",
      "p",
    ]);
    const config = JSON.parse(cmd.env?.OPENCODE_CONFIG_CONTENT ?? "null");
    expect(config.agent[MODEL_WORK_OPENCODE_AGENT].options).toEqual({ temperature: 0.2 });
    expect(config.agent[MODEL_WORK_OPENCODE_AGENT].permission).toMatchObject({ "*": "deny", bash: "deny" });
  });

  test("the model-work agent definition is the same for both majors", () => {
    const request = { prompt: "p", modelWork: true, model: "a/b" } as const;
    expect(build(2, {}, request).env).toEqual(build(1, {}, request).env);
  });
});
