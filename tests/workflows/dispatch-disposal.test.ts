// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { disposeDispatchResources } from "../../src/integrations/agent/runner-dispatch";
import { runOpencodeSdk } from "../../src/integrations/harnesses/opencode/embedded/run";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../src/workflows/validate-summary";
import { installFakeOpencodeHost } from "../_helpers/fake-opencode-host";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

/**
 * Process-lifecycle disposal (owner finding 4 — a successful engine-driven run
 * with LIVE agent dispatch hung the CLI until the 10-minute tool timeout).
 *
 * Root cause: the SDK dispatch path caches `opencode serve` CHILD PROCESSES in
 * a per-env registry for reuse across units. Each live child is an OS handle
 * that keeps Bun's event loop OPEN, and the registry's ONLY teardown was wired
 * to `process.once('exit')` — which never fires while a child holds the loop
 * open. The CLI (`akm workflow run`) has no `process.exit` on success; it relies
 * on the loop draining, so the leaked child hangs it forever. That is a
 * deadlock: the exit hook cannot free a process the child is keeping alive.
 *
 * Fix: the engine DRAINS the dispatch registry in its run `finally`, on every
 * exit path, so the process exits cleanly. These tests pin:
 *   (A) `runWorkflowSteps` invokes the disposal seam on EVERY exit path
 *       (success, gate rejection, failure, caller abort, terminal no-op).
 *   (B) `disposeDispatchResources()` actually tears down the SDK server registry
 *       (closes every cached server, synchronously, and empties the registry).
 *   (C) end-to-end: a real engine run that dispatches via the SDK runner closes
 *       the (fake-factory) server by the time the run resolves — before the
 *       process would ever reach its exit hook.
 */

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
});

afterEach(() => {
  storage.cleanup();
});

function writeProgram(name: string, markdown: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, "utf8");
}

// Unified-format one-step workflow (frontmatter graph + `## <id>` body; gate
// rubric in the body's `### gate`, control key in frontmatter — spec §2.2/§2.4).
const oneStep = (_name: string, withGate = false): string =>
  [
    "---",
    "type: workflow",
    "description: Dispatch-disposal fixture.",
    "defaults:",
    "  engine: test-agent",
    "steps:",
    "  - id: only",
    ...(withGate ? ["    gate: { max_loops: 2 }"] : []),
    "---",
    "",
    "## only",
    "",
    "Do the thing.",
    ...(withGate ? ["", "### gate", "", "- the thing is complete"] : []),
    "",
  ].join("\n");

const rejectingJudge: SummaryJudge = async () => '{"complete": false, "missing": ["the thing"]}';

// ── (A) engine finally drains on EVERY exit path ─────────────────────────────
//
// A fake `dispatcher` short-circuits real dispatch (no SDK server ever starts),
// and an injected `disposeDispatchResources` spy proves the engine's `finally`
// calls the drain regardless of how the run ends. This is the regression that
// fails without the finally wiring: the spy is never called.

describe("runWorkflowSteps drains dispatch resources on every exit path", () => {
  test("success path: drain called exactly once", async () => {
    writeProgram("drain-ok", oneStep("drain-ok"));
    const started = await startWorkflowRun("workflows/drain-ok", {});
    let drains = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      disposeDispatchResources: () => {
        drains++;
      },
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(result.done).toBe(true);
    expect(drains).toBe(1);
  });

  test("gate-rejection path: drain called", async () => {
    writeProgram("drain-gate", oneStep("drain-gate", /* withGate */ true));
    const started = await startWorkflowRun("workflows/drain-gate", {});
    let drains = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: rejectingJudge,
      disposeDispatchResources: () => {
        drains++;
      },
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(result.gateRejection?.stepId).toBe("only");
    expect(drains).toBe(1);
  });

  test("failure path (dispatcher throws): drain still called", async () => {
    writeProgram("drain-fail", oneStep("drain-fail"));
    const started = await startWorkflowRun("workflows/drain-fail", {});
    let drains = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      disposeDispatchResources: () => {
        drains++;
      },
      dispatcher: async () => {
        throw new Error("harness exploded");
      },
    });
    expect(result.run.status).toBe("failed");
    expect(drains).toBe(1);
  });

  test("caller-abort path: drain still called", async () => {
    writeProgram("drain-abort", oneStep("drain-abort"));
    const started = await startWorkflowRun("workflows/drain-abort", {});
    const controller = new AbortController();
    controller.abort();
    let drains = 0;
    let dispatches = 0;
    const result = await runWorkflowSteps({
      target: started.run.id,
      signal: controller.signal,
      summaryJudge: null,
      disposeDispatchResources: () => {
        drains++;
      },
      dispatcher: async () => {
        dispatches++;
        return { ok: true, text: "must not run" };
      },
    });
    // The aborted signal breaks the loop before dispatch; the run stays active…
    expect(dispatches).toBe(0);
    expect(result.run.status).toBe("active");
    // …and the finally drained anyway.
    expect(drains).toBe(1);
  });

  test("terminal no-op path (already-completed run): drain still called", async () => {
    writeProgram("drain-noop", oneStep("drain-noop"));
    const started = await startWorkflowRun("workflows/drain-noop", {});
    const runId = started.run.id;
    // Drive to completion first.
    const done = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    expect(done.done).toBe(true);
    // Re-invoke: a completed run is a pure no-op, but the drain still fires.
    let drains = 0;
    const noop = await runWorkflowSteps({
      target: runId,
      summaryJudge: null,
      disposeDispatchResources: () => {
        drains++;
      },
      dispatcher: async () => ({ ok: true, text: "must not run" }),
    });
    expect(noop.done).toBe(true);
    expect(drains).toBe(1);
  });

  test("a throwing drain never masks the run's own result", async () => {
    writeProgram("drain-throws", oneStep("drain-throws"));
    const started = await startWorkflowRun("workflows/drain-throws", {});
    const result = await runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      disposeDispatchResources: () => {
        throw new Error("close blew up");
      },
      dispatcher: async () => ({ ok: true, text: "done" }),
    });
    // The disposal error was swallowed; the run's success is preserved.
    expect(result.done).toBe(true);
  });

  test("awaits asynchronous disposal before resolving the workflow run", async () => {
    writeProgram("drain-awaited", oneStep("drain-awaited"));
    const started = await startWorkflowRun("workflows/drain-awaited", {});
    let release!: () => void;
    const disposalBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const running = runWorkflowSteps({
      target: started.run.id,
      summaryJudge: null,
      dispatcher: async () => ({ ok: true, text: "done" }),
      disposeDispatchResources: () => disposalBlocked,
    }).then((result) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    release();
    expect((await running).done).toBe(true);
  });
});

