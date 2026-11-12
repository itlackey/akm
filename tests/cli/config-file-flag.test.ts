import { describe, expect, test } from "bun:test";
import { consumeConfigFileFlag, type FlagScanCommand } from "../../src/cli/unknown-flags";
import { parseTaskInputFlags } from "../../src/commands/tasks/tasks-cli";
import { parseWorkflowParameterFlags } from "../../src/commands/workflow-cli";

const root: FlagScanCommand = {
  args: { config: { type: "string" }, quiet: { type: "boolean", alias: "q" } },
  subCommands: {
    tool: { subCommands: { run: { args: { prompt: { type: "string", alias: "p" } } } } },
  },
};

describe("startup config file flag", () => {
  test.each(
    [
      ["--config", "one.json", "tool", "run"],
      ["tool", "--config=one.json", "run"],
      ["tool", "--config", "one.json", "run"],
      ["tool", "run", "--config", "one.json"],
      ["tool", "run", "--config=old.json", "--config=one.json"],
    ].map((args) => ({ args })),
  )("selects the last config file across command levels: %j", ({ args }) => {
    expect(consumeConfigFileFlag(root, args)).toEqual({ file: "one.json", args: ["tool", "run"] });
  });

  test.each(
    [
      ["tool", "run", "--prompt", "--config", "ignored.json"],
      ["tool", "run", "-p", "--config", "ignored.json"],
      ["tool", "run", "-qp", "--config", "ignored.json"],
      ["tool", "run", "--input=--config"],
      ["tool", "run", "--", "--config", "ignored.json"],
      ["tool", "run", "--prompt=--config"],
    ].map((args) => ({ args })),
  )("leaves literal values and passthrough alone: %j", ({ args }) => {
    expect(consumeConfigFileFlag(root, args)).toEqual({ file: undefined, args });
  });

  test("dynamic commands retain their config input after command selection", () => {
    const dynamic: FlagScanCommand = {
      args: root.args,
      subCommands: { task: { subCommands: { run: {}, explain: {} } }, workflow: { subCommands: { run: {} } }, run: {} },
    };
    for (const command of [["task", "run"], ["task", "explain"], ["workflow", "run"], ["run"]]) {
      expect(consumeConfigFileFlag(dynamic, [...command, "ref", "--config", "input.json"])).toEqual({
        file: undefined,
        args: [...command, "ref", "--config", "input.json"],
      });
      expect(
        consumeConfigFileFlag(dynamic, ["--config", "selected.json", ...command, "ref", "--config", "input.json"]),
      ).toEqual({ file: "selected.json", args: [...command, "ref", "--config", "input.json"] });
    }
  });

  test("inherited arity identifies dynamic paths across intermediate group flags", () => {
    const dynamic: FlagScanCommand = {
      args: { ...root.args, format: { type: "string" } },
      subCommands: { task: { subCommands: { run: {}, explain: {} } }, workflow: { subCommands: { run: {} } } },
    };
    for (const command of [
      ["task", "run"],
      ["task", "explain"],
      ["workflow", "run"],
    ]) {
      const [group, leaf] = command;
      for (const prefix of [
        ["--config", "misplaced.json"],
        ["--format", "json"],
      ]) {
        const args = [group!, ...prefix, leaf!, "ref", "--config", "input.json"];
        expect(consumeConfigFileFlag(dynamic, args)).toEqual({ file: undefined, args });
        expect(consumeConfigFileFlag(dynamic, ["--config", "selected.json", ...args])).toEqual({
          file: "selected.json",
          args,
        });
      }
    }
  });

  test("consumption preserves literal flag values and child args alongside a selector", () => {
    const args = ["tool", "run", "--prompt", "--config", "--config", "one.json", "--", "--config", "child.json"];
    expect(consumeConfigFileFlag(root, args)).toEqual({
      file: "one.json",
      args: ["tool", "run", "--prompt", "--config", "--", "--config", "child.json"],
    });
  });

  test("legacy named config inputs preserve boolean and literal values", () => {
    for (const parse of [parseTaskInputFlags, parseWorkflowParameterFlags]) {
      expect(parse(["ref", "--config"], "ref")).toEqual([{ name: "config", value: true }]);
      expect(parse(["ref", "--config", "settings.json"], "ref")).toEqual([{ name: "config", value: "settings.json" }]);
      expect(parse(["ref", "--config=--config"], "ref")).toEqual([{ name: "config", value: "--config" }]);
    }
  });

  test.each(
    [["--config"], ["--config="], ["--config", " "], ["--config", "--quiet"]].map((args) => ({ args })),
  )("rejects a missing or empty config path: %j", ({ args }) =>
    expect(() => consumeConfigFileFlag(root, args)).toThrow("--config requires a non-empty file path"));
});
