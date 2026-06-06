import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { resolveAgentIdentity } from "../../src/workflows/agent-identity";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runs";
import {
  type Cleanup,
  sandboxStashDir,
  sandboxXdgCacheHome,
  sandboxXdgConfigHome,
  sandboxXdgDataHome,
  withEnv,
} from "../_helpers/sandbox";

/**
 * Tests for issue #501 (narrowed slice): the workflow run record persists the
 * agent harness identifier and session id, and both are retrievable.
 *
 * This covers the tractable sub-feature of #501 / #506 — capturing *who* drives
 * a run — without introducing any background thread, timer, or daemon.
 */

// ── resolveAgentIdentity (pure, env-driven) ──────────────────────────────────

describe("resolveAgentIdentity", () => {
  test("returns nulls when no harness env is present", () => {
    const identity = resolveAgentIdentity({});
    expect(identity).toEqual({ harness: null, sessionId: null });
  });

  test("explicit AKM_AGENT_HARNESS / AKM_SESSION_ID win", () => {
    const identity = resolveAgentIdentity({
      AKM_AGENT_HARNESS: "custom-harness",
      AKM_SESSION_ID: "sess-123",
      CLAUDE_SESSION_ID: "ignored",
    });
    expect(identity).toEqual({ harness: "custom-harness", sessionId: "sess-123" });
  });

  test("infers claude-code from CLAUDE_SESSION_ID", () => {
    const identity = resolveAgentIdentity({ CLAUDE_SESSION_ID: "abc-def" });
    expect(identity).toEqual({ harness: "claude-code", sessionId: "abc-def" });
  });

  test("infers opencode from OPENCODE_SESSION_ID", () => {
    const identity = resolveAgentIdentity({ OPENCODE_SESSION_ID: "oc-7" });
    expect(identity).toEqual({ harness: "opencode", sessionId: "oc-7" });
  });

  test("ignores blank/whitespace-only env values", () => {
    const identity = resolveAgentIdentity({ AKM_AGENT_HARNESS: "   ", CLAUDE_SESSION_ID: "  cs  " });
    // blank harness override falls through to inference; session id is trimmed.
    expect(identity).toEqual({ harness: "claude-code", sessionId: "cs" });
  });
});

// ── persistence through startWorkflowRun ─────────────────────────────────────

describe("workflow run agent identity persistence", () => {
  let cleanup: Cleanup = () => {};
  let stashDir = "";

  beforeEach(() => {
    const stash = sandboxStashDir();
    cleanup = stash.cleanup;
    stashDir = stash.dir;
    sandboxXdgConfigHome(cleanup);
    sandboxXdgDataHome(cleanup);
    sandboxXdgCacheHome(cleanup);
    fs.mkdirSync(path.join(stashDir, "workflows"), { recursive: true });
  });

  afterEach(() => cleanup());

  function writeWorkflow(name: string): void {
    const content = [
      "---",
      "description: Test workflow for agent identity persistence",
      "---",
      "",
      `# Workflow: ${name}`,
      "",
      "## Step: First Step",
      "Step ID: first-step",
      "",
      "### Instructions",
      "Do the first thing.",
      "",
      "### Completion Criteria",
      "- Confirm the first step is complete",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(stashDir, "workflows", `${name}.md`), content, "utf8");
  }

  test("explicit harness + session id are stored and retrievable", async () => {
    writeWorkflow("explicit-flow");
    const started = await startWorkflowRun(
      "workflow:explicit-flow",
      {},
      { agentHarness: "claude-code", agentSessionId: "session-xyz" },
    );

    expect(started.run.agentHarness).toBe("claude-code");
    expect(started.run.agentSessionId).toBe("session-xyz");

    // Re-read from the database to prove it is persisted, not just echoed.
    const reloaded = await getWorkflowStatus(started.run.id);
    expect(reloaded.run.agentHarness).toBe("claude-code");
    expect(reloaded.run.agentSessionId).toBe("session-xyz");

    const listed = await listWorkflowRuns({ workflowRef: "workflow:explicit-flow" });
    const match = listed.runs.find((r) => r.id === started.run.id);
    expect(match?.agentHarness).toBe("claude-code");
    expect(match?.agentSessionId).toBe("session-xyz");
  });

  test("environment-detected identity is captured when no explicit value is given", async () => {
    writeWorkflow("env-flow");

    const started = await withEnv({ CLAUDE_SESSION_ID: "env-session-42" }, () =>
      startWorkflowRun("workflow:env-flow", {}),
    );
    expect(started.run.agentHarness).toBe("claude-code");
    expect(started.run.agentSessionId).toBe("env-session-42");

    const reloaded = await getWorkflowStatus(started.run.id);
    expect(reloaded.run.agentHarness).toBe("claude-code");
    expect(reloaded.run.agentSessionId).toBe("env-session-42");
  });

  test("runs started with no harness persist null identity", async () => {
    writeWorkflow("anon-flow");
    const started = await withEnv(
      { CLAUDE_SESSION_ID: undefined, OPENCODE_SESSION_ID: undefined, AKM_AGENT_HARNESS: undefined },
      () => startWorkflowRun("workflow:anon-flow", {}),
    );
    expect(started.run.agentHarness).toBeNull();
    expect(started.run.agentSessionId).toBeNull();

    const reloaded = await getWorkflowStatus(started.run.id);
    expect(reloaded.run.agentHarness).toBeNull();
    expect(reloaded.run.agentSessionId).toBeNull();
  });
});
