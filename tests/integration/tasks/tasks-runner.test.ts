import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import { buildTaskRunId, openLogsDatabase, queryTaskLogs, type TaskLogRow } from "../../../src/core/logs-db";
import { openStateDatabase } from "../../../src/core/state-db";
import type { SpawnedSubprocess, SpawnFn } from "../../../src/core/subprocess";
import type { AgentRunResult } from "../../../src/integrations/agent";
import { upsertTaskHistory } from "../../../src/storage/repositories/task-history-repository";
import { resolveAkmInvocation } from "../../../src/tasks/resolve-akm-bin";
import { shellCommand, shellExecutable } from "../../../src/tasks/run/run-native-task";
import { runTask } from "../../../src/tasks/run/run-task";
import { DEFAULT_WORKFLOW_TASK_TIMEOUT_MS } from "../../../src/tasks/run/run-workflow-task";
import { readTaskHistory } from "../../../src/tasks/run/task-history";
import { exitCodeForStatus } from "../../../src/tasks/run/task-result";
import { makeSandboxDir, withEnv } from "../../_helpers/sandbox";

type FakeWorkflowRunner = (options: { target: string; params?: Record<string, unknown> }) => Promise<{
  run: {
    id: string;
    workflowRef: string;
    workflowTitle: string;
    status: "active" | "completed" | "blocked" | "failed";
    params: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    completedAt: string | null;
    currentStepId: string | null;
  };
  executed: [];
  done?: true;
}>;

type FakeRunAgent = (...args: unknown[]) => Promise<AgentRunResult>;

const tasksRunnerSandbox = makeSandboxDir("akm-tasks-runner");
const tmpRoot = tasksRunnerSandbox.dir;
const bundleDir = path.join(tmpRoot, "stash");
const cacheDir = path.join(tmpRoot, "cache");
const dataDir = path.join(tmpRoot, "data");
const stateDir = path.join(tmpRoot, "state");
const logDir = path.join(cacheDir, "tasks", "logs");
const tasksDir = path.join(bundleDir, "tasks");
const configDir = path.join(tmpRoot, "cfg");

const TRACKED_ENV_KEYS = ["AKM_CONFIG_DIR", "AKM_CACHE_DIR", "AKM_BUNDLE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR"];
const PRESERVED_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of TRACKED_ENV_KEYS) PRESERVED_ENV[key] = process.env[key];
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.mkdirSync(tasksDir, { recursive: true });
  // Workflows directory needs to exist so resolveAssetPath can stat the type root.
  fs.mkdirSync(path.join(bundleDir, "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(bundleDir, "workflows", "noop.md"),
    "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    "utf8",
  );
  // Point state.db to an isolated data dir so tests don't share history.
  process.env.AKM_DATA_DIR = dataDir;
  process.env.AKM_CONFIG_DIR = configDir;
  process.env.AKM_CACHE_DIR = cacheDir;
  // Pair AKM_BUNDLE_DIR with AKM_STATE_DIR so the test-isolation guard in
  // src/core/paths.ts (getDataDir) stays inert.
  process.env.AKM_STATE_DIR = stateDir;
});

afterEach(() => {
  for (const key of TRACKED_ENV_KEYS) {
    if (PRESERVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = PRESERVED_ENV[key];
    }
  }
});

afterAll(() => {
  tasksRunnerSandbox.cleanup();
});

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Mirrors withExitCodePropagation() in run-native-task.ts (#845): appended to
// every pwsh/powershell -Command invocation so a failing native exit code
// isn't collapsed to 1 by -Command's own $?-based exit-code handling.
const POWERSHELL_EXIT_CODE_SUFFIX =
  "; if ($?) { exit 0 } elseif ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } else { exit 1 }";

function writeTask(id: string, body: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), body, "utf8");
}

function workflowTask(overrides: Record<string, unknown> = {}, params?: Record<string, unknown>): string {
  return stringifyYaml({
    version: 4,
    uses: "workflows/noop",
    ...(params ? { with: params } : {}),
    ...overrides,
  });
}

function shellTask(command: string | readonly string[], overrides: Record<string, unknown> = {}): string {
  const run = Array.isArray(command) ? command.map((value) => shellWord(value)).join(" ") : command;
  return stringifyYaml({ version: 4, run, ...overrides });
}

function promptTask(content: string, overrides: Record<string, unknown> = {}): string {
  return stringifyYaml({
    version: 4,
    uses: "akm/command",
    with: { content },
    ...overrides,
  });
}

/** Read this run's logs.db rows (the runner writes them via persistRunLog). */
function readRunLogRows(taskId: string): TaskLogRow[] {
  const db = openLogsDatabase();
  try {
    return queryTaskLogs(db, { taskId });
  } finally {
    db.close();
  }
}

test("task history applies its public limit in SQL before decoding metadata", () => {
  const db = openStateDatabase();
  try {
    for (let index = 0; index < 6; index++) {
      upsertTaskHistory(db, {
        task_id: `history-${index}`,
        status: "completed",
        started_at: `2025-01-01T00:00:0${index}.000Z`,
        completed_at: `2025-01-01T00:00:0${index}.000Z`,
        failed_at: null,
        log_path: null,
        target_kind: "command",
        target_ref: null,
        metadata_json:
          index === 0 ? "{not json" : JSON.stringify({ metadataVersion: 2, durationMs: index, detail: null }),
      });
    }
  } finally {
    db.close();
  }

  expect(readTaskHistory({ limit: 5 }).map((row) => row.id)).toEqual([
    "history-5",
    "history-4",
    "history-3",
    "history-2",
    "history-1",
  ]);
});

function emptyReadableStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

interface FakeTimer {
  cb: () => void;
  ms: number;
  fired: boolean;
  unref?: () => void;
}

