// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The OpenCode 1 CLI builder (`harnesses/opencode/agent-builder.ts`, #1244):
 * the legacy `opencode run` harness. The binary's major comes from a fake
 * `--version` here.
 */

import { describe, expect, test } from "bun:test";
import type { AgentProfile } from "../../src/integrations/agent/profiles";
import { opencodeBuilder } from "../../src/integrations/harnesses/opencode/agent-builder";
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

function build(major: 1 | 2, overrides: Partial<AgentProfile>, req: Parameters<typeof opencodeBuilder.build>[1]) {
  fakeOpencodeMajor(major);
  return opencodeBuilder.build(profile(overrides), req);
}

describe("opencode (OpenCode 1 CLI) builder", () => {
  test("sends the prompt on stdin, verbatim, and keeps it out of argv", () => {
    const prompt = '-x Reply with {"a": "b c"}';
    const built = build(1, {}, { prompt });
    expect(built.argv).toEqual(["opencode", "run"]);
    expect(built.stdin).toBe(prompt);
  });

  test("the engine agent default (#1098) reaches --agent, with the model", () => {
    expect(build(1, {}, { prompt: "p", agent: "planner", model: "lab/m" }).argv).toEqual([
      "opencode",
      "run",
      "--agent",
      "planner",
      "--model",
      "lab/m",
    ]);
  });

  test("a model named by the request replaces the one in the engine's args", () => {
    const argv = build(
      1,
      { args: ["run", "--model", "old/m", "--model=older/m"] },
      { prompt: "p", model: "new/m" },
    ).argv;
    expect(argv).toEqual(["opencode", "run", "--model", "new/m"]);
  });

  test("refuses an OpenCode 2 binary, saying OpenCode 2 runs embedded in akm", () => {
    expect(() => build(2, {}, { prompt: "p" })).toThrow(/OpenCode 2 runs embedded in akm/);
  });

  test("a binary whose version cannot be read is run as given", () => {
    fakeOpencodeMajor(() => undefined);
    expect(opencodeBuilder.build(profile(), { prompt: "p" }).argv).toEqual(["opencode", "run"]);
  });
});
