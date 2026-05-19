import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { parseTaskDocument } from "../src/tasks/parser";

describe("parseTaskDocument", () => {
  test("workflow target with params", () => {
    const yaml = [
      'schedule: "0 9 * * *"',
      "workflow: workflow:daily-backup",
      "params:",
      "  region: us-east-1",
      "enabled: true",
      "tags: [scheduled, backup]",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/daily.yml", id: "daily" });
    expect(task.id).toBe("daily");
    expect(task.schedule).toBe("0 9 * * *");
    expect(task.enabled).toBe(true);
    expect(task.target.kind).toBe("workflow");
    if (task.target.kind === "workflow") {
      expect(task.target.ref).toBe("workflow:daily-backup");
      expect(task.target.params).toEqual({ region: "us-east-1" });
    }
    expect(task.tags).toEqual(["scheduled", "backup"]);
  });

  test("inline prompt via plain scalar", () => {
    const yaml = ['schedule: "@daily"', "prompt: Summarise today's git activity.", "profile: opencode", ""].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/digest.yml", id: "digest" });
    expect(task.target.kind).toBe("prompt");
    if (task.target.kind === "prompt") {
      expect(task.target.profile).toBe("opencode");
      expect(task.target.source.kind).toBe("inline");
      if (task.target.source.kind === "inline") {
        expect(task.target.source.text).toBe("Summarise today's git activity.");
      }
    }
  });

  test("inline prompt via block scalar (multi-line)", () => {
    const yaml = ['schedule: "@daily"', "prompt: |", "  Line one.", "  Line two.", "profile: opencode", ""].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/digest.yml", id: "digest" });
    if (task.target.kind === "prompt" && task.target.source.kind === "inline") {
      expect(task.target.source.text).toContain("Line one.");
      expect(task.target.source.text).toContain("Line two.");
    } else {
      throw new Error("expected inline prompt target");
    }
  });

  test("asset-ref prompt target", () => {
    const yaml = ['schedule: "0 8 * * 1"', "prompt: agent:standup-bot", "profile: claude"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/standup.yml", id: "standup" });
    if (task.target.kind === "prompt" && task.target.source.kind === "asset") {
      expect(task.target.source.ref).toBe("agent:standup-bot");
    } else {
      throw new Error("expected asset prompt target");
    }
  });

  test("file-path prompt target", () => {
    const yaml = ['schedule: "@hourly"', "prompt: ./prompts/triage.md"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/triage.yml", id: "triage" });
    if (task.target.kind === "prompt" && task.target.source.kind === "file") {
      expect(task.target.source.path).toBe("./prompts/triage.md");
    } else {
      throw new Error("expected file prompt target");
    }
  });

  test("windows absolute prompt path is treated as file on non-windows hosts", () => {
    const yaml = ['schedule: "@hourly"', "prompt: 'C:\\prompts\\triage.md'"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/triage.yml", id: "triage" });
    if (task.target.kind === "prompt" && task.target.source.kind === "file") {
      expect(task.target.source.path).toBe("C:\\prompts\\triage.md");
    } else {
      throw new Error("expected file prompt target");
    }
  });

  test("command target as string", () => {
    const yaml = [
      'schedule: "7 * * * *"',
      "command: akm improve --auto-accept=90 --limit 25",
      "enabled: true",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/akm-improve.yml", id: "akm-improve" });
    expect(task.target.kind).toBe("command");
    if (task.target.kind === "command") {
      expect(task.target.cmd[0]).toBe("akm");
      expect(task.target.cmd).toContain("--auto-accept=90");
    }
  });

  test("rejects task with both workflow and prompt", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:foo", "prompt: do thing"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects task with neither workflow nor prompt nor command", () => {
    const yaml = 'schedule: "@daily"\n';
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects missing schedule", () => {
    const yaml = "workflow: workflow:foo\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects invalid YAML", () => {
    const yaml = "schedule: [unterminated\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("default enabled is true when omitted", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:foo"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(true);
  });

  test("enabled: false honoured", () => {
    const yaml = ['schedule: "@daily"', "workflow: workflow:foo", "enabled: false"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(false);
  });

  test("name and when_to_use fields parsed", () => {
    const yaml = [
      'schedule: "@daily"',
      "workflow: workflow:foo",
      "name: Daily Foo",
      "when_to_use: Run after every business day",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/foo.yml", id: "foo" });
    expect(task.name).toBe("Daily Foo");
    expect(task.when_to_use).toBe("Run after every business day");
  });
});
