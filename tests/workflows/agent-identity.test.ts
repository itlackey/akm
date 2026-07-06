import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readEvents } from "../../src/core/events";
import { denormalizeRuntimeIdentity, HARNESS_REGISTRY } from "../../src/integrations/harnesses";
import { resolveAgentIdentity } from "../../src/workflows/runtime/agent-identity";
import { getWorkflowStatus, listWorkflowRuns, startWorkflowRun } from "../../src/workflows/runtime/runs";
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

  // ── registry-derived markers (P2, plan §"Kill registry drift") ────────────
  // Detection is DERIVED from HARNESS_REGISTRY `identityEnv` (session-id
  // vars) and `presenceEnv` (presence-only flags), so every harness that
  // declares a marker must be detected without this module knowing it.

  test("every registry identityEnv marker detects its harness's runtime identity", () => {
    const marked = HARNESS_REGISTRY.filter((h) => (h.identityEnv?.length ?? 0) > 0);
    // Guard: the derivation is only meaningful if markers exist at all.
    expect(marked.length).toBeGreaterThanOrEqual(2);
    for (const h of marked) {
      for (const envKey of h.identityEnv ?? []) {
        const identity = resolveAgentIdentity({ [envKey]: "sess-1" });
        expect(identity).toEqual({ harness: denormalizeRuntimeIdentity(h.id), sessionId: "sess-1" });
      }
    }
  });

  test("every registry presenceEnv flag infers its harness WITHOUT fabricating a session id", () => {
    // Peer-review regression: presence flags (CODEX_SANDBOX=seatbelt,
    // GEMINI_CLI=1) carry modes/flags, not sessions — their values must never
    // be persisted as agent_session_id.
    const flagged = HARNESS_REGISTRY.filter((h) => (h.presenceEnv?.length ?? 0) > 0);
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    for (const h of flagged) {
      for (const envKey of h.presenceEnv ?? []) {
        const identity = resolveAgentIdentity({ [envKey]: "not-a-session-id" });
        expect(identity).toEqual({ harness: denormalizeRuntimeIdentity(h.id), sessionId: null });
      }
    }
  });

  // ── P2 harness adapters: detection via their registered markers ───────────

  test("infers codex from CODEX_SANDBOX but never records its value as a session id", () => {
    const identity = resolveAgentIdentity({ CODEX_SANDBOX: "seatbelt" });
    expect(identity).toEqual({ harness: "codex", sessionId: null });
  });

  test("infers gemini from GEMINI_CLI but never records its value as a session id", () => {
    const identity = resolveAgentIdentity({ GEMINI_CLI: "1" });
    expect(identity).toEqual({ harness: "gemini", sessionId: null });
  });

  test("a concrete session id outranks a presence flag (opencode inside a codex sandbox)", () => {
    // Peer-review regression: the id-sorted flat table used to pick
    // harness=codex + sessionId="seatbelt", displacing the real opencode
    // session id. Session-id markers must win over presence flags.
    const identity = resolveAgentIdentity({ OPENCODE_SESSION_ID: "oc-1", CODEX_SANDBOX: "seatbelt" });
    expect(identity).toEqual({ harness: "opencode", sessionId: "oc-1" });
  });

  test("infers copilot from COPILOT_SESSION_ID (with the session id captured)", () => {
    const identity = resolveAgentIdentity({ COPILOT_SESSION_ID: "cop-42" });
    expect(identity).toEqual({ harness: "copilot", sessionId: "cop-42" });
  });

  test("infers pi from PI_SESSION_ID (with the session id captured)", () => {
    const identity = resolveAgentIdentity({ PI_SESSION_ID: "pi-7" });
    expect(identity).toEqual({ harness: "pi", sessionId: "pi-7" });
  });

  test("multiple markers present: claude wins over opencode (legacy precedence preserved)", () => {
    // The pre-derivation if/else chain checked CLAUDE_SESSION_ID first; the
    // registry-derived table sorts by canonical id ('claude' < 'opencode'),
    // which keeps this byte-identical — including the paired session id.
    const identity = resolveAgentIdentity({ OPENCODE_SESSION_ID: "oc-1", CLAUDE_SESSION_ID: "cc-1" });
    expect(identity).toEqual({ harness: "claude-code", sessionId: "cc-1" });
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

  test("workflow_started event emits only run id + status, never the raw workflow title (07 P1-B)", async () => {
    writeWorkflow("title-flow");
    const started = await startWorkflowRun("workflow:title-flow", {});

    const events = readEvents({ type: "workflow_started" }).events;
    const evt = events.find((e) => (e.metadata as { runId?: string } | undefined)?.runId === started.run.id);
    expect(evt).toBeDefined();
    const metadata = (evt?.metadata ?? {}) as Record<string, unknown>;
    // Only run id + status are emitted — the raw workflowTitle must not leak.
    expect(metadata.runId).toBe(started.run.id);
    expect(metadata.status).toBeDefined();
    expect("title" in metadata).toBe(false);
    expect(started.run.workflowTitle).toBeTruthy(); // the title still exists on the run record
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
