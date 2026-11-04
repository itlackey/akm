// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { type ArgsDef, parseArgs } from "citty";
import { agentCommand } from "../src/commands/agent/contribute-cli";
import { improveCommand } from "../src/commands/improve/improve-cli";
import { proposeCommand } from "../src/commands/proposal/propose-cli";
import { taskCommand } from "../src/commands/tasks/tasks-cli";

type StaticCommand = { args?: unknown };

function parseLeaf(command: StaticCommand, rawArgs: string[]) {
  return parseArgs(rawArgs, command.args as ArgsDef) as Record<string, unknown>;
}

const tasksRunCommand = (taskCommand.subCommands as unknown as Record<string, StaticCommand>).run;
if (!tasksRunCommand) throw new Error("tasks run command is not registered");

describe("space-separated global output flags on raw command leaves", () => {
  test("improve consumes the format value instead of treating it as scope", () => {
    const args = parseLeaf(improveCommand, ["--dry-run", "--format", "md"]);

    expect(args["dry-run"]).toBe(true);
    expect(args.format).toBe("md");
    expect(args.scope).toBeUndefined();
  });

  test("proposal new preserves both positionals after the format flag", () => {
    const args = parseLeaf(proposeCommand, ["--format", "yaml", "skill", "foo", "--task", "draft the skill"]);

    expect(args.format).toBe("yaml");
    expect(args.type).toBe("skill");
    expect(args.name).toBe("foo");
  });

  test("agent consumes the format value instead of treating it as the agent ref", () => {
    const args = parseLeaf(agentCommand, ["--format", "md", "--prompt", "review the change"]);

    expect(args.format).toBe("md");
    expect(args["agent-ref"]).toBeUndefined();
    expect(args.prompt).toBe("review the change");
  });

  test("agent parses the opt-in stdin prompt flag", () => {
    const args = parseLeaf(agentCommand, ["--prompt-stdin"]);

    expect(args["prompt-stdin"]).toBe(true);
  });

  test("tasks run consumes the format value instead of treating it as the task id", () => {
    const args = parseLeaf(tasksRunCommand, ["--format", "md", "nightly"]);

    expect(args.format).toBe("md");
    expect(args.id).toBe("nightly");
  });
});
