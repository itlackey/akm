import { describe, expect, test } from "bun:test";
import graphRefreshWeekly from "../src/assets/tasks/improve/akm-graph-refresh-weekly.yml" with { type: "text" };
import { UsageError } from "../src/core/errors";
import { parseTaskDocument } from "../src/tasks/parser";

describe("parseTaskDocument", () => {
  test("bundled graph refresh task is strict v2 and uses the strategy CLI", () => {
    const task = parseTaskDocument({
      yaml: graphRefreshWeekly,
      filePath: "/bundle/tasks/akm-graph-refresh-weekly.yml",
      id: "akm-graph-refresh-weekly",
    });
    expect(task.version).toBe(2);
    // `--skip-if-locked` is load-bearing: without it a weekly full rebuild
    // colliding with a running improve is recorded as a task failure.
    expect(task.target).toEqual({
      kind: "command",
      cmd: ["akm", "improve", "--strategy", "graph-refresh", "--skip-if-locked"],
    });
  });

  test("parses a strict v2 workflow task", () => {
    const yaml = [
      "version: 2",
      'schedule: "0 9 * * *"',
      "workflow: workflows/daily-backup",
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
      expect(task.target.ref).toBe("workflows/daily-backup");
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
    const assetYaml = ["version: 2", 'schedule: "0 8 * * 1"', "prompt: agents/standup-bot"].join("\n");
    const asset = parseTaskDocument({ yaml: assetYaml, filePath: "/stash/tasks/standup.yml", id: "standup" });
    if (asset.target.kind === "prompt" && asset.target.source.kind === "asset") {
      expect(asset.target.source.ref).toBe("agents/standup-bot");
    } else {
      throw new Error("expected asset prompt target");
    }
    // A bundle-qualified canonical ref is also recognized as an asset source.
    const qualifiedYaml = ["version: 2", 'schedule: "0 8 * * 1"', "prompt: core//commands/release"].join("\n");
    const qualified = parseTaskDocument({ yaml: qualifiedYaml, filePath: "/stash/tasks/rel.yml", id: "rel" });
    if (qualified.target.kind === "prompt" && qualified.target.source.kind === "asset") {
      expect(qualified.target.source.ref).toBe("core//commands/release");
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

  test("treats colon text as an inline prompt rather than a ref", () => {
    const yaml = ["version: 2", 'schedule: "0 8 * * 1"', "prompt: skill:code-review"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.target).toMatchObject({ kind: "prompt", source: { kind: "inline", text: "skill:code-review" } });
  });

  test("a bare `word/word` prompt with no known stash subdir stays inline text", () => {
    const yaml = ["version: 2", 'schedule: "0 8 * * 1"', "prompt: projectA/some-note"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    if (task.target.kind === "prompt" && task.target.source.kind === "inline") {
      expect(task.target.source.text).toBe("projectA/some-note");
    } else {
      throw new Error("expected inline prompt target");
    }
  });

  test("parses a command task with timeout", () => {
    const yaml = [
      "version: 2",
      'schedule: "7 * * * *"',
      "command: akm improve --strategy quick --limit 25",
      "enabled: true",
      "timeoutMs: 120000",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/akm-improve.yml", id: "akm-improve" });
    expect(task.target.kind).toBe("command");
    if (task.target.kind === "command") {
      expect(task.target.cmd[0]).toBe("akm");
      expect(task.target.cmd).toContain("quick");
      expect(task.timeoutMs).toBe(120000);
    }
  });

  test("preserves command arguments without rewriting removed CLI spellings", () => {
    const command = ["akm", "improve", "--profile", "user-defined-argument"];
    const task = parseTaskDocument({
      yaml: ["version: 2", 'schedule: "@daily"', `command: ${JSON.stringify(command)}`].join("\n"),
      filePath: "/stash/tasks/x.yml",
      id: "x",
    });

    expect(task.target).toEqual({ kind: "command", cmd: command });
  });

  test.each([undefined, 1])("rejects task schema version %s without normalization", (version) => {
    const yaml = [
      ...(version === undefined ? [] : [`version: ${version}`]),
      'schedule: "@daily"',
      "prompt: Review this",
      "profile: opencode",
    ].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/prompt.yml", id: "prompt" })).toThrow(
      "TASK_SCHEMA_VERSION_UNSUPPORTED",
    );
  });

  test("rejects permissive scalar forms under the current schema", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "command: echo x", "timeoutMs: 1.5"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(
      'Key "timeoutMs" must be an integer from 1 through 2147483647, or null',
    );
  });

  test("rejects unknown future task schema versions", () => {
    const yaml = 'version: 3\nschedule: "@daily"\ncommand: echo future\n';
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(
      "TASK_SCHEMA_VERSION_UNSUPPORTED",
    );
  });

  test("rejects profile and wrong-target fields", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "prompt: do thing", "profile: opencode"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    // A workflow's engines come from its frozen plan, so `engine` stays
    // prompt-only. (`timeoutMs` is NOT in this list any more — issue 11 gave
    // workflow tasks a whole-run timeout; see the run-bound tests below.)
    const workflow = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", "engine: reviewer"].join("\n");
    expect(() => parseTaskDocument({ yaml: workflow, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  // ── issue 11: workflow-task run bounds ────────────────────────────────────
  //
  // A scheduled workflow task used to reach `runWorkflowSteps` with no signal,
  // no maxSteps and no maxRetries, so an unattended run could hang forever.
  // The task file now declares the same three bounds `akm workflow run` takes
  // as flags; the runner turns `timeoutMs` into the abort signal.

  test("parses workflow-task run bounds (timeoutMs / maxSteps / maxRetries)", () => {
    const yaml = [
      "version: 2",
      'schedule: "@daily"',
      "workflow: workflows/daily-backup",
      "timeoutMs: 900000",
      "maxSteps: 12",
      "maxRetries: 2",
      "",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.target).toEqual({
      kind: "workflow",
      ref: "workflows/daily-backup",
      params: {},
      timeoutMs: 900000,
      maxSteps: 12,
      maxRetries: 2,
    });
    // The document-level `timeoutMs` stays the command-target field; a workflow
    // task's whole-run bound lives on its target.
    expect(task.timeoutMs).toBeUndefined();
  });

  test("keeps `timeoutMs: null` expressible as the workflow no-timeout opt-out", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", "timeoutMs: null", ""].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.target.kind === "workflow" && task.target.timeoutMs).toBeNull();
  });

  test("omits the run bounds when the workflow task declares none", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", ""].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    // Absent, not null: the runner distinguishes "take the default" from the
    // explicit `null` opt-out.
    expect(task.target).toEqual({ kind: "workflow", ref: "workflows/foo", params: {} });
  });

  test("rejects out-of-range workflow run bounds and overflowing timeouts", () => {
    const cases = [
      "maxSteps: 0",
      "maxSteps: 1.5",
      "maxRetries: -1",
      "maxRetries: 101",
      `timeoutMs: ${2 ** 31}`,
      "timeoutMs: 0",
    ];
    for (const bound of cases) {
      const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", bound].join("\n");
      expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    }
  });

  test("keeps maxSteps / maxRetries off prompt and command targets", () => {
    const prompt = ["version: 2", 'schedule: "@daily"', "prompt: do thing", "maxSteps: 3"].join("\n");
    expect(() => parseTaskDocument({ yaml: prompt, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    const command = ["version: 2", 'schedule: "@daily"', "command: echo hi", "maxRetries: 1"].join("\n");
    expect(() => parseTaskDocument({ yaml: command, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects task with neither workflow nor prompt nor command", () => {
    const yaml = 'version: 2\nschedule: "@daily"\n';
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects missing schedule", () => {
    const yaml = "version: 2\nworkflow: workflows/foo\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects invalid YAML", () => {
    const yaml = "version: 2\nschedule: [unterminated\n";
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
  });

  test("rejects filesystem-derived ids that the CLI would reject", () => {
    const yaml = 'version: 2\nschedule: "@daily"\ncommand: echo unsafe\n';
    try {
      parseTaskDocument({ yaml, filePath: "/stash/tasks/manual task.yml", id: "manual task" });
      throw new Error("expected invalid task id rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
      expect((err as Error).message).toContain('Task id "manual task" is invalid');
    }
  });

  test.each([
    ["daily.yaml", "bare task id"],
    ["CoM1.backup", "reserved Windows device name"],
  ])("rejects non-portable filesystem-derived id %s", (id, message) => {
    const yaml = 'version: 2\nschedule: "@daily"\ncommand: echo unsafe\n';
    try {
      parseTaskDocument({ yaml, filePath: `/stash/tasks/${id}.yml`, id });
      throw new Error("expected invalid task id rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).code).toBe("INVALID_FLAG_VALUE");
      expect((err as Error).message).toContain(message);
    }
  });

  test("rejects unknown keys and non-boolean enabled", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", "unknown: true"].join("\n");
    expect(() => parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(UsageError);
    const invalidEnabled = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", 'enabled: "true"'].join(
      "\n",
    );
    expect(() => parseTaskDocument({ yaml: invalidEnabled, filePath: "/stash/tasks/x.yml", id: "x" })).toThrow(
      UsageError,
    );
  });

  test("defaults enabled to true when omitted", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(true);
  });

  test("enabled: false honoured", () => {
    const yaml = ["version: 2", 'schedule: "@daily"', "workflow: workflows/foo", "enabled: false"].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/x.yml", id: "x" });
    expect(task.enabled).toBe(false);
  });

  test("name and when_to_use fields parsed", () => {
    const yaml = [
      "version: 2",
      'schedule: "@daily"',
      "workflow: workflows/foo",
      "name: Daily Foo",
      "when_to_use: Run after every business day",
    ].join("\n");
    const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/foo.yml", id: "foo" });
    expect(task.name).toBe("Daily Foo");
    expect(task.when_to_use).toBe("Run after every business day");
  });
});
