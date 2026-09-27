import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { openLogsDatabase, queryTaskLogs } from "../src/core/logs-db";
import type { SpawnFn } from "../src/core/subprocess";
import { runTask } from "../src/tasks/run/run-task";
import { readTaskHistory } from "../src/tasks/run/task-history";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "./_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function logFiles(): string[] {
  const root = path.join(storage.cacheDir, "akm", "tasks", "logs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true }).map(String);
}

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function completedSpawn(exitCode: number): ReturnType<SpawnFn> {
  return {
    exitCode,
    exited: Promise.resolve(exitCode),
    stdout: closedStream(),
    stderr: closedStream(),
    stdin: null,
    kill() {},
  };
}

function outputSpawn(stdout: string, stderr = ""): ReturnType<SpawnFn> {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return {
    exitCode: 0,
    exited: Promise.resolve(0),
    stdout: stream(stdout),
    stderr: stream(stderr),
    stdin: null,
    kill() {},
  };
}

describe("task runner mutation boundary", () => {
  for (const [label, yaml, message] of [
    ["v2", 'version: 2\nschedule: "@daily"\ncommand: echo legacy\n', "TASK_SCHEMA_VERSION_UNSUPPORTED"],
    // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2, row B-14, F-A2.5):
    // task source v3 is retired from `src` — a version: 3 document now fails
    // the SAME way a version: 2 document does, with the SAME migrate hint
    // (row B-15).
    ["v3", 'version: 3\nrun: echo legacy\nschedule: "@daily"\n', "TASK_SCHEMA_VERSION_UNSUPPORTED"],
    // P4 (spec §3.2.2, row B-17): the bounded YAML front end's sourceLabel is
    // "task source" now, not "task v3 source".
    ["malformed", 'version: 4\nrun: [unterminated\nschedule: "@daily"\n', "Invalid task source"],
    // P4 FLIP (docs/plans/specs/p4-deletions-closeout.md §3.1, row B-04,
    // F-A1.14): the locator grammar is deleted from classifyTaskSourceV4Uses,
    // so a github-action-shaped uses: fails at PARSE with task source v4's
    // own B-11 message, not the old prepare-side "remote action acquisition
    // is unsupported" arm.
    [
      "remote action",
      'version: 4\nuses: actions/checkout@v4\nschedule: "@daily"\n',
      "GitHub Action targets were removed",
    ],
    ["unresolved", 'version: 4\nuses: scripts/missing.sh\nschedule: "@daily"\n', "not found"],
    [
      "nonprojectable command parameters",
      'version: 4\nuses: commands/missing\nwith:\n  value: no\nschedule: "@daily"\n',
      "with is legal only with",
    ],
    [
      "secret-shaped literal env",
      'version: 4\nrun: printf no\nenv:\n  API_TOKEN: github_pat_012345678901234567890123456789\nschedule: "@daily"\n',
      "secret-shaped literal env",
    ],
    [
      "unresolved engine",
      'version: 4\nuses: akm/command\nwith:\n  content: Review\nengine: missing\nschedule: "@daily"\n',
      "missing",
    ],
  ] as const) {
    test(`${label} source fails before any history or log mutation`, async () => {
      writeTask("blocked", yaml);
      let failure: unknown;
      try {
        await runTask("blocked", { bundleDir: storage.stashDir, bundleName: "fixture", scheduled: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(message);
      if (label === "v2" || label === "v3") {
        expect((failure as Error & { hint(): string }).hint()).toContain(
          "Review the file and resolve the ambiguity by hand",
        );
      }
      expect(readTaskHistory({ id: "blocked" })).toEqual([]);
      expect(logFiles()).toEqual([]);
    });
  }

  test("a post-dispatch nonzero shell result records exactly one failed attempt", async () => {
    writeTask("fails", 'version: 4\nrun: exit 7\nshell: sh\nschedule: "@daily"\n');
    const result = await runTask("fails", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
    });
    // D8 (spec docs/plans/specs/p1b-model-extraction.md §5.3, §6 F-2):
    // corollary of the authorized result-vocabulary flip — a shell dispatch
    // now reports "shell", not the former shared "command" string. This is
    // the one necessary follow-on edit G-1's stashDir->bundleDir rename does
    // not itself cover; every other line in this file's diff is that
    // mechanical substitution.
    expect(result).toMatchObject({ status: "failed", target: { kind: "shell" }, detail: { exitCode: 7 } });
    expect(readTaskHistory({ id: "fails" })).toHaveLength(1);
    expect(logFiles().some((file) => file.endsWith(".log"))).toBe(true);
  });

  test("a multi-job workflow target fails the 0.9.2 runtime boundary before attempt reservation", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "multi.yml"),
      [
        "name: Multi",
        "on:",
        "  workflow_dispatch: {}",
        "jobs:",
        "  first:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: one",
        "        run: echo one",
        "  second:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: two",
        "        run: echo two",
        "",
      ].join("\n"),
    );
    // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, F-A2.5): the
    // wrapping task fixture converts to task source v4 — task source version
    // is orthogonal to this rejection, which fires at workflow compilation.
    // FLIPPED in P4 (§3.3, row B-34, F-A3.5): the rejection now fires at
    // PARSE (multi-job-unsupported), not at compileWorkflowPlan's deleted
    // "exactly one source-IR job" check — this document never reaches it.
    writeTask("multi", 'version: 4\nuses: workflows/multi\nschedule: "@daily"\n');

    await expect(
      runTask("multi", { bundleDir: storage.stashDir, bundleName: "fixture", scheduled: true }),
    ).rejects.toThrow(/requires exactly one job/i);
    expect(readTaskHistory({ id: "multi" })).toEqual([]);
    expect(logFiles()).toEqual([]);
  });

  test("unsupported workflow services fail before attempt reservation", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "services.yml"),
      [
        "name: Services",
        "on:",
        "  workflow_dispatch: {}",
        "jobs:",
        "  only:",
        "    runs-on: [self-hosted]",
        "    services:",
        "      database:",
        "        image: postgres:latest",
        "    steps:",
        "      - id: one",
        "        run: echo one",
        "",
      ].join("\n"),
    );
    writeTask("services", 'version: 4\nuses: workflows/services\nschedule: "@daily"\n');

    await expect(
      runTask("services", { bundleDir: storage.stashDir, bundleName: "fixture", scheduled: true }),
    ).rejects.toThrow(/services/i);
    expect(readTaskHistory({ id: "services" })).toEqual([]);
    expect(logFiles()).toEqual([]);
  });

  test("workflow task env: is dropped (with a warning) and the workflow still dispatches", async () => {
    const workflowsDir = path.join(storage.stashDir, "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "env-target.yml"),
      [
        "name: Env target",
        "on: { workflow_dispatch: null }",
        "jobs:",
        "  main:",
        "    runs-on: [self-hosted]",
        "    steps:",
        "      - id: run",
        "        run: echo ok",
        "",
      ].join("\n"),
    );
    writeTask(
      "workflow-env",
      [
        "version: 4",
        "uses: workflows/env-target",
        "env:",
        "  TASK_LOCAL_VALUE: ordinary-local-value",
        'schedule: "@daily"',
        "",
      ].join("\n"),
    );
    let dispatched = false;

    const result = await runTask("workflow-env", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => {
        dispatched = true;
        return {
          run: {
            id: "run-workflow-env",
            workflowRef: target,
            workflowTitle: "Env target",
            status: "completed" as const,
            params,
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            completedAt: "2025-01-01T00:00:00Z",
            currentStepId: null,
          },
          executed: [],
        };
      }) as never,
    });

    expect(dispatched).toBe(true);
    expect(result.status).toBe("completed");
    expect(readTaskHistory({ id: "workflow-env" })).toHaveLength(1);
  });

  test("a bundle-qualified script resolves from the named configured bundle", async () => {
    const shared = path.join(storage.root, "shared-bundle");
    fs.mkdirSync(path.join(shared, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(shared, "scripts", "ok.sh"), "#!/bin/sh\nprintf qualified\n");
    writeSandboxConfig({
      bundles: {
        fixture: { path: storage.stashDir, writable: true },
        shared: { path: shared, writable: false },
      },
      defaultBundle: "fixture",
      semanticSearchMode: "off",
    });
    writeTask("qualified", 'version: 4\nuses: shared//scripts/ok.sh\nschedule: "@daily"\n');

    const result = await runTask("qualified", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
    });
    // D8 (spec §5.3, §6 F-2) corollary — a script dispatch now reports
    // "script", not the former shared "command" string. See the comment at
    // this file's other vocabulary-corollary edit.
    expect(result).toMatchObject({ status: "completed", target: { kind: "script" } });
    expect(fs.readFileSync(result.log, "utf8")).toContain("qualified");
    expect(readTaskHistory({ id: "qualified" })).toHaveLength(1);
  });

  test("run dispatch preserves the exact authored shell string, cwd, and scalar env", async () => {
    fs.mkdirSync(path.join(storage.stashDir, "work"));
    const command = `printf '%s' "a b"`;
    writeTask(
      "exact-shell",
      [
        "version: 4",
        `run: ${JSON.stringify(command)}`,
        "shell: zsh",
        "working-directory: work",
        "env:",
        "  COUNT: 0",
        "  ENABLED: false",
        'schedule: "@daily"',
        "",
      ].join("\n"),
    );
    let observed: { cmd: string[]; cwd?: string; env?: Record<string, string> } | undefined;
    const spawnFn: SpawnFn = (cmd, options) => {
      observed = { cmd, cwd: options.cwd, env: options.env };
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        stdin: null,
        kill() {},
      };
    };

    const result = await runTask("exact-shell", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn,
    });
    expect(result.status).toBe("completed");
    expect(observed?.cmd).toEqual(["zsh", "-c", command]);
    expect(observed?.cwd).toBe(path.join(storage.stashDir, "work"));
    expect(observed?.env).toMatchObject({ COUNT: "0", ENABLED: "false", AKM_EVENT_SOURCE: "task" });
  });

  test("akm.redact resolves a declared name from prepared task env for every durable/output sink", async () => {
    const secret = "task-local-harbour-lantern";
    writeTask(
      "local-redaction",
      [
        "version: 4",
        "run: echo ignored",
        "env:",
        `  TASK_LOCAL_VALUE: ${secret}`,
        'schedule: "@daily"',
        "redact: [TASK_LOCAL_VALUE]",
        "",
      ].join("\n"),
    );

    const result = await runTask("local-redaction", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      scheduled: true,
      spawnFn: (_cmd, options) => {
        expect(options.env?.TASK_LOCAL_VALUE).toBe(secret);
        return outputSpawn(`stdout ${secret}\n`, `stderr ${secret}\n`);
      },
    });

    expect(JSON.stringify(result)).not.toContain(secret);
    expect(fs.readFileSync(result.log, "utf8")).not.toContain(secret);
    expect(JSON.stringify(readTaskHistory({ id: "local-redaction" }))).not.toContain(secret);
    const db = openLogsDatabase();
    try {
      const rows = queryTaskLogs(db, { taskId: "local-redaction" });
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(secret);
    } finally {
      db.close();
    }
  });

  test.skipIf(process.platform === "win32").each(["symlink", "ancestor", "bundle-root", "file"] as const)(
    "%s cwd replacement fails before spawn and never executes outside the prepared physical directory",
    async (replacement) => {
      const outside = path.join(storage.root, `outside-${replacement}`);
      fs.mkdirSync(outside, { recursive: true });
      const work = path.join(storage.stashDir, "work");
      const nested = path.join(work, "nested");
      fs.mkdirSync(nested, { recursive: true });
      const authoredCwd =
        replacement === "ancestor" ? "work/nested" : replacement === "bundle-root" ? undefined : "work";
      writeTask(
        "cwd-swap",
        [
          "version: 4",
          "run: printf safe",
          ...(authoredCwd ? [`working-directory: ${authoredCwd}`] : []),
          'schedule: "@daily"',
          "",
        ].join("\n"),
      );
      let spawned = false;

      const result = await runTask("cwd-swap", {
        bundleDir: storage.stashDir,
        bundleName: "fixture",
        beforeNativeDispatch: () => {
          if (replacement === "bundle-root") {
            const original = `${storage.stashDir}-original`;
            fs.renameSync(storage.stashDir, original);
            fs.symlinkSync(outside, storage.stashDir, "dir");
            return;
          }
          if (replacement === "ancestor") {
            fs.renameSync(work, `${work}-original`);
            fs.symlinkSync(outside, work, "dir");
            return;
          }
          fs.rmSync(work, { recursive: true, force: true });
          if (replacement === "file") fs.writeFileSync(work, "not a directory");
          else fs.symlinkSync(outside, work, "dir");
        },
        spawnFn: () => {
          spawned = true;
          return completedSpawn(0);
        },
      });

      expect(spawned).toBe(false);
      expect(result.status).toBe("failed");
      expect(fs.readFileSync(result.log, "utf8")).toMatch(/working directory|physical|identity|changed/i);
    },
  );

  test.each([
    ["deleted", undefined],
    ["replaced", 'console.log("replacement")\n'],
  ] as const)("frozen JS bytes survive source %s after prepare", async (_label, replacement) => {
    const scripts = path.join(storage.stashDir, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    const script = path.join(scripts, "frozen.js");
    const original = 'console.log("original frozen bytes")\n';
    fs.writeFileSync(script, original);
    writeTask("frozen-js", 'version: 4\nuses: scripts/frozen.js\nschedule: "@daily"\n');
    let materializedFile: string | undefined;
    let sourceMutated = false;

    const result = await runTask("frozen-js", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      beforeNativeDispatch: () => {
        if (replacement === undefined) fs.rmSync(script);
        else fs.writeFileSync(script, replacement);
        sourceMutated = true;
      },
      spawnFn: (cmd) => {
        materializedFile = cmd.at(-1);
        expect(materializedFile).toBeTruthy();
        expect(fs.readFileSync(materializedFile as string, "utf8")).toBe(original);
        if (process.platform !== "win32") expect(fs.statSync(materializedFile as string).mode & 0o777).toBe(0o700);
        return completedSpawn(0);
      },
    });

    expect(result.status).toBe("completed");
    expect(sourceMutated).toBe(true);
    expect(materializedFile).toBeTruthy();
    expect(fs.existsSync(path.dirname(materializedFile as string))).toBe(false);
  });

  test.each([
    "success",
    "nonzero",
    "spawn",
    "timeout",
  ] as const)("removes the 0700 frozen-script temp tree after %s", async (outcome) => {
    const scripts = path.join(storage.stashDir, "scripts");
    fs.mkdirSync(scripts, { recursive: true });
    fs.writeFileSync(path.join(scripts, "cleanup.ts"), 'console.log("cleanup")\n');
    writeTask(
      "cleanup",
      `version: 4\nuses: scripts/cleanup.ts\nschedule: "@daily"\ntimeout: ${outcome === "timeout" ? 1 : "null"}\n`,
    );
    let directory: string | undefined;
    let settle: ((code: number) => void) | undefined;
    const spawnFn: SpawnFn = (cmd) => {
      directory = path.dirname(cmd.at(-1) as string);
      if (process.platform !== "win32") {
        expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
        expect(fs.statSync(cmd.at(-1) as string).mode & 0o777).toBe(0o700);
      }
      if (outcome === "spawn") throw new Error("synthetic spawn failure");
      if (outcome !== "timeout") return completedSpawn(outcome === "success" ? 0 : 9);
      const proc = {
        exitCode: null as number | null,
        exited: new Promise<number>((resolve) => {
          settle = resolve;
        }),
        stdout: closedStream(),
        stderr: closedStream(),
        stdin: null,
        kill() {
          this.exitCode = 143;
          settle?.(143);
        },
      };
      return proc;
    };

    const result = await runTask("cleanup", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      spawnFn,
    });

    expect(result.status).toBe(outcome === "success" ? "completed" : "failed");
    expect(directory).toBeTruthy();
    expect(fs.existsSync(directory as string)).toBe(false);
  });
});
