// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { SELECTION_ARGS, selectionFromArgs } from "../../src/cli/selection";
import { agentCommand } from "../../src/commands/agent/contribute-cli";
import { commandRunCommand } from "../../src/commands/command/command-cli";
import { extractCommand } from "../../src/commands/improve/extract-cli";
import { improveCommand } from "../../src/commands/improve/improve-cli";
import { proposeCommand } from "../../src/commands/proposal/propose-cli";

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

describe("the commands that choose where a call runs take the same three flags and no --engine", () => {
  test.each([
    ["akm agent", agentCommand],
    ["akm command run", commandRunCommand],
    ["akm improve", improveCommand],
    ["akm proposal new", proposeCommand],
    ["akm proposal extract", extractCommand],
  ])("%s", (_name, command) => {
    const args = command.args as Record<string, unknown>;
    for (const flag of Object.keys(SELECTION_ARGS)) expect(args).toHaveProperty(flag);
    expect(args).not.toHaveProperty("engine");
  });
});
