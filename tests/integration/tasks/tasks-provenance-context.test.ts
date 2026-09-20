// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P1b Lane C — ExecutionProvenanceContext (D5, spec §1.2 / §5.2 / §1.6 D5-N1).
 *
 * `tests/integration/tasks-provenance-characterization.test.ts` (the flipped
 * P0 file) proves the DEFAULT provenance context reproduces today's observable
 * behavior for each dispatch arm (P-06 unchanged; P-05 reclassified; R-07
 * fixed). This file is genuinely new coverage: it exercises the
 * `RunTaskOptions.provenance` OPTION itself — an explicit
 * `ExecutionProvenanceContext` overriding the default, threaded across all
 * three dispatch arms — plus the D5-N1 disambiguation (an authored
 * `--scheduled` flag does NOT select the event source; the default context's
 * `eventSource` is "task" whether or not the run is scheduled) and the
 * `akm task run` CLI boundary (§5.2 "Construction") that builds the context.
 *
 * Precedence rule under test throughout (spec §5.2, binding): an explicit
 * `provenance.eventSource` is only a FALLBACK — a recognized ambient
 * `AKM_EVENT_SOURCE` still wins everywhere it wins today (D5 clause d).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import type { AgentRunResult } from "../../../src/integrations/agent";
import { runTask } from "../../../src/tasks/run/run-task";
import { runCliCapture } from "../../_helpers/cli";
import { type IsolatedAkmStorage, withEnv, withIsolatedAkmStorage, writeSandboxConfig } from "../../_helpers/sandbox";

type FakeRunAgent = (...args: unknown[]) => Promise<AgentRunResult>;

let storage: IsolatedAkmStorage;
let tasksDir: string;
let workflowsDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  workflowsDir = path.join(storage.stashDir, "workflows");
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, "noop.md"),
    "---\ntype: workflow\nsteps:\n  - id: work\n---\n\n## work\n\nDo it.\n",
    "utf8",
  );
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
    engines: { opencode: { kind: "agent", platform: "opencode" } },
    defaults: { engine: "opencode" },
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

function queryUsageEventRows(): Array<{ event_type: string; entry_ref: string | null; source: string }> {
  const db = openStateDatabase();
  try {
    return db.prepare("SELECT event_type, entry_ref, source FROM usage_events ORDER BY id").all() as Array<{
      event_type: string;
      entry_ref: string | null;
      source: string;
    }>;
  } finally {
    db.close();
  }
}

function clearUsageEvents(): void {
  const db = openStateDatabase();
  db.exec("DELETE FROM usage_events");
  db.close();
}

/** Inline "script" whose only job is to echo its own AKM_EVENT_SOURCE. */
const ECHO_SOURCE_SNIPPET = "console.log('AKM_EVENT_SOURCE=' + (process.env.AKM_EVENT_SOURCE ?? '<unset>'))";

function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellTask(command: readonly string[]): string {
  const run = command.map((value) => shellWord(value)).join(" ");
  // Fixture bug fix (pre-existing, unrelated to any P1b authorized flip): the
  // shell-quoted `run` value itself contains YAML-significant `'` characters
  // (the shellWord POSIX-quoting idiom), so it cannot be spliced into the
  // document as a bare/naively-templated scalar — that produced invalid YAML
  // ("Unexpected single-quoted-scalar at node end"), never actually exercised
  // while this file was red for unrelated (missing-API) reasons. Serialize
  // through `yaml`'s own stringifier instead, exactly as the sibling
  // characterization file's `shellTask` already does.
  return stringifyYaml({ version: 4, run });
}

describe("native (shell/script) arm reads provenance.eventSource, not a hardcoded literal", () => {
  test('an explicit provenance.eventSource overrides the "task" default in the child env', async () => {
    // NEW (D5, spec §5.2 point 1): "keep AKM_EVENT_SOURCE:
    // process.env.AKM_EVENT_SOURCE ?? provenance.eventSource in the child env
    // bag … With the default context this is byte-equivalent to today's ??
    // 'task'." — i.e. the literal "task" the P0/P-06 pin observes is now the
    // DEFAULT context's eventSource, not a hardcoded fallback: a caller
    // passing a non-default provenance context must see THAT value instead.
    // ExecutionProvenanceContext.eventSource is the narrow "user" | "task"
    // union (spec §5.2's type), not the full UsageEventSource enum — "user"
    // is the only legal non-default value a caller can construct.
    writeTask("native-explicit-source", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));

    const result = await runTask("native-explicit-source", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      provenance: { eventSource: "user", scheduled: false },
    } as never);

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=user");
  });

  test("a pre-set ambient AKM_EVENT_SOURCE still wins over an explicit non-default provenance.eventSource", async () => {
    // Precedence rule (spec §5.2, binding): an explicit context value is only
    // a FALLBACK. This is the native arm's instance of D5 clause (d). The
    // ambient value itself is not restricted to "user" | "task" — only the
    // CONTEXT's own eventSource field is.
    writeTask("native-ambient-wins", shellTask([process.execPath, "-e", ECHO_SOURCE_SNIPPET]));

    const result = await withEnv({ AKM_EVENT_SOURCE: "improve" }, () =>
      runTask("native-ambient-wins", {
        bundleDir: storage.stashDir,
        bundleName: "fixture",
        provenance: { eventSource: "user", scheduled: false },
      } as never),
    );

    expect(result.status).toBe("completed");
    expect(fs.readFileSync(result.log, "utf8")).toContain("AKM_EVENT_SOURCE=improve");
  });
});

