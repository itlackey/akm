import { describe, expect, test } from "bun:test";
import { parseTaskDocument } from "../../src/tasks/parser";

function parse(yaml: string) {
  return parseTaskDocument({ yaml: `version: 2\n${yaml}`, filePath: "/stash/tasks/t.yml", id: "t" });
}

describe("parseTaskDocument v2 prompt source classification", () => {
  test("classifies relative, absolute, asset, and inline prompt sources", () => {
    for (const [prompt, kind] of [
      ["../shared/p.md", "file"],
      ["/abs/prompts/p.md", "file"],
      ["agent:standup", "asset"],
      ["Summarise this: and that", "inline"],
    ] as const) {
      const task = parse(`schedule: "@daily"\nprompt: "${prompt}"`);
      expect(task.target.kind).toBe("prompt");
      if (task.target.kind === "prompt") expect(task.target.source.kind).toBe(kind);
    }
  });

  test("preserves command argv boundaries and workflow mappings", () => {
    const command = parse('schedule: "@daily"\ncommand: [akm, improve, "--limit 25"]\ntimeoutMs: 60000');
    expect(command.target).toEqual({ kind: "command", cmd: ["akm", "improve", "--limit 25"] });
    expect(command.timeoutMs).toBe(60000);

    const workflow = parse('schedule: "@daily"\nworkflow: workflow:wf\nparams:\n  region: us-east-1');
    expect(workflow.target).toEqual({ kind: "workflow", ref: "workflow:wf", params: { region: "us-east-1" } });
  });

  test("rejects old coercions and wrong target fields", () => {
    expect(() => parse('schedule: "@daily"\nprompt: hi\ntimeoutMs: 0')).toThrow("positive integer or null");
    expect(() => parse('schedule: "@daily"\nworkflow: workflow:wf\nparams: "{}"')).toThrow("must be a mapping");
    expect(() => parse('schedule: "@daily"\ncommand: echo hi\nengine: fast')).toThrow("not valid for this target");
  });
});
