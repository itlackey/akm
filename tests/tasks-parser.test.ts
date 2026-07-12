import { describe, expect, test } from "bun:test";
import { UsageError } from "../src/core/errors";
import { parseTaskDocument } from "../src/tasks/parser";

describe("parseTaskDocument", () => {
  test("parses a strict v2 workflow task", () => {
    const yaml = [
      "version: 2",
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
    expect(task.version).toBe(2);
    expect(task.schemaVersion).toBe(2);
    expect(task.schedule).toBe("0 9 * * *");
    expect(task.enabled).toBe(true);
    expect(task.target.kind).toBe("workflow");
    if (task.target.kind === "workflow") {
      expect(task.target.ref).toBe("workflow:daily-backup");
      expect(task.target.params).toEqual({ region: "us-east-1" });
    }
    expect(task.tags).toEqual(["scheduled", "backup"]);
  });

  test("parses prompt engine use including invocation overrides", () => {
    const yaml = [
      "version: 2",
      'schedule: "@daily"',
      "prompt: Summarise today's git activity.",
      "engine: reviewer",
      "model: claude-sonnet",
      "timeoutMs: null",
      "llm:",
      "  temperature: 0.1",
      "  extraParams:",
      "    seed: 7",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/digest.yml", id: "digest" });
    expect(task.target.kind).toBe("prompt");
    if (task.target.kind === "prompt") {
      expect(task.target.engine).toBe("reviewer");
      expect(task.target.model).toBe("claude-sonnet");
      expect(task.target.timeoutMs).toBeNull();
      expect(task.target.llm).toEqual({ temperature: 0.1, extraParams: { seed: 7 } });
      expect(task.target.source.kind).toBe("inline");
      if (task.target.source.kind === "inline") {
        expect(task.target.source.text).toBe("Summarise today's git activity.");
      }
    }
  });

  test("rejects protected and recursively credential-shaped extraParams", () => {
    const parse = (extra: string[]) =>
      parseTaskDocument({
        yaml: ["version: 2", 'schedule: "@daily"', "prompt: Review", "llm:", "  extraParams:", ...extra].join("\n"),
        filePath: "/stash/tasks/review.yml",
        id: "review",
      });
    expect(() => parse(["    response_format: {}"])).toThrow(UsageError);
    expect(() => parse(["    provider:", "      - auth:", "          - API_KEY: leak"])).toThrow(UsageError);
    expect(parse(["    provider:", "      nested:", "        model: allowed"]).target.kind).toBe("prompt");
  });

  test("classifies block scalar, asset, and file prompt sources", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "prompt: |", "  Line one.", "  Line two.", ""].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/digest.yml", id: "digest" });
    if (task.target.kind === "prompt" && task.target.source.kind === "inline") {
      expect(task.target.source.text).toContain("Line one.");
      expect(task.target.source.text).toContain("Line two.");
    } else {
      throw new Error("expected inline prompt target");
    }
    const assetYaml = ["version: 2", 'schedule: "0 8 * * 1"', "prompt: agent:standup-bot"].join("\n");
    const asset = parseTaskDocument({ yaml: assetYaml, filePath: "/stash/tasks/standup.yml", id: "standup" });
    if (asset.target.kind === "prompt" && asset.target.source.kind === "asset") {
      expect(asset.target.source.ref).toBe("agent:standup-bot");
    } else {
      throw new Error("expected asset prompt target");
    }
    const fileYaml = ["version: 2", 'schedule: "@hourly"', "prompt: ./prompts/triage.md"].join("\n");
    const file = parseTaskDocument({ yaml: fileYaml, filePath: "/stash/tasks/triage.yml", id: "triage" });
    if (file.target.kind === "prompt" && file.target.source.kind === "file") {
      expect(file.target.source.path).toBe("./prompts/triage.md");
    } else {
      throw new Error("expected file prompt target");
    }
    const windowsYaml = ["version: 2", 'schedule: "@hourly"', "prompt: 'C:\\prompts\\triage.md'"].join("\n");
    const windows = parseTaskDocument({ yaml: windowsYaml, filePath: "/stash/tasks/triage.yml", id: "triage" });
    if (windows.target.kind === "prompt" && windows.target.source.kind === "file") {
      expect(windows.target.source.path).toBe("C:\\prompts\\triage.md");
    } else {
      throw new Error("expected file prompt target");
    }
  });

  test("parses a command task with timeout", () => {
    const yaml = [
      "version: 2",
      'schedule: "7 * * * *"',
      "command: akm improve --auto-accept=90 --limit 25",
      "enabled: true",
      "timeoutMs: 120000",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/akm-improve.yml", id: "akm-improve" });
    expect(task.target.kind).toBe("command");
    if (task.target.kind === "command") {
      expect(task.target.cmd[0]).toBe("akm");
      expect(task.target.cmd).toContain("--auto-accept=90");
      expect(task.timeoutMs).toBe(120000);
    }
  });

  test("rejects missing or stale v1 versions with the dedicated code", () => {
    for (const yaml of [
      'schedule: "@daily"\ncommand: echo old\n',
      'version: 1\nschedule: "@daily"\ncommand: echo old\n',
    ]) {
      expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(
        "TASK_SCHEMA_VERSION_UNSUPPORTED",
      );
    }
  });

  test("rejects profile and wrong-target fields", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "prompt: do thing", "profile: opencode"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    const workflow = ["version: 2", 'schedule: "@daily"', "workflow: workflow:foo", "timeoutMs: 1"].join("\n");
    expect(() => parseTaskDocument({ yaml: workflow, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects task with neither workflow nor prompt nor command", () => {
    const yaml = 'version: 2\nschedule: "@daily"\n';
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects missing schedule", () => {
    const yaml = "version: 2\nworkflow: workflow:foo\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects invalid YAML", () => {
    const yaml = "version: 2\nschedule: [unterminated\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects unknown keys and non-boolean enabled", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflow:foo", "unknown: true"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    const invalidEnabled = ["version: 2", 'schedule: "@daily"', "workflow: workflow:foo", 'enabled: "true"'].join("\n");
    expect(() => parseTaskDocument({ yaml: invalidEnabled, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(
      UsageError,
    );
  });

  test("defaults enabled to true when omitted", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflow:foo"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(true);
  });

  test("enabled: false honoured", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflow:foo", "enabled: false"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(false);
  });

  test("name and when_to_use fields parsed", () => {
    const yaml = [
      "version: 2",
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
