// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level contract tests for the workflow driver family, pinning the exit
 * code + JSON envelope the module-level suites (run-lease, watch) prove only at
 * the function boundary:
 *
 *   - `akm workflow complete` is refused at the CLI while a LIVE engine lease is
 *     held; the {ok:false} error envelope (exit 2) names the holder so a scripted
 *     driver knows to back off (module coverage: run-lease.test.ts).
 *   - `akm workflow watch <run>` streams a seeded TERMINAL run's backlog as
 *     NDJSON and stamps the `workflow-watch` envelope — both in plain backlog
 *     mode (no sleep) and in `--stream` mode with a fast interval (the single
 *     idle grace poll), against an already-completed run.
 *   - `akm workflow validate <origin>//workflow:<name>` resolves an
 *     origin-qualified ref through the source search, exactly like
 *     `workflow start`/`status`/`next`; an unknown origin-qualified ref is a
 *     clean UsageError, not a crash.
 *
 * Driven in-process via `runCliCapture` against per-test isolated storage
 * (`withIsolatedAkmStorage`) — no real agent binary, LLM, git, or subprocess, so
 * the suite stays deterministic, order-independent, and parallel-safe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EventEnvelope } from "../../../src/core/events";
import { _setWarnSinkForTests } from "../../../src/core/warn";
import { withWorkflowRunsRepo } from "../../../src/storage/repositories/workflow-runs-repository";
import { completeWorkflowStep, startWorkflowRun } from "../../../src/workflows/runtime/runs";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";
import { withSeam } from "../../_helpers/seams";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => storage.cleanup());

const extraDirs: string[] = [];

