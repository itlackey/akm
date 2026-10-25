// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeEach, describe, expect, test } from "bun:test";
import { SELECTION_ARGS, selectionFromArgs } from "../../src/cli/selection";
import { agentCommand } from "../../src/commands/agent/contribute-cli";
import { commandRunCommand } from "../../src/commands/command/command-cli";
import { extractCommand } from "../../src/commands/improve/extract-cli";
import { improveCommand } from "../../src/commands/improve/improve-cli";
import { proposeCommand } from "../../src/commands/proposal/propose-cli";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { runCliCapture } from "../_helpers/cli";
import { overrideSeam } from "../_helpers/seams";

describe("selectionFromArgs", () => {
  test("names only what a flag named", () => {
    expect(selectionFromArgs({})).toEqual({});
    expect(selectionFromArgs({ harness: " claude ", model: "fast" })).toEqual({ harness: "claude", model: "fast" });
    expect(selectionFromArgs({ connection: "lab", model: "" })).toEqual({ connection: "lab" });
  });

  test("a connection and a harness together are a usage error", () => {
    expect(() => selectionFromArgs({ connection: "lab", harness: "claude" })).toThrow(
      "--connection and --harness are mutually exclusive",
    );
  });
});

describe("the retired --engine", () => {
  beforeEach(() => _resetWarnOnceForTests());

  test("names a connection or harness like the other flags, with one warning naming what replaces it", () => {
    const warnings: string[] = [];
    overrideSeam(_setWarnSinkForTests, (level, args) => {
      if (level === "warn") warnings.push(args.map(String).join(" "));
    });
    expect(selectionFromArgs({ engine: "lab", model: "fast" })).toEqual({ engine: "lab", model: "fast" });
    selectionFromArgs({ engine: "lab" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--connection");
    expect(warnings[0]).toContain("--harness");
  });
});

describe("the commands that choose where a call runs take the same three flags", () => {
  test.each([
    ["akm agent", agentCommand],
    ["akm command run", commandRunCommand],
    ["akm improve", improveCommand],
    ["akm proposal new", proposeCommand],
    ["akm proposal extract", extractCommand],
  ])("%s", (_name, command) => {
    const args = command.args as Record<string, unknown>;
    for (const flag of Object.keys(SELECTION_ARGS)) expect(args).toHaveProperty(flag);
  });

  test("the commands that had --engine still parse it, and improve is the only one without it", () => {
    for (const command of [agentCommand, commandRunCommand, proposeCommand, extractCommand]) {
      expect(command.args).toHaveProperty("engine", expect.objectContaining({ type: "string", hidden: true }));
    }
    expect(improveCommand.args).not.toHaveProperty("engine");
  });
});

describe("a retired flag is parsed and never advertised", () => {
  test("completions do not suggest one", async () => {
    const { stdout: script } = await runCliCapture(["completions"]);
    expect(script).not.toContain("--engine");
    expect(script).not.toContain("--require-engines");
    expect(script).not.toContain("--require-targets");
  });
});