describe("workflow arm threads an explicit provenance.eventSource to the eventSource option", () => {
  test("an explicit provenance.eventSource reaches runWorkflowSteps's eventSource option, and process.env is never mutated", async () => {
    writeTask("wf-explicit-source", "version: 4\nuses: workflows/noop\n");
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
    let observedDuring: string | undefined;
    let observedEventSourceOption: string | undefined;

    const result = await runTask("wf-explicit-source", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      provenance: { eventSource: "user", scheduled: false },
      runWorkflowStepsImpl: (async (options: {
        target: string;
        params?: Record<string, unknown>;
        eventSource?: string;
      }) => {
        observedDuring = process.env.AKM_EVENT_SOURCE;
        observedEventSourceOption = options.eventSource;
        return {
          run: {
            id: "run-wf-explicit-source",
            workflowRef: options.target,
            workflowTitle: "Noop",
            status: "completed" as const,
            params: options.params ?? {},
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            completedAt: "2025-01-01T00:00:00Z",
            currentStepId: null,
          },
          executed: [],
        };
      }) as never,
    } as never);

    expect(result.status).toBe("completed");
    expect(observedEventSourceOption).toBe("user");
    expect(observedDuring).toBeUndefined();
    expect(process.env.AKM_EVENT_SOURCE).toBeUndefined();
  });
});

describe("command/prompt arm threads an explicit provenance.eventSource end to end", () => {
  function writeStoredCommandTask(id: string): void {
    fs.writeFileSync(path.join(storage.stashDir, "commands", `${id}.md`), "Notify the team.\n", "utf8");
    writeTask(id, ["version: 4", `uses: commands/${id}`, "engine: opencode", ""].join("\n"));
  }

  test('an explicit provenance.eventSource=user overrides the "task" default in the dispatched engine env and the recorded usage-event row', async () => {
    // ExecutionProvenanceContext.eventSource is "user" | "task" only (spec
    // §5.2's type) — "user" is the meaningful non-default value a caller can
    // construct, contrasted against the DEFAULT-context "task" the test.each
    // block below pins for the very same arm.
    writeStoredCommandTask("prompt-explicit-source");
    await akmIndex({ stashDir: storage.stashDir, full: true });
    clearUsageEvents();

    let observedChildEnv: Record<string, string> | undefined;
    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const options = args[2] as { env?: Record<string, string> } | undefined;
      observedChildEnv = options?.env;
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };

    const result = await runTask("prompt-explicit-source", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      provenance: { eventSource: "user", scheduled: false },
      runAgentImpl: fakeRunAgent,
    } as never);

    expect(result.status).toBe("completed");
    expect(observedChildEnv).toMatchObject({ AKM_EVENT_SOURCE: "user" });
    expect(queryUsageEventRows()).toEqual([
      { event_type: "show", entry_ref: "fixture//commands/prompt-explicit-source", source: "user" },
    ]);
  });

  // D5-N1 (spec §1.6, binding disambiguation): "`scheduled: boolean` stays a
  // SEPARATE field on the context … It does NOT select the event source …
  // R-07's fix applies to every prompt/command task run, not only scheduled
  // ones." — with the DEFAULT context (no explicit `provenance` passed), the
  // command arm's eventSource is "task" REGARDLESS of `options.scheduled`.
  test.each([
    true,
    false,
    undefined,
  ])('the default provenance context resolves eventSource "task" for a prompt/command run regardless of options.scheduled (scheduled=%p)', async (scheduled) => {
    const id = `prompt-scheduled-${String(scheduled)}`;
    writeStoredCommandTask(id);
    await akmIndex({ stashDir: storage.stashDir, full: true });
    clearUsageEvents();

    let observedChildEnv: Record<string, string> | undefined;
    const fakeRunAgent: FakeRunAgent = async (...args) => {
      const options = args[2] as { env?: Record<string, string> } | undefined;
      observedChildEnv = options?.env;
      return { ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    };

    const result = await runTask(id, {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      ...(scheduled !== undefined ? { scheduled } : {}),
      runAgentImpl: fakeRunAgent,
    } as never);

    expect(result.status).toBe("completed");
    expect(observedChildEnv).toMatchObject({ AKM_EVENT_SOURCE: "task" });
    expect(queryUsageEventRows()).toEqual([
      { event_type: "show", entry_ref: `fixture//commands/${id}`, source: "task" },
    ]);
  });
});

