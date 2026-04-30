/**
 * Envelope-shape contract tests for `akm reflect` and `akm propose` (#226).
 *
 * Locks the structural shape of the success and failure envelopes so a
 * future refactor cannot silently rename or drop a field. The producer-shape
 * functions in `src/output/shapes.ts` are the production rendering path —
 * we exercise them with realistic command result objects.
 *
 * Backfill for issue #284 GAP-MED 2.
 */

import { describe, expect, test } from "bun:test";
import { shapeProposalProducerOutput } from "../../src/output/shapes";

const proposal = {
  id: "uuid-1",
  ref: "lesson:rg-over-grep",
  status: "pending",
  source: "reflect",
  sourceRun: "run-7",
  createdAt: "2026-04-27T00:00:00Z",
  updatedAt: "2026-04-27T00:00:00Z",
  payload: { content: "BODY" },
};

describe("reflect/propose success envelope contract", () => {
  test("normal: required fields present", () => {
    const result = {
      schemaVersion: 1,
      ok: true,
      ref: "lesson:rg-over-grep",
      agentProfile: "claude",
      durationMs: 12,
      proposal,
    };
    const out = shapeProposalProducerOutput(result, "normal");
    expect(out.ok).toBe(true);
    expect(out.ref).toBe("lesson:rg-over-grep");
    expect(out.agentProfile).toBe("claude");
    expect(out.durationMs).toBe(12);
    expect(out).toHaveProperty("proposal");
    // schemaVersion only at full
    expect(out).not.toHaveProperty("schemaVersion");
  });

  test("full: success envelope adds schemaVersion", () => {
    const result = {
      schemaVersion: 1,
      ok: true,
      ref: "lesson:rg-over-grep",
      agentProfile: "claude",
      durationMs: 12,
      proposal,
    };
    const out = shapeProposalProducerOutput(result, "full");
    expect(out.schemaVersion).toBe(1);
  });

  test("brief: shaped proposal still includes id+ref+status (via brief→normal upgrade)", () => {
    const result = { schemaVersion: 1, ok: true, ref: "lesson:rg-over-grep", proposal };
    const out = shapeProposalProducerOutput(result, "brief");
    const p = out.proposal as Record<string, unknown>;
    expect(p.id).toBe("uuid-1");
    expect(p.ref).toBe("lesson:rg-over-grep");
    expect(p.status).toBe("pending");
  });
});

describe("reflect/propose failure envelope contract", () => {
  test("non_zero_exit: required failure fields present", () => {
    const failure = {
      schemaVersion: 1,
      ok: false,
      reason: "non_zero_exit",
      error: "exited with code 7",
      ref: "lesson:rg-over-grep",
      exitCode: 7,
      stdout: "out",
      stderr: "err",
    };
    const out = shapeProposalProducerOutput(failure, "normal");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("non_zero_exit");
    expect(out.error).toBe("exited with code 7");
    expect(out.ref).toBe("lesson:rg-over-grep");
    expect(out.exitCode).toBe(7);
    // stdio only at full
    expect(out).not.toHaveProperty("stdout");
    expect(out).not.toHaveProperty("stderr");
  });

  test("spawn_failed: exitCode null is preserved", () => {
    const failure = {
      schemaVersion: 1,
      ok: false,
      reason: "spawn_failed",
      error: "ENOENT: command not found",
      exitCode: null,
    };
    const out = shapeProposalProducerOutput(failure, "normal");
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("spawn_failed");
    expect(out.exitCode).toBeNull();
  });

  test("parse_error: ref optional", () => {
    const failure = {
      schemaVersion: 1,
      ok: false,
      reason: "parse_error",
      error: "agent stdout was not valid JSON",
      exitCode: 0,
    };
    const out = shapeProposalProducerOutput(failure, "normal");
    expect(out.reason).toBe("parse_error");
    expect(out).not.toHaveProperty("ref");
  });

  test("timeout: timeout reason discriminant", () => {
    const failure = {
      schemaVersion: 1,
      ok: false,
      reason: "timeout",
      error: "timed out after 100ms",
      exitCode: 143,
    };
    const out = shapeProposalProducerOutput(failure, "full");
    expect(out.reason).toBe("timeout");
    expect(out.schemaVersion).toBe(1);
  });

  test("propose-specific failure: type+name appear when set on the result", () => {
    // propose surfaces `type` and `name` in failure envelopes (the input args),
    // separate from the agent-side `ref`. shapeProposalProducerOutput threads
    // both fields through unconditionally when present.
    const failure = {
      schemaVersion: 1,
      ok: false,
      reason: "non_zero_exit",
      error: "agent failed",
      type: "skill",
      name: "hello",
      exitCode: 3,
    };
    const out = shapeProposalProducerOutput(failure, "normal");
    expect(out.type).toBe("skill");
    expect(out.name).toBe("hello");
  });
});
