import { describe, expect, test } from "bun:test";
import {
  ImproveProcessConfigSchema,
  ImproveProfileConfigSchema,
  validateConfigShape,
} from "../src/core/config/config-schema";

// Phase 2: triage is a first-class improve process. These guard that a triage
// block under `processes` parses and is accepted, that the triage-specific
// fields validate, and that enabled unknown process keys are rejected by the
// `ImproveProfileProcessesSchema` superRefine.

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
          judgment: { engine: "fast", timeoutMs: 600000 },
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
        judgment: { engine: "agent" },
      }).success,
    ).toBe(true);

    // applyMode is constrained to queue|promote
    expect(ImproveProcessConfigSchema.safeParse({ applyMode: "delete" }).success).toBe(false);
    // maxAcceptsPerRun must be a positive integer
    expect(ImproveProcessConfigSchema.safeParse({ maxAcceptsPerRun: 0 }).success).toBe(false);
    expect(ImproveProcessConfigSchema.safeParse({ maxDiffLines: -1 }).success).toBe(false);
    // judgment tolerates unknown keys (lenient policy) but still type-checks known ones
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { engine: "fast", bogus: 1 } }).success).toBe(true);
    // judgment.mode is retired in favor of a named engine.
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { mode: "llm" } }).success).toBe(false);
    // judgment.timeoutMs accepts null
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { timeoutMs: null } }).success).toBe(true);
  });

  test("an enabled unknown process is rejected instead of disappearing from the execution plan", () => {
    const enabled = ImproveProfileConfigSchema.safeParse({
      processes: {
        triage: { enabled: true },
        reflecct: { enabled: true, engine: "missing" },
      },
    });
    expect(enabled.success).toBe(false);
    if (enabled.success) throw new Error("fixture must fail validation");
    expect(enabled.error.issues[0]?.path).toEqual(["processes", "reflecct"]);
    expect(enabled.error.issues[0]?.message).toContain("Unknown enabled improve process");

    expect(ImproveProfileConfigSchema.safeParse({ processes: { futureProcess: { enabled: false } } }).success).toBe(
      true,
    );
  });

  test("triage may select an agent engine while missing engines are rejected", () => {
    const base = {
      configVersion: "0.9.0",
      engines: { reviewer: { kind: "agent", platform: "pi" } },
    } as const;
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            custom: { processes: { triage: { enabled: true, engine: "reviewer", judgment: {} } } },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateConfigShape({
        ...base,
        improve: {
          strategies: {
            custom: { processes: { triage: { enabled: true, engine: "missing", judgment: {} } } },
          },
        },
      }).ok,
    ).toBe(false);
  });
});