describe('CLI boundary (D5 "Construction", spec §5.2): `akm task run` builds { eventSource: "task", scheduled }', () => {
  test("manual execution remains available while a scheduled invocation requires host-local activation", async () => {
    const id = "cli-local-activation";
    writeTask(id, "version: 4\nrun: 'true'\nschedule: '@daily'\n");

    const manual = await runCliCapture(["task", "run", id]);
    expect(manual.code, manual.stderr).toBe(0);

    const scheduled = await runCliCapture(["task", "run", id, "--scheduled"]);
    expect(scheduled.code).toBe(2);
    expect(scheduled.stderr).toContain("INVALID_FLAG_VALUE");
    expect(scheduled.stderr).toContain("not enabled in local scheduler config");
  });

  // §1.6 D5-N1's binding resolution, exercised through the REAL CLI entry
  // point (src/commands/tasks/tasks.ts's akmTasksRun) rather than a direct
  // runTask() call: `--scheduled` toggles `context.scheduled` only.
  // eventSource is "task" in BOTH cases — the R-07 fix is not conditioned on
  // the flag. A fake no-op agent binary (mirroring
  // tests/integration/usage-provenance-cli.test.ts) makes dispatch succeed
  // without a real engine.
  test.each([
    [],
    ["--scheduled"],
  ])('akm task run %s stamps a stored command dispatch\'s usage as "task"', async (...extraArgs) => {
    const id = `cli-prompt-${extraArgs.length > 0 ? "scheduled" : "unscheduled"}`;
    fs.writeFileSync(path.join(storage.stashDir, "commands", `${id}.md`), "Notify the team.\n", "utf8");
    writeTask(id, ["version: 4", `uses: commands/${id}`, "engine: cli-audit", ""].join("\n"));
    writeSandboxConfig({
      bundles: { fixture: { path: storage.stashDir, writable: true } },
      defaultBundle: "fixture",
      semanticSearchMode: "off",
      engines: { "cli-audit": { kind: "agent", platform: "aider", bin: "/bin/true" } },
      defaults: { engine: "cli-audit" },
      scheduler: { enabled: [{ kind: "task", ref: `fixture//tasks/${id}` }] },
    });
    const indexed = await runCliCapture(["index", "--full"]);
    expect(indexed.code, indexed.stderr).toBe(0);
    clearUsageEvents();

    const { code, stdout, stderr } = await runCliCapture(["task", "run", id, ...extraArgs]);

    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout).result.status).toBe("completed");
    expect(queryUsageEventRows()).toEqual([
      { event_type: "show", entry_ref: `fixture//commands/${id}`, source: "task" },
    ]);
  });
});

describe("F-3 (type-level only) — RunTaskOptions.bundleDir replaces stashDir", () => {
  // Scope note: the MECHANICAL rename across every OTHER existing
  // `RunTaskOptions` call site (tests/integration/tasks-runtime-v3-runner.test.ts
  // — the canary G-1 requires stay unchanged except for this exact
  // substitution — tests/integration/tasks-run-attempt-observability.test.ts,
  // tests/integration/tasks-runner.test.ts) belongs to the same commit as the
  // `src/tasks/run/**` rename itself, not to this lane's two new files or its
  // authorized flips. This test only pins the TYPE-LEVEL shape: a bare
  // `bundleDir` (no `stashDir` anywhere) is a complete, valid RunTaskOptions.
  test("runTask accepts bundleDir (no stashDir) and resolves the task normally", async () => {
    writeTask("bundledir-type-level", "version: 4\nuses: workflows/noop\n");

    const result = await runTask("bundledir-type-level", {
      bundleDir: storage.stashDir,
      bundleName: "fixture",
      runWorkflowStepsImpl: (async ({ target, params = {} }: { target: string; params?: Record<string, unknown> }) => ({
        run: {
          id: "run-bundledir-type-level",
          workflowRef: target,
          workflowTitle: "Noop",
          status: "completed" as const,
          params,
          createdAt: "2025-01-01T00:00:00Z",
          updatedAt: "2025-01-01T00:00:00Z",
          completedAt: "2025-01-01T00:00:00Z",
          currentStepId: null,
        },
        executed: [],
      })) as never,
    });

    expect(result.status).toBe("completed");
  });
});
