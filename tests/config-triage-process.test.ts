import { describe, expect, test } from "bun:test";
import { ImproveProcessConfigSchema, ImproveProfileConfigSchema } from "../src/core/config/config-schema";

// Phase 2: triage is a first-class improve process. These guard that a triage
// block under `processes` parses and is accepted, that the triage-specific
// fields validate, and that genuinely-unknown process keys are still rejected
// by the `ImproveProfileProcessesSchema` superRefine.

describe("triage improve-process config schema", () => {
  test("a triage block under processes parses and is accepted", () => {
    const result = ImproveProfileConfigSchema.safeParse({
      processes: {
        reflect: { enabled: true },
        triage: {
          enabled: true,
          applyMode: "queue",
          policy: "personal-stash",
          maxAcceptsPerRun: 25,
          maxDiffLines: 200,
          rejectEmpty: true,
          judgment: { mode: "llm", profile: "fast", timeoutMs: 600000 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  test("triage-specific fields validate on ImproveProcessConfigSchema", () => {
    expect(
      ImproveProcessConfigSchema.safeParse({
        enabled: false,
        applyMode: "promote",
        policy: "conservative",
        maxAcceptsPerRun: 10,
        maxDiffLines: 50,
        rejectEmpty: false,
        judgment: { mode: "agent" },
      }).success,
    ).toBe(true);

    // applyMode is constrained to queue|promote
    expect(ImproveProcessConfigSchema.safeParse({ applyMode: "delete" }).success).toBe(false);
    // maxAcceptsPerRun must be a positive integer
    expect(ImproveProcessConfigSchema.safeParse({ maxAcceptsPerRun: 0 }).success).toBe(false);
    expect(ImproveProcessConfigSchema.safeParse({ maxDiffLines: -1 }).success).toBe(false);
    // judgment is a strict object — unknown keys rejected
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { mode: "llm", bogus: 1 } }).success).toBe(false);
    // judgment.mode is constrained to llm|agent|sdk
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { mode: "human" } }).success).toBe(false);
    // judgment.timeoutMs accepts null
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { timeoutMs: null } }).success).toBe(true);
  });

  test("a genuinely-unknown process key is still rejected by the superRefine", () => {
    const result = ImproveProfileConfigSchema.safeParse({
      processes: {
        triage: { enabled: true },
        notARealProcess: { enabled: true },
      },
    });
    expect(result.success).toBe(false);
  });
});