// ── (B) the disposal seam actually tears down the SDK registry ───────────────

describe("disposeDispatchResources closes the embedded OpenCode hosts", () => {
  test("closes every cached host so the next dispatch starts a fresh one", async () => {
    const { lifecycle } = installFakeOpencodeHost({ reply: () => "ok" });
    const profile = { name: "mysdk", bin: "", args: [] } as never;
    // The host is shared: sessions with different models run on the one cached host.
    await runOpencodeSdk(profile, "p", { timeoutMs: null }, { endpoint: "http://lab.invalid/v1", model: "a" });
    await runOpencodeSdk(profile, "p", { timeoutMs: null }, { endpoint: "http://lab.invalid/v1", model: "b" });
    expect(lifecycle.created).toBe(1);

    await disposeDispatchResources();
    expect(lifecycle.closed).toBe(1);

    await runOpencodeSdk(profile, "p", { timeoutMs: null }, { endpoint: "http://lab.invalid/v1", model: "a" });
    expect(lifecycle.created).toBe(2);
  });

  test("awaits a host still starting and closes it before disposal resolves", async () => {
    let start!: () => void;
    const ready = new Promise<void>((resolve) => {
      start = resolve;
    });
    const { lifecycle } = installFakeOpencodeHost({ reply: () => "ok", ready });
    const running = runOpencodeSdk(
      { name: "mysdk", bin: "", args: [] } as never,
      "p",
      { timeoutMs: null },
      {
        endpoint: "http://lab.invalid/v1",
        model: "a",
      },
    );
    await Promise.resolve();

    let disposed = false;
    const disposal = disposeDispatchResources().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    start();
    await disposal;
    await running;
    expect(lifecycle.closed).toBe(1);
  });
});

// ── (C) end-to-end: an engine run that dispatches via the SDK runner ─────────
//
// No `dispatcher` seam here — the run goes through the REAL native-executor →
// runner-dispatch → runOpencodeSdk → getOrStartServer path, backed by a fake
// `createOpencode` factory (there is no `opencode` binary in the sandbox). The
// fake server's `close()` is a spy: before the fix the engine never drains, so
// the server stays open past the run; after the fix the engine `finally` closes
// it the moment the run resolves — the exact hang the owner observed, headless.

describe("engine run via the SDK runner closes its host on completion (end-to-end)", () => {
  test("a successful sdk-dispatched run leaves no host open when it resolves", async () => {
    writeProgram("sdk-e2e", oneStep("sdk-e2e"));
    const { calls, lifecycle } = installFakeOpencodeHost({ reply: () => "sdk-done" });

    const started = await startWorkflowRun("workflows/sdk-e2e", {});
    const result = await runWorkflowSteps({ target: started.run.id, summaryJudge: null });

    // The real runner path ran (the fake host answered the prompt)…
    expect(calls).toHaveLength(1);
    expect(result.done).toBe(true);
    // …and the engine's finally closed the host it opened.
    expect(lifecycle.closed).toBe(lifecycle.created);
  });
});
