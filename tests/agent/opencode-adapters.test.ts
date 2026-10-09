/**
 * The OpenCode 1 and OpenCode 2 argv adapters (`harnesses/opencode/agent-builder-v{1,2}.ts`), selected by
 * `profile.opencodeVersion ?? DEFAULT_OPENCODE_VERSION`. Pure argv; the real binaries are in
 * tests/integration/opencode-cli-argv.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { type AgentProfile, DEFAULT_OPENCODE_VERSION } from "../../src/integrations/agent/profiles";
import { opencodeBuilder } from "../../src/integrations/harnesses/opencode/agent-builder";
import { MODEL_WORK_OPENCODE_AGENT } from "../../src/integrations/harnesses/opencode/model-work-agent";

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

const V1 = { opencodeVersion: 1 } as const;
const V2 = { opencodeVersion: 2 } as const;

describe("opencode adapter selection", () => {
  test("an engine that sets no opencodeVersion gets the default major (2)", () => {
    expect(DEFAULT_OPENCODE_VERSION).toBe(2);
    const argv = opencodeBuilder.build(profile(), { prompt: "p" }).argv;
    expect(argv).toEqual(opencodeBuilder.build(profile(V2), { prompt: "p" }).argv);
    expect(argv).toContain("--standalone");
  });
});

describe("opencode 1 adapter", () => {
  test("is the pre-OpenCode-2 argv: no service flag", () => {
    expect(opencodeBuilder.build(profile(V1), { prompt: "p" }).argv).toEqual(["opencode", "run", "--", "p"]);
  });

  test("the engine agent default (#1098) reaches --agent, with the model", () => {
    const { argv } = opencodeBuilder.build(profile(V1), { prompt: "p", agent: "akm-workflow", model: "a/b" });
    expect(argv).toEqual(["opencode", "run", "--agent", "akm-workflow", "--model", "a/b", "--", "p"]);
  });

  test("model work runs its confined agent and injects the config", () => {
    const cmd = opencodeBuilder.build(profile(V1), { prompt: "p", modelWork: true, model: "a/b" });
    expect(cmd.argv).toEqual(["opencode", "run", "--agent", MODEL_WORK_OPENCODE_AGENT, "--model", "a/b", "--", "p"]);
    expect(cmd.argv).not.toContain("--standalone");
    expect(JSON.parse(cmd.env?.OPENCODE_CONFIG_CONTENT ?? "null").agent[MODEL_WORK_OPENCODE_AGENT].mode).toBe(
      "primary",
    );
  });
});

describe("opencode 2 adapter", () => {
  test("runs standalone, so no background service is started or left behind", () => {
    expect(opencodeBuilder.build(profile(V2), { prompt: "p" }).argv).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--",
      "p",
    ]);
  });

  test("the engine agent default (#1098) reaches --agent, with the model", () => {
    const { argv } = opencodeBuilder.build(profile(V2), { prompt: "p", agent: "akm-workflow", model: "a/b#high" });
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
      expect(opencodeBuilder.build(profile(V2), request).argv).not.toContain("--auto");
    }
  });

  test("does not duplicate --standalone and leaves an operator's --server alone", () => {
    expect(opencodeBuilder.build(profile({ ...V2, args: ["run", "--standalone"] }), { prompt: "p" }).argv).toEqual([
      "opencode",
      "run",
      "--standalone",
      "--",
      "p",
    ]);
    const argv = opencodeBuilder.build(profile({ ...V2, args: ["run", "--server", "http://h:1"] }), {
      prompt: "p",
    }).argv;
    expect(argv).toEqual(["opencode", "run", "--server", "http://h:1", "--", "p"]);
  });

  test("a model named by the request replaces the one in the engine's args", () => {
    const argv = opencodeBuilder.build(profile({ ...V2, args: ["run", "--model", "x/y"] }), {
      prompt: "p",
      model: "a/b",
    }).argv;
    expect(argv).toEqual(["opencode", "run", "--model", "a/b", "--standalone", "--", "p"]);
  });

  test("model work: standalone, the confined agent, the engine's model, and the injected agent definition", () => {
    const cmd = opencodeBuilder.build(profile({ ...V2, args: ["run", "--dir", "/x", "--model", "a/b"] }), {
      prompt: "p",
      modelWork: true,
      inference: { temperature: 0.2 },
    });
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
    expect(opencodeBuilder.build(profile(V2), request).env).toEqual(opencodeBuilder.build(profile(V1), request).env);
  });
});