afterEach(() => {
  for (const dir of extraDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Write a single-step workflow markdown into a stash's `workflows/` dir. */
function writeSingleStepWorkflow(stashDir: string, name: string): void {
  const file = path.join(stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "---",
      "description: Driver CLI test workflow",
      "---",
      "",
      `# Workflow: ${name}`,
      "",
      "## Step: Only Step",
      "Step ID: only-step",
      "",
      "### Instructions",
      "Do the watched thing.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Split watch stdout into the leading compact NDJSON event lines and the
 * trailing command envelope. Under `--json` the event lines are compact
 * (one object per line, from the raw `emit`) while the summary envelope is
 * pretty-printed across multiple lines (from `output()`), so the envelope
 * begins at the first bare `{` line.
 */
function splitWatchOutput(stdout: string): { events: EventEnvelope[]; envelope: Record<string, unknown> } {
  const lines = stdout.split("\n");
  const envStart = lines.findIndex((l) => l.trim() === "{");
  if (envStart === -1) {
    // Compact fallback: every non-empty line is a JSON object; last is envelope.
    const objs = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { events: objs.slice(0, -1) as unknown as EventEnvelope[], envelope: objs[objs.length - 1] ?? {} };
  }
  const events = lines
    .slice(0, envStart)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EventEnvelope);
  const envelope = JSON.parse(lines.slice(envStart).join("\n")) as Record<string, unknown>;
  return { events, envelope };
}

describe("akm workflow complete — refused while a live engine lease is held (CLI envelope)", () => {
  test("the {ok:false} error envelope names the holder and exits 2", async () => {
    writeSingleStepWorkflow(storage.stashDir, "lease-block");
    const started = await startWorkflowRun("workflows/lease-block", {});
    const runId = started.run.id;

    // Plant a LIVE engine lease directly (simulates an engine driving the run).
    await withWorkflowRunsRepo((repo) => {
      expect(repo.acquireEngineLease(runId, "engine-XYZ", isoIn(90_000), new Date().toISOString())).toBe(true);
    });

    const { code, stderr } = await runCliCapture([
      "--json",
      "workflow",
      "complete",
      runId,
      "--step",
      "only-step",
      "--summary",
      "Tried to complete it by hand while the engine drives.",
    ]);

    expect(code).toBe(2);
    const env = JSON.parse(stderr) as { ok: boolean; error: string };
    expect(env.ok).toBe(false);
    expect(env.error).toContain("engine-XYZ");
    expect(env.error).toMatch(/being driven by engine|run lease/);

    // The refusal did not advance the step — it is still the current step.
    const { stdout } = await runCliCapture(["--json", "workflow", "status", runId]);
    const status = JSON.parse(stdout) as { run: { currentStepId: string; status: string } };
    expect(status.run.currentStepId).toBe("only-step");
    expect(status.run.status).toBe("active");
  });
});

describe("akm workflow watch — CLI backlog + --stream against a seeded terminal run", () => {
  async function seedCompletedRun(name: string): Promise<string> {
    writeSingleStepWorkflow(storage.stashDir, name);
    const started = await startWorkflowRun(`workflows/${name}`, {});
    await completeWorkflowStep({
      runId: started.run.id,
      stepId: "only-step",
      status: "completed",
      summary: "Drove the only step to completion.",
      summaryJudge: null,
    });
    return started.run.id;
  }

  test("backlog mode prints the run's workflow_* events as NDJSON then stamps the envelope", async () => {
    const runId = await seedCompletedRun("watch-cli-backlog");
    const { code, stdout } = await runCliCapture(["--json", "workflow", "watch", runId]);
    expect(code).toBe(0);

    const { events, envelope } = splitWatchOutput(stdout);
    // Every emitted event line belongs to this run's workflow_* family.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.eventType.startsWith("workflow_")).toBe(true);
      expect(event.metadata?.runId).toBe(runId);
    }
    // The trailing envelope is the machine-readable summary.
    expect(envelope.ok).toBe(true);
    expect(envelope.shape).toBe("workflow-watch");
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.status).toBe("completed");
    expect(envelope.streamed).toBe(false);
    expect(envelope.eventCount).toBe(events.length);
  });

  test("--stream with a fast interval drains the backlog of an already-terminal run and exits", async () => {
    const runId = await seedCompletedRun("watch-cli-stream");
    const { code, stdout } = await runCliCapture([
      "--json",
      "workflow",
      "watch",
      runId,
      "--stream",
      "--interval-ms",
      "5",
    ]);
    expect(code).toBe(0);

    const { events, envelope } = splitWatchOutput(stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe("completed");
    expect(envelope.streamed).toBe(true);
    expect(envelope.eventCount).toBe(events.length);
  });

  test("an unknown run id is a structured WORKFLOW_NOT_FOUND envelope, not an empty stream", async () => {
    const { code, stderr } = await runCliCapture([
      "--json",
      "workflow",
      "watch",
      "00000000-0000-4000-8000-000000000000",
    ]);
    expect(code).toBe(1);
    const env = JSON.parse(stderr) as { ok: boolean; code: string };
    expect(env.ok).toBe(false);
    expect(env.code).toBe("WORKFLOW_NOT_FOUND");
  });
});

describe("akm workflow validate — origin-qualified refs resolve through the source search", () => {
  function makeExtraStash(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akm-wf-extra-"));
    extraDirs.push(dir);
    fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
    return dir;
  }

  test("validate <origin>//workflow:<name> validates the file that ref would start", async () => {
    const extraStash = makeExtraStash();
    writeSingleStepWorkflow(extraStash, "shared-flow");
    writeSandboxConfig({
      semanticSearchMode: "off",
      sources: [{ type: "filesystem", path: extraStash, name: "extra" }],
    });
    expect((await runCliCapture(["index", "--full"])).code).toBe(0);

    const { code, stdout } = await runCliCapture(["--json", "workflow", "validate", "extra//workflow:shared-flow"]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; title: string; stepCount: number };
    expect(env.ok).toBe(true);
    expect(env.stepCount).toBe(1);
    expect(env.title).toBe("shared-flow");
  });

  test("a bare workflow:<name> ref in the primary stash also validates", async () => {
    writeSingleStepWorkflow(storage.stashDir, "primary-flow");
    const { code, stdout } = await runCliCapture(["--json", "workflow", "validate", "workflows/primary-flow"]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; stepCount: number };
    expect(env.ok).toBe(true);
    expect(env.stepCount).toBe(1);
  });

  test("an unknown origin-qualified ref is a clean UsageError, not a crash", async () => {
    writeSandboxConfig({ semanticSearchMode: "off", sources: [] });
    const { code, stderr } = await runCliCapture(["--json", "workflow", "validate", "nowhere//workflow:missing-flow"]);
    expect(code).toBe(2);
    const env = JSON.parse(stderr) as { ok: boolean; error: string };
    expect(env.ok).toBe(false);
    expect(env.error).toMatch(/not found|No sources|origin/i);
  });
});

describe("akm workflow validate — non-fatal WARNINGS surface additively (ok stays true)", () => {
  /** Write a YAML program that trips both warnings: undeclared param + untyped step. */
  function writeWarnyProgram(stashDir: string, name: string): string {
    const file = path.join(stashDir, "workflows", `${name}.yaml`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "version: 2",
        `name: ${name}`,
        "params:",
        "  changed_files: { type: array }",
        "steps:",
        "  - id: review",
        "    unit:",
        `      instructions: Review \${{ params.changed_file }}.`,
        "",
      ].join("\n"),
      "utf8",
    );
    return file;
  }

  test("--json validate reports ok:true with an additive warnings array (both warnings)", async () => {
    const file = writeWarnyProgram(storage.stashDir, "warny");
    const { code, stdout } = await runCliCapture(["--json", "workflow", "validate", file]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as {
      ok: boolean;
      format: string;
      warnings: Array<{ line: number; message: string }>;
    };
    expect(env.ok).toBe(true);
    expect(env.format).toBe("program");
    expect(env.warnings.length).toBe(2);
    expect(env.warnings.some((w) => /no `output:` schema/.test(w.message))).toBe(true);
    expect(env.warnings.some((w) => /params\.changed_file.*not declared/.test(w.message))).toBe(true);
    for (const w of env.warnings) expect(typeof w.line).toBe("number");
  });

  test("text validate prints the warnings clearly marked below the ok line", async () => {
    const file = writeWarnyProgram(storage.stashDir, "warny-text");
    const { code, stdout } = await runCliCapture(["--format", "text", "workflow", "validate", file]);
    expect(code).toBe(0);
    expect(stdout).toContain("workflow validate: ok");
    expect(stdout).toContain("2 warning(s):");
    expect(stdout).toMatch(/warning: .*:\d+ —/);
  });

  test("a fully-typed, fully-declared program validates with an empty warnings array", async () => {
    const file = path.join(storage.stashDir, "workflows", "clean.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        "version: 2",
        "name: clean",
        "params:",
        "  changed_files: { type: array }",
        "steps:",
        "  - id: review",
        "    unit:",
        `      instructions: Review \${{ params.changed_files }}.`,
        "    output: { type: object }",
        "",
      ].join("\n"),
      "utf8",
    );
    const { code, stdout } = await runCliCapture(["--json", "workflow", "validate", file]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as { ok: boolean; warnings: unknown[] };
    expect(env.ok).toBe(true);
    expect(env.warnings).toEqual([]);
  });

  test("markdown validate carries no warnings key at all (warning-free frontend)", async () => {
    writeSingleStepWorkflow(storage.stashDir, "md-flow");
    const file = path.join(storage.stashDir, "workflows", "md-flow.md");
    const { code, stdout } = await runCliCapture(["--json", "workflow", "validate", file]);
    expect(code).toBe(0);
    const env = JSON.parse(stdout) as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env).not.toHaveProperty("warnings");
  });

  test("workflow start emits the program's warnings as non-fatal warn() lines (stderr)", async () => {
    writeWarnyProgram(storage.stashDir, "warny-start");
    const captured: string[] = [];
    await withSeam(
      _setWarnSinkForTests,
      (level, args) => {
        if (level === "warn") captured.push(args.map((a) => String(a)).join(" "));
      },
      async () => {
        const started = await startWorkflowRun("workflows/warny-start");
        // Non-fatal: the run still starts.
        expect(started.run.status).toBe("active");
      },
    );
    const joined = captured.join("\n");
    expect(joined).toMatch(/workflow start:.*no `output:` schema/);
    expect(joined).toMatch(/workflow start:.*params\.changed_file.*not declared/);
  });
});
