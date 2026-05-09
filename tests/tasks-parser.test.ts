import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { parseTaskDocument } from "../src/tasks/parser";

describe("parseTaskDocument", () => {
  test("workflow target with params", () => {
    const md = [
      "---",
      'schedule: "0 9 * * *"',
      "workflow: workflow:daily-backup",
      "params:",
      "  region: us-east-1",
      "enabled: true",
      "tags: [scheduled, backup]",
      "---",
      "",
      "# Task: Daily backup",
      "",
    ].join("\n");
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/daily.md", id: "daily" });
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

  test("inline prompt target uses the body", () => {
    const md = [
      "---",
      'schedule: "@daily"',
      "prompt: inline",
      "profile: opencode",
      "---",
      "",
      "Summarise today's git activity.",
      "",
    ].join("\n");
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/digest.md", id: "digest" });
    expect(task.target.kind).toBe("prompt");
    if (task.target.kind === "prompt") {
      expect(task.target.profile).toBe("opencode");
      expect(task.target.source.kind).toBe("inline");
      if (task.target.source.kind === "inline") {
        expect(task.target.source.text).toBe("Summarise today's git activity.");
      }
    }
  });

  test("asset-ref prompt target", () => {
    const md = ["---", 'schedule: "0 8 * * 1"', "prompt: agent:standup-bot", "profile: claude", "---"].join("\n");
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/standup.md", id: "standup" });
    if (task.target.kind === "prompt" && task.target.source.kind === "asset") {
      expect(task.target.source.ref).toBe("agent:standup-bot");
    } else {
      throw new Error("expected asset prompt target");
    }
  });

  test("file-path prompt target", () => {
    const md = ["---", 'schedule: "@hourly"', "prompt: ./prompts/triage.md", "---"].join("\n");
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/triage.md", id: "triage" });
    if (task.target.kind === "prompt" && task.target.source.kind === "file") {
      expect(task.target.source.path).toBe("./prompts/triage.md");
    } else {
      throw new Error("expected file prompt target");
    }
  });

  test("rejects task with both workflow and prompt", () => {
    const md = ["---", 'schedule: "@daily"', "workflow: workflow:foo", "prompt: inline", "---", "", "body", ""].join(
      "\n",
    );
    expect(() => parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" })).toThrow(UsageError);
  });

  test("rejects task with neither workflow nor prompt", () => {
    const md = ["---", 'schedule: "@daily"', "---"].join("\n");
    expect(() => parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" })).toThrow(UsageError);
  });

  test("rejects missing schedule", () => {
    const md = ["---", "workflow: workflow:foo", "---"].join("\n");
    expect(() => parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" })).toThrow(UsageError);
  });

  test("rejects prompt: inline with empty body", () => {
    const md = ["---", 'schedule: "@daily"', "prompt: inline", "---", ""].join("\n");
    expect(() => parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" })).toThrow(UsageError);
  });

  test("default enabled is true when omitted", () => {
    const md = ["---", 'schedule: "@daily"', "workflow: workflow:foo", "---", "", "body", ""].join("\n");
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" });
    expect(task.enabled).toBe(true);
  });

  test("enabled: false honored", () => {
    const md = ["---", 'schedule: "@daily"', "workflow: workflow:foo", "enabled: false", "---", "", "body", ""].join(
      "\n",
    );
    const task = parseTaskDocument({ markdown: md, filePath: "/stash/tasks/x.md", id: "x" });
    expect(task.enabled).toBe(false);
  });
});