/** Collect timers so a test can fire the kill ladder deterministically. */
function collectTimers() {
  const timers: FakeTimer[] = [];
  const setTimeoutFn = ((cb: () => void, ms?: number): FakeTimer => {
    const handle: FakeTimer = { cb, ms: ms ?? 0, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
  return { timers, setTimeoutFn, clearTimeoutFn };
}

/** Yield the event loop until a timer for `ms` is registered, then fire it. */
async function fireWhenRegistered(timers: FakeTimer[], ms: number): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    const timer = timers.find((t) => t.ms === ms && !t.fired);
    if (timer) {
      timer.fired = true;
      timer.cb();
      return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timer for ${ms}ms never registered`);
}

describe("runTask — workflow target", () => {
  test("dispatches to runWorkflowSteps and writes log + history to state.db", async () => {
    writeTask("wf", workflowTask());
    const calls: Array<{ ref: string; params: Record<string, unknown> }> = [];
    const fakeWf: FakeWorkflowRunner = async ({ target, params = {} }) => {
      calls.push({ ref: target, params });
      return {
        run: {
          id: "run-id-1",
          workflowRef: target,
          workflowTitle: "Noop",
          status: "completed",
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        executed: [],
        done: true,
      };
    };

    const result = await runTask("wf", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: fakeWf as never,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(calls).toEqual([{ ref: "stash//workflows/noop", params: {} }]);
    expect(result.status).toBe("completed");
    expect(result.target).toEqual({ kind: "workflow", ref: "stash//workflows/noop" });
    expect(result.detail?.runId).toBe("run-id-1");

    const logExists = fs.existsSync(result.log);
    expect(logExists).toBe(true);

    const rows = readTaskHistory({ id: "wf" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("wf");
    expect(rows[0]!.status).toBe("completed");
  });

  // M4: mapWorkflowStatus is now an exhaustive switch over WorkflowRunStatus
  // with an assertNever default (no silent `default: "completed"`). Lock in the
  // exact output for every runtime status so the explicit mapping provably
  // reproduces the previous behaviour for all known statuses.
  const STATUS_CASES = [
    { wf: "completed", expected: "completed" },
    { wf: "blocked", expected: "blocked" },
    { wf: "failed", expected: "failed" },
    { wf: "active", expected: "active" },
  ] as const;
  for (const { wf, expected } of STATUS_CASES) {
    test(`maps workflow run status "${wf}" → task status "${expected}"`, async () => {
      writeTask("map", workflowTask());
      const fakeWf: FakeWorkflowRunner = async ({ target, params = {} }) => ({
        run: {
          id: "run-map",
          workflowRef: target,
          workflowTitle: "Noop",
          status: wf,
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: null,
          currentStepId: null,
        },
        executed: [],
      });

      const result = await runTask("map", {
        bundleDir,
        logDir,
        runWorkflowStepsImpl: fakeWf as never,
        now: () => new Date("2025-01-01T00:00:00Z"),
      });

      expect(result.status).toBe(expected);
    });
  }

  // ── issue 11: whole-run timeout for unattended workflow tasks ─────────────
  //
  // The runner used to call `runWorkflowSteps({ target, params })` with no
  // signal, no maxSteps and no maxRetries: a scheduled run had no abort path
  // at all, so one wedged agent unit hung the task indefinitely. It now wires
  // an AbortController + timer exactly like `akm workflow run --timeout`
  // (src/commands/workflow-cli.ts) and threads the run bounds the task file
  // declares.

  /** Records what the runner passed to `runWorkflowSteps`. */
  interface CapturedRunOptions {
    target: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
    maxSteps?: number;
    maxRetries?: number;
  }

  function runSummary(id: string, target: string, status: "active" | "completed") {
    return {
      id,
      workflowRef: target,
      workflowTitle: "Noop",
      status,
      params: {},
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      completedAt: status === "completed" ? "2025-01-01T00:00:00Z" : null,
      currentStepId: status === "active" ? "step-2" : null,
    };
  }

  /**
   * A workflow orchestrator that never finishes on its own — it resolves only
   * when the caller's signal aborts, reproducing the engine's documented abort
   * contract (`driveRun` in src/workflows/exec/run-workflow.ts breaks at the
   * next step boundary, keeps the journal + lease, and returns the still-`active`
   * — i.e. resumable — run with `aborted: true`).
   */
  function wedgedWorkflowRunner(captured: CapturedRunOptions[]) {
    return async (options: CapturedRunOptions) => {
      captured.push(options);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        run: runSummary("run-wedged", options.target, "active"),
        executed: [],
        stepsProcessed: 0,
        aborted: true,
      };
    };
  }

  /**
   * An orchestrator whose run COMPLETES even though the deadline fired — the
   * narrow window where the timer lands during the run's final bookkeeping,
   * after the last step boundary the abort could have stopped it at.
   */
  function completesDespiteAbortRunner(captured: CapturedRunOptions[]) {
    return async (options: CapturedRunOptions) => {
      captured.push(options);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        run: runSummary("run-finished", options.target, "completed"),
        executed: [],
        stepsProcessed: 1,
        done: true,
      };
    };
  }

  /**
   * An orchestrator stopped by a verification gate whose deadline ALSO fired,
   * so two of the runner's three failure channels are live in one attempt.
   */
  function gateRejectedRunner(captured: CapturedRunOptions[]) {
    return async (options: CapturedRunOptions) => {
      captured.push(options);
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        run: runSummary("run-gated", options.target, "active"),
        executed: [],
        stepsProcessed: 1,
        gateRejection: { stepId: "verify", missing: ["evidence"], feedback: "no evidence for the claim" },
      };
    };
  }

  /** An orchestrator that completes immediately, so only the wiring is observed. */
  function instantWorkflowRunner(captured: CapturedRunOptions[]) {
    return async (options: CapturedRunOptions) => {
      captured.push(options);
      return { run: runSummary("run-fast", options.target, "completed"), executed: [], stepsProcessed: 0, done: true };
    };
  }

  test("a declared timeout aborts the run and reports it as resumable", async () => {
    writeTask("wf-timeout", workflowTask({ timeout: 100 }));
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const promise = runTask("wf-timeout", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: wedgedWorkflowRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await fireWhenRegistered(timers, 100);
    const result = await promise;

    // The signal reached runWorkflowSteps and actually fired.
    expect(captured).toHaveLength(1);
    expect(captured[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(captured[0]!.signal?.aborted).toBe(true);
    // A timed-out attempt is a task failure even though the ENGINE stopped
    // cleanly, so cron/launchd see a non-zero exit instead of a silent success.
    expect(result.status).toBe("failed");
    expect(exitCodeForStatus(result.status)).toBe(1);
    // The aborted run is left resumable, and its id is surfaced for that.
    expect(result.detail?.runId).toBe("run-wedged");
    expect(result.detail?.error).toContain("akm workflow resume run-wedged");
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain("timed_out=true timeout_ms=100");
    expect(log).toContain("run_id=run-wedged status=active");
    expect(readRunLogRows("wf-timeout").some((row) => row.line.includes("timed_out=true timeout_ms=100"))).toBe(true);
  });

  test("a run that completes anyway is not reported as a timeout", async () => {
    writeTask("wf-raced", workflowTask({ timeout: 100 }));
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const promise = runTask("wf-raced", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: completesDespiteAbortRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await fireWhenRegistered(timers, 100);
    const result = await promise;

    // The deadline fired — but the run finished, so there is nothing to resume
    // and nothing failed.
    expect(captured[0]!.signal?.aborted).toBe(true);
    expect(result.status).toBe("completed");
    expect(exitCodeForStatus(result.status)).toBe(0);
    expect(result.detail?.error).toBeUndefined();
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).not.toContain("timed_out=true");
    expect(log).toContain("run_id=run-finished status=completed");
  });

  test("a gate rejection outranks the deadline in the status, the log and the history row alike", async () => {
    writeTask("wf-gated", workflowTask({ timeout: 100 }));
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const promise = runTask("wf-gated", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: gateRejectedRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });
    await fireWhenRegistered(timers, 100);
    const result = await promise;

    // Two failure channels are live at once (gate rejection + fired deadline).
    // Whichever one wins must win everywhere: a log naming one cause beside a
    // history row naming the other is unreadable after the fact.
    expect(captured[0]!.signal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    const gateMessage = 'Verification rejected step "verify": no evidence for the claim';
    expect(result.detail?.error).toBe(gateMessage);
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain(`error=${gateMessage}`);
    expect(log).not.toContain("timed out after");
    // The deadline is still recorded as a fact about the attempt.
    expect(log).toContain("timed_out=true timeout_ms=100");
    expect(readTaskHistory({ id: "wf-gated" })[0]?.detail?.error).toBe(gateMessage);
  });

  test("an explicit timeout overrides the unattended default", async () => {
    writeTask("wf-explicit", workflowTask({ timeout: 60_000 }));
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const result = await runTask("wf-explicit", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: instantWorkflowRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(result.status).toBe("completed");
    expect(timers.map((timer) => timer.ms)).toEqual([60_000]);
    expect(timers[0]!.ms).not.toBe(DEFAULT_WORKFLOW_TASK_TIMEOUT_MS);
    expect(captured[0]!.signal?.aborted).toBe(false);
  });

  test("applies the unattended default timeout when the task declares none", async () => {
    writeTask("wf-default", workflowTask());
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const result = await runTask("wf-default", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: instantWorkflowRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(result.status).toBe("completed");
    expect(timers.map((timer) => timer.ms)).toEqual([DEFAULT_WORKFLOW_TASK_TIMEOUT_MS]);
    // Bounded, but generously: an aborted run is resumable, so the default errs
    // long rather than cutting a legitimate multi-step run short.
    expect(DEFAULT_WORKFLOW_TASK_TIMEOUT_MS).toBe(6 * 60 * 60 * 1000);
  });

  test("`akm.timeout: null` opts a workflow task out of any whole-run timeout", async () => {
    writeTask("wf-unbounded", workflowTask({ timeout: null }));
    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const captured: CapturedRunOptions[] = [];

    const result = await runTask("wf-unbounded", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: instantWorkflowRunner(captured) as never,
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(result.status).toBe("completed");
    expect(timers).toEqual([]);
    // The signal is still threaded — only the timer is gone.
    expect(captured[0]!.signal).toBeInstanceOf(AbortSignal);
  });

  test("threads declared maxSteps / maxRetries into the orchestrator", async () => {
    // P4 (docs/plans/specs/p4-deletions-closeout.md §3.2, row B-28) retired
    // this test's v3 fixture along with task source v3 acceptance itself —
    // the `with:` -> child-run-params path it exercised on a
    // `uses: workflows/<ref>` target is now UNREACHABLE (task source v4
    // rejects `with:` on any target but `uses: akm/command`; R-R2 is
    // resolved by deletion, spec §8). Converted to task source v4:
    // maxSteps/maxRetries are top-level fields there, and `params` is now
    // the task's defaulted declared inputs — `{}` here, since this fixture
    // declares none (row B-28's new answer).
    writeTask("wf-bounds", workflowTask({ maxSteps: 4, maxRetries: 2 }));
    const captured: CapturedRunOptions[] = [];

    const result = await runTask("wf-bounds", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: instantWorkflowRunner(captured) as never,
    });

    expect(result.status).toBe("completed");
    expect(captured[0]!.maxSteps).toBe(4);
    expect(captured[0]!.maxRetries).toBe(2);
    expect(captured[0]!.params).toEqual({});
  });

  test("omits maxSteps / maxRetries when the task declares none", async () => {
    writeTask("wf-nobounds", workflowTask());
    const captured: CapturedRunOptions[] = [];

    await runTask("wf-nobounds", {
      bundleDir,
      logDir,
      runWorkflowStepsImpl: instantWorkflowRunner(captured) as never,
    });

    // Absent, not zero: `maxRetries: 0` and "unset" mean the same thing to the
    // engine today, but passing undefined keeps the engine's own default.
    expect(captured[0]).not.toHaveProperty("maxSteps");
    expect(captured[0]).not.toHaveProperty("maxRetries");
  });
});

describe("runTask — command target", () => {
  test("resolves a bare akm run task to the current installation when PATH omits it", async () => {
    const command = ["akm", "improve", "--strategy", "quick"];
    writeTask("literal-command", shellTask(command));
    let spawned: string[] | undefined;
    const spawnFn: SpawnFn = (cmd) => {
      spawned = cmd;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill() {},
      };
    };

    const result = await withEnv({ PATH: "" }, () => runTask("literal-command", { bundleDir, logDir, spawnFn }));

    expect(result.status).toBe("completed");
    expect(spawned?.slice(0, 2)).toEqual(["sh", "-c"]);
    const shellText = spawned?.[2];
    expect(shellText).toContain(resolveAkmInvocation().argv.map(shellWord).join(" "));
    expect(shellText).toContain(command.slice(1).map(shellWord).join(" "));
  });

  test("spawns a cmd-shell task with windowsVerbatimArguments so its hand-quoted command line survives", async () => {
    // cmd.exe's `/S /C` reads its tail as one hand-quoted command line, not
    // standard argv — shellCommand() already builds and quotes it for that.
    // Default per-argument escaping would add an incompatible second layer of
    // quoting on top and break any resolved path containing a space (#844
    // gated-CI: the native scheduler suite's first real Windows run).
    writeTask("cmd-shell-task", shellTask("akm --version", { shell: "cmd" }));
    let capturedOptions: { windowsVerbatimArguments?: boolean } | undefined;
    const spawnFn: SpawnFn = (_cmd, options) => {
      capturedOptions = options;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill() {},
      };
    };

    const result = await runTask("cmd-shell-task", { bundleDir, logDir, spawnFn });

    expect(result.status).toBe("completed");
    expect(capturedOptions?.windowsVerbatimArguments).toBe(true);
  });

  test("a bare akm run task under a PowerShell shell gets the call operator", async () => {
    // PowerShell parses `'C:\akm.exe' --version` as a string expression
    // followed by a parse error, not an invocation — the gated Windows
    // native-scheduler suite failed exactly there, since powershell is the
    // Windows default task shell. The rebound command must start with `&`.
    writeTask("pwsh-bare-akm", shellTask("akm --version", { shell: "pwsh" }));
    let spawned: string[] | undefined;
    const spawnFn: SpawnFn = (cmd) => {
      spawned = cmd;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill() {},
      };
    };

    const result = await withEnv({ PATH: "" }, () => runTask("pwsh-bare-akm", { bundleDir, logDir, spawnFn }));

    expect(result.status).toBe("completed");
    expect(spawned?.slice(1, 4)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    const command = spawned?.[4];
    expect(command?.startsWith("& '")).toBe(true);
    expect(command).toContain("--version");
    // The invocation parts are PowerShell single-quoted; none may be bare.
    expect(command).toBe(
      `& ${resolveAkmInvocation()
        .argv.map((p) => `'${p.replaceAll("'", "''")}'`)
        .join(" ")} --version${POWERSHELL_EXIT_CODE_SUFFIX}`,
    );
  });

  test("shellCommand appends an exit-code-preserving guard for pwsh and powershell (#845)", () => {
    // -Command's own exit code is $? -based (0/1) and collapses any other
    // native exit code to 1 — see withExitCodePropagation() in
    // run-native-task.ts for why a bare `exit $LASTEXITCODE` is unsafe
    // (stays $null, and `exit $null` is 0, for a pure-PowerShell command).
    const env = { SystemRoot: "C:\\Windows" };
    for (const shell of ["powershell", "pwsh"] as const) {
      const command = shellCommand({ command: "Write-Output hi", shell }, "win32", env);
      expect(command.at(-1)).toBe(`Write-Output hi${POWERSHELL_EXIT_CODE_SUFFIX}`);
    }
  });

  test("shellCommand resolves powershell and cmd to absolute Windows paths", () => {
    // A scheduler-fired run restores the PATH captured at install time,
    // which can be minimal (the CI gate: System32 + SystemRoot). Bare
    // "powershell" is NOT resolvable on that PATH — powershell.exe lives in
    // the WindowsPowerShell\v1.0 subdirectory — so the spawn must use the
    // canonical absolute path. Same for cmd via ComSpec.
    const env = { SystemRoot: "C:\\Windows" };
    expect(shellExecutable("powershell", "win32", env)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(shellExecutable("cmd", "win32", { ...env, ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
    expect(shellExecutable("cmd", "win32", env)).toBe("C:\\Windows\\System32\\cmd.exe");
    // pwsh has no canonical install path; POSIX shells stay bare everywhere.
    expect(shellExecutable("pwsh", "win32", env)).toBe("pwsh");
    expect(shellExecutable("powershell", "linux", {})).toBe("powershell");
    expect(shellExecutable("sh", "darwin", {})).toBe("sh");

    const psCommand = shellCommand({ command: "echo hi", shell: "powershell" }, "win32", env);
    expect(psCommand).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `echo hi${POWERSHELL_EXIT_CODE_SUFFIX}`,
    ]);
    const cmdCommand = shellCommand({ command: "echo hi", shell: "cmd" }, "win32", env);
    expect(cmdCommand).toEqual(["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "echo hi"]);
  });

  test("does not set windowsVerbatimArguments for a posix-shell task", async () => {
    writeTask("sh-shell-task", shellTask("akm --version", { shell: "sh" }));
    let capturedOptions: { windowsVerbatimArguments?: boolean } | undefined;
    const spawnFn: SpawnFn = (_cmd, options) => {
      capturedOptions = options;
      return {
        exitCode: 0,
        exited: Promise.resolve(0),
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill() {},
      };
    };

    const result = await runTask("sh-shell-task", { bundleDir, logDir, spawnFn });

    expect(result.status).toBe("completed");
    expect(capturedOptions?.windowsVerbatimArguments).toBeFalsy();
  });

  test.skipIf(process.platform === "win32")(
    "executes a bare akm run task when the scheduler PATH omits the installation",
    async () => {
      writeTask("bare-current-install", ["version: 4", "run: akm --version", ""].join("\n"));

      const result = await withEnv({ PATH: "/usr/bin:/bin" }, () =>
        runTask("bare-current-install", { bundleDir, logDir, scheduled: true }),
      );

      expect(result.status).toBe("completed");
      expect(fs.readFileSync(result.log, "utf8")).toContain("exit_code=0");
    },
  );

  test("executes an explicitly selected akm path without replacing it", async () => {
    const vendorDir = path.join(tmpRoot, "vendor");
    const executable = path.join(vendorDir, process.platform === "win32" ? "akm.exe" : "akm");
    fs.mkdirSync(vendorDir, { recursive: true });
    try {
      fs.linkSync(process.execPath, executable);
    } catch {
      fs.copyFileSync(process.execPath, executable);
    }
    if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
    writeTask("explicit-akm", shellTask([executable, "-e", 'console.log("explicit vendor akm")']));

    const result = await runTask("explicit-akm", { bundleDir, logDir });

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("explicit vendor akm");
  });

  test("uses the owning bundle as the default working directory when HOME is absent", async () => {
    const fallbackDir = path.join(tmpRoot, "command-cwd");
    fs.mkdirSync(fallbackDir, { recursive: true });
    writeTask("portable-cwd", shellTask([process.execPath, "-e", "console.log('cwd=' + process.cwd())"]));

    const result = await withEnv({ HOME: undefined, TMPDIR: fallbackDir, TEMP: fallbackDir, TMP: fallbackDir }, () =>
      runTask("portable-cwd", { bundleDir, logDir }),
    );

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain(`cwd=${bundleDir}`);
  });

  test("a command that ignores SIGTERM is SIGKILLed on timeout, logging timed_out + exit 143", async () => {
    writeTask("stubborn", shellTask("hang-forever", { timeout: 100 }));

    const { timers, setTimeoutFn, clearTimeoutFn } = collectTimers();
    const signals: string[] = [];
    // A child that swallows SIGTERM: only SIGKILL resolves its exit. Proves the
    // runner now escalates (old inline path signalled SIGTERM once and hung).
    const spawnFn: SpawnFn = () => {
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const proc: SpawnedSubprocess = {
        exitCode: null,
        exited,
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill(signal?: number | string) {
          const name = String(signal);
          signals.push(name);
          if (name === "SIGTERM") return; // ignored — force the SIGKILL rung
          resolveExit(143);
        },
      };
      return proc;
    };

    const promise = runTask("stubborn", { bundleDir, logDir, spawnFn, setTimeoutFn, clearTimeoutFn });
    await fireWhenRegistered(timers, 100); // deadline → SIGTERM (ignored)
    await fireWhenRegistered(timers, 5000); // grace → SIGKILL → child exits 143
    const result = await promise;

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.status).toBe("failed");
    expect(result.detail?.exitCode).toBe(143);
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain("timed_out=true timeout_ms=100");
    expect(log).toContain("exit_code=143");
  });

  test("a SIGTERM to the task runner itself terminates the whole child process group (#956)", async () => {
    // The runner's own process previously had no way to end its detached,
    // own-process-group child (spawned by runManagedSubprocess for the
    // group-kill guarantee) when the RUNNER received a signal — only a
    // timeout tied into that ladder. A launcher-forwarded SIGTERM (#956)
    // or a supervisor signalling `akm task run` directly used to
    // leave the child running as an orphan.
    writeTask("signaled", shellTask("hang-forever"));

    const signals: string[] = [];
    let spawned = false;
    const spawnFn: SpawnFn = () => {
      spawned = true;
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      const proc: SpawnedSubprocess = {
        exitCode: null,
        exited,
        stdout: emptyReadableStream(),
        stderr: emptyReadableStream(),
        stdin: null,
        kill(signal?: number | string) {
          signals.push(String(signal));
          // Mirrors a real child's exit: stops scheduleKillLadder's SIGKILL
          // follow-up timer (it no-ops once exitCode is set) rather than
          // leaving a dangling real 5s timer behind this test.
          proc.exitCode = 143;
          resolveExit(143);
        },
      };
      return proc;
    };

    const promise = runTask("signaled", { bundleDir, logDir, spawnFn });
    for (let i = 0; i < 1000 && !spawned; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(spawned).toBe(true);

    // Invoke ONLY runNativeTask's own listener directly, rather than
    // `process.emit("SIGTERM")`: the test-isolation preload
    // (tests/_preload.ts) also holds a real SIGTERM listener that calls
    // `process.exit()` to guard against an orphaned/hung worker, and emit()
    // would run every registered listener including that one — killing this
    // test process instead of exercising runNativeTask's handler.
    const ourListener = process.listeners("SIGTERM").at(-1) as (() => void) | undefined;
    if (!ourListener) throw new Error("runNativeTask did not register a SIGTERM listener");
    ourListener();

    const result = await promise;

    expect(signals).toEqual(["SIGTERM"]);
    expect(result.status).toBe("failed");
    expect(result.detail?.exitCode).toBe(143);
  });

  test("redacts a webhook URL from both the log file and logs.db rows", async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123456789012345678/abcDEF-123_token";
    writeTask(
      "leaky-webhook",
      shellTask([process.execPath, "-e", `console.log(${JSON.stringify(`posting to ${webhookUrl}`)})`]),
    );

    const result = await runTask("leaky-webhook", { bundleDir, logDir });

    expect(result.status).toBe("completed");
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).not.toContain("abcDEF-123_token");
    expect(log).toContain("https://discord.com/api/webhooks/123456789012345678/[REDACTED]");

    const rows = readRunLogRows("leaky-webhook");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.line).not.toContain("abcDEF-123_token");
    expect(rows.some((row) => row.line.includes("discord.com/api/webhooks/123456789012345678/[REDACTED]"))).toBe(true);
  });

  // ── #755: exact-value redaction for the command arm ──────────────────────
  //
  // The pattern arm above only catches credential SHAPES. A configured secret
  // whose value looks like nothing in particular went to disk verbatim.

  const echoTask = (id: string, text: string, redact?: readonly string[]): void => {
    writeTask(
      id,
      shellTask([process.execPath, "-e", `console.log(${JSON.stringify(text)})`], { ...(redact ? { redact } : {}) }),
    );
  };

  const assertAbsentFromBothSinks = (id: string, logPath: string, secret: string): void => {
    expect(fs.readFileSync(logPath, "utf8")).not.toContain(secret);
    const rows = readRunLogRows(id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.line).not.toContain(secret);
  };

  test("redacts a config-declared engine credential that is not credential-shaped", async () => {
    // Deliberately shaped like nothing: no `sk-`, no `Bearer`, no webhook URL.
    // The pattern arm cannot see this, which is the whole point of #755.
    const secret = "wolfram-tuesday-lantern";
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          main: {
            kind: "llm",
            endpoint: "https://api.example.com/v1/chat/completions",
            model: "fixture",
            credential: { names: ["ACME_LLM_KEY"], required: true },
          },
        },
      }),
    );
    echoTask("leaky-config-secret", `calling out with ${secret}`);

    const result = await withEnv({ ACME_LLM_KEY: secret }, () => runTask("leaky-config-secret", { bundleDir, logDir }));

    expect(result.status).toBe("completed");
    assertAbsentFromBothSinks("leaky-config-secret", result.log, secret);
    expect(fs.readFileSync(result.log, "utf8")).toContain("[REDACTED]");
  });

  test("redacts an ambient credential inferred from its variable name", async () => {
    const secret = "opalescent-badger-parade";
    echoTask("leaky-ambient-secret", `deploying with ${secret}`);

    const result = await withEnv({ ACME_DEPLOY_TOKEN: secret }, () =>
      runTask("leaky-ambient-secret", { bundleDir, logDir }),
    );

    expect(result.status).toBe("completed");
    assertAbsentFromBothSinks("leaky-ambient-secret", result.log, secret);
  });

  test("`redact:` names a secret no rule would otherwise recognise", async () => {
    // Neither config-declared nor name-shaped — the escape hatch is the only
    // thing that can catch this one.
    const secret = "harbour-lantern-drift";
    echoTask("leaky-declared-secret", `token is ${secret}`, ["ACME_UNGUESSABLE"]);

    const result = await withEnv({ ACME_UNGUESSABLE: secret }, () =>
      runTask("leaky-declared-secret", { bundleDir, logDir }),
    );

    expect(result.status).toBe("completed");
    assertAbsentFromBothSinks("leaky-declared-secret", result.log, secret);

    // And without the declaration the same value would have leaked — otherwise
    // this test proves nothing about `redact:`.
    echoTask("leaky-undeclared-secret", `token is ${secret}`);
    const leaked = await withEnv({ ACME_UNGUESSABLE: secret }, () =>
      runTask("leaky-undeclared-secret", { bundleDir, logDir }),
    );
    expect(fs.readFileSync(leaked.log, "utf8")).toContain(secret);
  });

  test("redaction survives a secret reaching the spawn_error path", async () => {
    const secret = "cinnabar-thicket-verso";
    writeTask("leaky-spawn-error", shellTask([`/nonexistent/${secret}/bin`]));

    const result = await withEnv({ ACME_API_TOKEN: secret }, () => runTask("leaky-spawn-error", { bundleDir, logDir }));

    expect(result.status).toBe("failed");
    assertAbsentFromBothSinks("leaky-spawn-error", result.log, secret);
  });

  test("ordinary command output is left intact", async () => {
    // The over-redaction guard. Treating every non-allowlisted env value as a
    // secret — the fix #755 literally proposed — turns this log into confetti:
    // `SHLVL=1` alone rewrites every "1" in the output.
    echoTask("clean-output", "Build finished in 12.4s | 3 tests passed, 0 failed | wrote dist/index.js (48 KB)");

    const result = await withEnv({ ACME_DEPLOY_TOKEN: "opalescent-badger-parade" }, () =>
      runTask("clean-output", { bundleDir, logDir }),
    );

    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain("Build finished in 12.4s");
    expect(log).toContain("3 tests passed, 0 failed");
    expect(log).toContain("wrote dist/index.js (48 KB)");
  });

  test("redacts regardless of which configured bundle the task came from", async () => {
    // Acceptance criterion 3: the fixtures elsewhere in this suite use a single
    // default bundle, so a per-bundle regression would go unnoticed.
    const secret = "meridian-thistle-vault";
    const secondaryStash = path.join(tmpRoot, "stash-secondary");
    fs.rmSync(secondaryStash, { recursive: true, force: true });
    fs.mkdirSync(path.join(secondaryStash, "tasks"), { recursive: true });
    fs.mkdirSync(path.join(secondaryStash, "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(secondaryStash, "tasks", "secondary-leak.yml"),
      shellTask([process.execPath, "-e", `console.log(${JSON.stringify(`shipping ${secret}`)})`], {
        redact: ["ACME_SECONDARY_VALUE"],
      }),
    );

    const result = await withEnv({ ACME_SECONDARY_VALUE: secret }, () =>
      runTask("secondary-leak", { bundleDir: secondaryStash, logDir }),
    );

    expect(result.status).toBe("completed");
    assertAbsentFromBothSinks("secondary-leak", result.log, secret);
  });
});

describe("runTask — prompt target", () => {
  test("forwards scheduled AKM directory context to an agent without trusting task or caller overrides", async () => {
    writeTask(
      "scheduled-agent-context",
      [
        "version: 4",
        "uses: akm/command",
        "with:",
        "  content: keep nested akm calls in this scheduled installation",
        "env:",
        "  AKM_BUNDLE_DIR: /authored-override",
        "  TASK_FLAG: retained",
        "engine: opencode",
        "",
      ].join("\n"),
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );
    const schedulerContext = {
      AKM_BUNDLE_DIR: path.join(tmpRoot, "scheduled-bundle"),
      AKM_CONFIG_DIR: configDir,
      AKM_DATA_DIR: path.join(tmpRoot, "scheduled-data"),
      AKM_CACHE_DIR: path.join(tmpRoot, "scheduled-cache"),
      AKM_STATE_DIR: path.join(tmpRoot, "scheduled-state"),
    };
    for (const directory of Object.values(schedulerContext)) fs.mkdirSync(directory, { recursive: true });
    let childEnv: Record<string, string> | undefined;

    const result = await withEnv(schedulerContext, () =>
      runTask("scheduled-agent-context", {
        bundleDir,
        logDir,
        scheduled: true,
        // Operational overrides must not be able to replace frozen request
        // data, including the scheduler context below.
        agentOptions: { env: { AKM_STATE_DIR: "/caller-override" } },
        runAgentImpl: async (_profile, _prompt, options) => {
          childEnv = options.env;
          return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
        },
      }),
    );

    expect(result.status).toBe("completed");
    expect(childEnv).toMatchObject({ ...schedulerContext, TASK_FLAG: "retained" });
    expect(childEnv?.AKM_BUNDLE_DIR).toBe(schedulerContext.AKM_BUNDLE_DIR);
    expect(childEnv?.AKM_STATE_DIR).toBe(schedulerContext.AKM_STATE_DIR);
  });

  test("dispatches an LLM prompt task through its selected engine", async () => {
    writeTask("llm", promptTask("answer briefly", { engine: "fast", model: "qwen3-small" }));
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          fast: {
            kind: "llm",
            endpoint: "http://localhost:11434/v1/chat/completions",
            model: "qwen3",
          },
        },
        defaults: { engine: "fast", llmEngine: "fast" },
      }),
    );
    const seen: { model?: string; prompt?: string } = {};

    const result = await runTask("llm", {
      bundleDir,
      logDir,
      chatCompletionImpl: async (connection, messages) => {
        seen.model = connection.model;
        seen.prompt = messages[0]?.content;
        return "complete";
      },
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    // D8 (spec docs/plans/specs/p1b-model-extraction.md §5.3, §6 F-2)
    // corollary: a prepared command (agent/LLM) run now reports "command",
    // not the former inverted "prompt" string.
    expect(result.target).toEqual({ kind: "command", engine: "fast" });
    expect(seen).toEqual({ model: "qwen3-small", prompt: "answer briefly" });
    expect(result.notices?.map((notice) => [notice.code, notice.field])).toEqual([
      ["untranslated-field", "runtime.workspace"],
    ]);
    const log = fs.readFileSync(result.log, "utf8");
    expect(log).toContain("lowering_notice=untranslated-field adapter=llm field=runtime.workspace");
    expect(log).not.toContain("lowering_notice=untranslated-field adapter=llm field=runtime.environment");
  });

  test("dispatches to runAgent (mocked) and writes captured stdout to the log", async () => {
    writeTask("prompt", promptTask("say hello", { engine: "opencode" }));

    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const prompt = args[1] as string;
      return {
        ok: true,
        exitCode: 0,
        stdout: `agent received: ${prompt}`,
        stderr: "",
        durationMs: 12,
      };
    };

    // The prompt task resolves this named agent engine before dispatch.
    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const result = await runTask("prompt", {
      bundleDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    // D8 (spec §5.3, §6 F-2) corollary: same flip as above, both for the
    // freshly-returned result and the history round trip (this run's own row
    // carries the new targetVocab: 2 marker, so it reads back unmapped).
    expect(result.target).toEqual({ kind: "command", engine: "opencode" });
    expect(fs.readFileSync(result.log, "utf8")).toContain("agent received: say hello");

    const rows = readTaskHistory({ id: "prompt" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.target).toEqual({ kind: "command", engine: "opencode" });

    // #579: the same run is queryable from logs.db by task_id AND run_id,
    // with the captured agent stdout stored as stream='stdout' rows.
    const logRows = readRunLogRows("prompt");
    expect(logRows.length).toBeGreaterThan(0);
    const runId = buildTaskRunId("prompt", result.startedAt);
    expect(logRows.every((row) => row.run_id === runId)).toBe(true);
    const stdoutRows = logRows.filter((row) => row.stream === "stdout" && row.level === "info");
    expect(stdoutRows.map((row) => row.line)).toContain("agent received: say hello");
    // ...and no stray "--- agent stdout ---" file markers leak into the DB.
    expect(logRows.some((row) => row.line.startsWith("---"))).toBe(false);

    const db = openLogsDatabase();
    try {
      expect(queryTaskLogs(db, { runId })).toHaveLength(logRows.length);
    } finally {
      db.close();
    }
  });

  test("passes a prompt-task model through the selected agent engine exactly", async () => {
    writeTask("agent-model", promptTask("review this", { engine: "reviewer", model: "provider/exact-model" }));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: {
          reviewer: {
            kind: "agent",
            platform: "opencode",
          },
        },
        defaults: { engine: "reviewer" },
      }),
    );
    let captured: { model?: string } = {};

    const result = await runTask("agent-model", {
      bundleDir,
      logDir,
      runAgentImpl: async (profile) => {
        captured = { model: profile.model };
        return { ok: true, exitCode: 0, stdout: "reviewed", stderr: "", durationMs: 1 };
      },
      now: () => new Date("2025-01-01T00:00:00Z"),
    });

    expect(result.status).toBe("completed");
    expect(captured).toEqual({ model: "provider/exact-model" });
  });

  test("redacts echoed agent credentials before task logs are persisted", async () => {
    const sentinel = "TASK-ECHO-SENTINEL";
    writeTask("redacted", promptTask("say hello", { engine: "opencode" }));
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const result = await withEnv({ AKM_CONFIG_DIR: configDir, OPENCODE_API_KEY: sentinel }, () =>
      runTask("redacted", {
        bundleDir,
        logDir,
        runAgentImpl: async () => ({
          ok: true,
          exitCode: 0,
          stdout: `echo ${sentinel}`,
          stderr: "",
          durationMs: 1,
        }),
        now: () => new Date("2025-01-01T00:00:00Z"),
      }),
    );

    const durable = fs.readFileSync(result.log, "utf8") + JSON.stringify(readRunLogRows("redacted"));
    expect(durable).not.toContain(sentinel);
    expect(durable).toContain("[REDACTED]");
  });

  test("agent failure surfaces as failed status with reason", async () => {
    writeTask("fail", promptTask("boom", { engine: "opencode" }));

    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const fakeRunAgent: FakeRunAgent = async () => {
      return {
        ok: false,
        exitCode: 2,
        stdout: "",
        stderr: "boom",
        durationMs: 12,
        reason: "non_zero_exit",
        error: "agent CLI exited with code 2",
      };
    };

    const result = await runTask("fail", {
      bundleDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });
    expect(result.status).toBe("failed");
    expect(result.detail?.reason).toBe("non_zero_exit");
    expect(exitCodeForStatus(result.status)).toBe(1);

    // #579: failure diagnostics land in logs.db with level='error', and the
    // captured agent stderr is recorded as stream='stderr'.
    const logRows = readRunLogRows("fail");
    const errorRows = logRows.filter((row) => row.level === "error");
    expect(errorRows.some((row) => row.line.includes("non_zero_exit"))).toBe(true);
    expect(errorRows.filter((row) => row.stream === "stderr").map((row) => row.line)).toContain("boom");
  });

  // #943: reproduces the issue's report verbatim — a command task authored
  // with its own `timeout:` field whose dispatched agent times out. Static
  // reading found every ok:false branch (including reason:"timeout" from
  // sdk-runner.ts/spawn.ts) already unconditionally mapped to status:"failed"
  // with detail.reason preserved; this pins that so the mapping can't regress
  // silently, and reproduces the exact scenario (timeout: 50) rather than only
  // the pre-existing non_zero_exit case above.
  test("agent timeout surfaces as failed status with reason timeout", async () => {
    writeTask("timed-out", promptTask("content", { engine: "opencode", timeout: 50 }));

    process.env.AKM_CONFIG_DIR = configDir;
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        configVersion: "0.9.0",
        engines: { opencode: { kind: "agent", platform: "opencode" } },
        defaults: { engine: "opencode" },
      }),
    );

    const fakeRunAgent: FakeRunAgent = async () => {
      return {
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 60,
        reason: "timeout",
        error: 'agent CLI "opencode" timed out after 50ms',
      };
    };

    const result = await runTask("timed-out", {
      bundleDir,
      logDir,
      runAgentImpl: fakeRunAgent,
      now: () => new Date("2025-01-01T00:00:00Z"),
    });
    expect(result.status).toBe("failed");
    expect(result.detail?.reason).toBe("timeout");
    expect(exitCodeForStatus(result.status)).toBe(1);

    const historyRows = readTaskHistory({ id: "timed-out" });
    expect(historyRows[0]?.status).toBe("failed");
    expect(historyRows[0]?.detail?.reason).toBe("timeout");
  });
});

// P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.7, row B-22, F-A2.17)
// DELETED src/tasks/run/run-task.ts's shouldSkipUnactivatedTask call and the
// helper itself, along with prepare-support.ts's `enabled:
// document.akm?.enabled !== false` derivation — task source v4 has no
// document-level `enabled` at all (P4-N6: `enabled` is per-schedule-binding,
// enforced once at sync time by scheduler-sync.ts, never re-checked at fire
// time). The "runTask — disabled tasks" describe block this comment used to
// introduce (manual dispatch of an intentionally disabled task; a
// scheduler-generated invocation recorded but not dispatched, asserting
// `result.status === "disabled"`) tested exactly that now-deleted runtime
// skip — its two version: 3 fixtures are gone with it, not merely
// unreachable: a version: 3 document now fails TASK_SCHEMA_VERSION_UNSUPPORTED
// before runTask ever sees it (row B-14).

describe("resolveAkmInvocation", () => {
  function packageLauncher(packageRoot: string): string {
    const fixtureDir = path.join(packageRoot, "dist");
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"akm-cli"}\n');
    const launcher = path.join(fixtureDir, "akm");
    fs.writeFileSync(launcher, "#!/usr/bin/env node\n");
    return launcher;
  }

  test("binds a package owned by the active npm global root, including paths with spaces", () => {
    const globalRoot = path.join(tmpRoot, "npm prefix with spaces", "lib", "node_modules");
    const launcher = packageLauncher(path.join(globalRoot, "akm-cli"));
    const r = resolveAkmInvocation({
      env: {},
      runtime: "node",
      execPath: "/usr/bin/node",
      launcherPath: launcher,
      nodePath: "/usr/bin/node",
      resolveNpmGlobalRoot: () => globalRoot,
    });
    expect(r).toEqual({ argv: ["/usr/bin/node", launcher], via: "npm", kind: "npm", eligible: true });
  });

  test("classifies a project-local node_modules package as ineligible", () => {
    const launcher = packageLauncher(path.join(tmpRoot, "project", "node_modules", "akm-cli"));
    const globalRoot = path.join(tmpRoot, "global", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath: "/usr/bin/node",
        resolveNpmGlobalRoot: () => globalRoot,
      }),
    ).toEqual({
      argv: ["/usr/bin/node", launcher],
      via: "package-local",
      kind: "package-local",
      eligible: false,
    });
  });

  test("classifies an npm exec cache package as ineligible", () => {
    const launcher = packageLauncher(path.join(tmpRoot, ".npm", "_npx", "abc123", "node_modules", "akm-cli"));
    const globalRoot = path.join(tmpRoot, "global-cache-case", "lib", "node_modules");
    fs.mkdirSync(globalRoot, { recursive: true });

    const result = resolveAkmInvocation({
      env: {},
      runtime: "node",
      launcherPath: launcher,
      nodePath: "/usr/bin/node",
      resolveNpmGlobalRoot: () => globalRoot,
    });

    expect(result.kind).toBe("package-local");
    expect(result.eligible).toBe(false);
  });

  test("fails closed when npm global-root resolution is unavailable", () => {
    const launcher = packageLauncher(path.join(tmpRoot, "unresolved-package", "akm-cli"));
    const nodePath = path.join(tmpRoot, "node-without-npm", "bin", "node");
    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath,
      }),
    ).toMatchObject({ argv: [nodePath, launcher], via: "package-local", kind: "package-local", eligible: false });
  });

  test("accepts a package-local install this process cannot write to (image-baked, read-only mount)", () => {
    const launcher = packageLauncher(path.join(tmpRoot, "opt", "openpalm", "tools", "akm-cli"));
    const nodePath = path.join(tmpRoot, "node-without-npm", "bin", "node");
    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath,
        isPathWritable: () => false,
      }),
    ).toEqual({ argv: [nodePath, launcher], via: "package-local", kind: "package-local", eligible: true });
  });

  test("accepts an npm global package under an NVM-style prefix", () => {
    const prefix = path.join(tmpRoot, ".nvm", "versions", "node", "v22.14.0");
    const nodePath = path.join(prefix, "bin", "node");
    const globalRoot = path.join(prefix, "lib", "node_modules");
    const launcher = packageLauncher(path.join(globalRoot, "akm-cli"));

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        launcherPath: launcher,
        nodePath,
        resolveNpmGlobalRoot: (bootstrapNode) => {
          expect(bootstrapNode).toBe(nodePath);
          return globalRoot;
        },
      }),
    ).toEqual({ argv: [nodePath, launcher], via: "npm", kind: "npm", eligible: true });
  });

  test("classifies a source CLI invocation as checkout-only", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "/usr/bin/bun",
      mainPath: path.resolve(import.meta.dir, "../../../src/cli.ts"),
    });
    expect(r).toEqual({
      argv: ["/usr/bin/bun", path.resolve(import.meta.dir, "../../../src/cli.ts")],
      via: "checkout",
      kind: "checkout",
      eligible: false,
    });
  });

  test("uses cli-node.mjs rather than dist/cli.js for a direct Node checkout", () => {
    const dist = path.join(tmpRoot, "node-checkout", "dist");
    const tasks = path.join(dist, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    const modulePath = path.join(tasks, "resolve-akm-bin.js");
    const cliPath = path.join(dist, "cli.js");
    const wrapperPath = path.join(dist, "cli-node.mjs");
    fs.writeFileSync(modulePath, "");
    fs.writeFileSync(cliPath, "");
    fs.writeFileSync(wrapperPath, "");

    expect(
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        execPath: "/usr/bin/node",
        mainPath: cliPath,
        cliEntryUrl: pathToFileURL(modulePath).href,
      }),
    ).toEqual({
      argv: ["/usr/bin/node", wrapperPath],
      via: "checkout",
      kind: "checkout",
      eligible: false,
    });
  });

  test("refuses a direct Node checkout when cli-node.mjs is unavailable", () => {
    const dist = path.join(tmpRoot, "node-checkout-missing-wrapper", "dist");
    const tasks = path.join(dist, "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    const modulePath = path.join(tasks, "resolve-akm-bin.js");
    const cliPath = path.join(dist, "cli.js");
    fs.writeFileSync(modulePath, "");
    fs.writeFileSync(cliPath, "");

    expect(() =>
      resolveAkmInvocation({
        env: {},
        runtime: "node",
        execPath: "/usr/bin/node",
        mainPath: cliPath,
        cliEntryUrl: pathToFileURL(modulePath).href,
      }),
    ).toThrow("Cannot resolve absolute path");
  });

  test("ignores unrelated environment variables during scheduler resolution", () => {
    expect(
      resolveAkmInvocation({
        env: { AKM_BIN: "/opt/vendor/akm" },
        runtime: "bun",
        execPath: "/opt/akm",
        mainPath: "/$bunfs/root/src/cli.ts",
      }),
    ).toEqual({ argv: ["/opt/akm"], via: "standalone", kind: "standalone", eligible: true });
  });

  test("uses only the executable for a Bun standalone build", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "/opt/akm",
      mainPath: "/$bunfs/root/src/cli.ts",
    });
    expect(r).toEqual({ argv: ["/opt/akm"], via: "standalone", kind: "standalone", eligible: true });
  });

  test("uses only the executable for a Windows Bun standalone build", () => {
    const r = resolveAkmInvocation({
      env: {},
      runtime: "bun",
      execPath: "D:\\akm\\akm.exe",
      mainPath: "B:\\~BUN\\root\\src\\cli.ts",
    });
    expect(r).toEqual({
      argv: ["D:\\akm\\akm.exe"],
      via: "standalone",
      kind: "standalone",
      eligible: true,
    });
  });

  // #901: `akm task sync --rebind` used to spawn `npm root --global` once per
  // resolveAkmInvocation() call — two per sync cycle — leaving behind an npm
  // debug log every time even though every spawn succeeded. The probe result
  // can't change within a process, so it must be memoized. Rather than
  // stubbing out the probe (which would bypass the memoization under test),
  // this drives the REAL default `resolveNpmGlobalRoot` path: `nodePath` is a
  // POSIX shebang script that stands in for `node`, counting how many times
  // it is actually invoked via a marker file, with a real `npm-cli.js` file
  // beside it so `resolveAssociatedNpmCli` finds it and the probe proceeds to
  // spawn.
  test.skipIf(process.platform === "win32")(
    "resolveAkmInvocation spawns the npm-global-root probe at most once per process (#901)",
    () => {
      const fakeBin = path.join(tmpRoot, "npm-probe-memo", "bin");
      fs.mkdirSync(path.join(fakeBin, "node_modules", "npm", "bin"), { recursive: true });
      const spawnCountFile = path.join(tmpRoot, "npm-probe-memo", "spawn-count");
      fs.writeFileSync(spawnCountFile, "");

      const fakeNode = path.join(fakeBin, "node");
      fs.writeFileSync(
        fakeNode,
        ["#!/usr/bin/env bash", `echo x >> ${JSON.stringify(spawnCountFile)}`, "echo /fake/npm/global/root", ""].join(
          "\n",
        ),
      );
      fs.chmodSync(fakeNode, 0o755);
      fs.writeFileSync(path.join(fakeBin, "node_modules", "npm", "bin", "npm-cli.js"), "");

      const launcher = packageLauncher(path.join(tmpRoot, "npm-probe-memo-package", "akm-cli"));

      for (let i = 0; i < 3; i++) {
        resolveAkmInvocation({ env: {}, runtime: "node", launcherPath: launcher, nodePath: fakeNode });
      }

      const spawnCount = fs
        .readFileSync(spawnCountFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0).length;
      expect(spawnCount).toBe(1);
    },
  );
});
