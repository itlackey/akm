// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { disposeDispatchResources } from "../../src/integrations/agent/runner-dispatch";
import {
  __setServerFactory,
  __setTestServer,
  closeServer,
  runOpencodeSdk,
} from "../../src/integrations/harnesses/opencode-sdk/sdk-runner";
import { runWorkflowSteps } from "../../src/workflows/exec/run-workflow";
import { startWorkflowRun } from "../../src/workflows/runtime/runs";
import type { SummaryJudge } from "../../src/workflows/validate-summary";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../_helpers/sandbox";

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

function writeProgram(name: string, yamlText: string): void {
  const file = path.join(storage.stashDir, "workflows", `${name}.yaml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yamlText, "utf8");
}

const oneStep = (name: string, withGate = false): string =>
  [
    "version: 2",
    `name: ${name}`,
    "defaults:",
    "  engine: test-agent",
    "steps:",
    "  - id: only",
    "    title: Only",
    "    unit:",
    "      instructions: Do the thing.",
    ...(withGate ? ["    gate:", "      criteria: [the thing is complete]"] : []),
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
    const started = await startWorkflowRun("workflow:drain-ok", {});
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
    const started = await startWorkflowRun("workflow:drain-gate", {});
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
    const started = await startWorkflowRun("workflow:drain-fail", {});
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
    const started = await startWorkflowRun("workflow:drain-abort", {});
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
    const started = await startWorkflowRun("workflow:drain-noop", {});
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
    const started = await startWorkflowRun("workflow:drain-throws", {});
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
    const started = await startWorkflowRun("workflow:drain-awaited", {});
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

describe("disposeDispatchResources drains the SDK server registry", () => {
  const ENV_KEY = "AKM_DISPOSE_TEST_ENV";

  afterEach(() => {
    __setServerFactory(null);
    __setTestServer(null);
    closeServer();
  });

  test("closes every cached server and empties the registry so the next dispatch starts fresh", async () => {
    const closes: string[] = [];
    let started = 0;
    __setServerFactory(((options: { port?: number }) => {
      started++;
      const tag = options.port ? `port-${options.port}` : "default";
      return Promise.resolve({
        client: {
          session: {
            create: async () => ({ data: { id: `sess-${started}` } }),
            prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
            delete: async () => ({}),
          },
        },
        server: {
          close() {
            closes.push(tag);
          },
        },
      });
    }) as never);

    const profile = { name: "mysdk", bin: "opencode", args: [] } as never;
    // Populate the registry: the default (no-env) server plus an env-keyed one
    // on its own OS-allocated port.
    await runOpencodeSdk(profile, "p", { timeoutMs: null });
    await runOpencodeSdk(profile, "p", { env: { [ENV_KEY]: "v" }, timeoutMs: null });
    expect(started).toBe(2);

    // The drain the engine calls closes BOTH cached servers synchronously.
    await disposeDispatchResources();
    expect(closes.length).toBe(2);
    expect(closes.every((tag) => tag.startsWith("port-"))).toBe(true);

    // Registry emptied: the next dispatch starts a fresh server (start count bumps).
    await runOpencodeSdk(profile, "p", { timeoutMs: null });
    expect(started).toBe(3);
  });

  test("awaits an in-flight server start and closes the late server before disposal resolves", async () => {
    let resolveFactory!: (server: never) => void;
    let factoryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      factoryStarted = resolve;
    });
    let closed = 0;
    __setServerFactory((() => {
      factoryStarted();
      return new Promise((resolve) => {
        resolveFactory = resolve;
      });
    }) as never);
    const profile = { name: "mysdk", bin: "opencode", args: [] } as never;
    const running = runOpencodeSdk(profile, "p", { timeoutMs: null });
    await started;

    let disposed = false;
    const disposal = disposeDispatchResources().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    resolveFactory({
      client: {
        session: {
          create: async () => ({ data: { id: "late" } }),
          prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
          delete: async () => ({}),
        },
      },
      server: {
        close() {
          closed++;
        },
      },
    } as never);
    await disposal;
    await running;
    expect(closed).toBe(1);
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

describe("engine run via the SDK runner closes its server on completion (end-to-end)", () => {
  afterEach(() => {
    __setServerFactory(null);
    __setTestServer(null);
    closeServer();
  });

  test("a successful sdk-dispatched run leaves no server open when it resolves", async () => {
    writeSandboxConfig({
      engines: { "test-agent": { kind: "agent", platform: "opencode-sdk" } },
      defaults: { engine: "test-agent" },
    });
    writeProgram("sdk-e2e", oneStep("sdk-e2e"));

    let closed = 0;
    let prompted = 0;
    __setServerFactory((() =>
      Promise.resolve({
        client: {
          session: {
            create: async () => ({ data: { id: "sess-e2e" } }),
            prompt: async () => {
              prompted++;
              return { data: { parts: [{ type: "text", text: "sdk-done" }] } };
            },
            delete: async () => ({}),
          },
        },
        server: {
          close() {
            closed++;
          },
        },
      })) as never);

    const started = await startWorkflowRun("workflow:sdk-e2e", {});
    const result = await runWorkflowSteps({ target: started.run.id, summaryJudge: null });

    // The real SDK path ran (the fake server answered the prompt)…
    expect(prompted).toBe(1);
    expect(result.done).toBe(true);
    // …and the cached server was CLOSED by the engine's finally — the process
    // would exit cleanly instead of hanging on the leaked child handle.
    expect(closed).toBe(1);
  });
});
