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
          maxAcceptsPerRun: 25,
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
        maxAcceptsPerRun: 10,
        judgment: { engine: "agent" },
      }).success,
    ).toBe(true);

    // applyMode is constrained to queue|promote
    expect(ImproveProcessConfigSchema.safeParse({ applyMode: "delete" }).success).toBe(false);
    // maxAcceptsPerRun must be a positive integer
    expect(ImproveProcessConfigSchema.safeParse({ maxAcceptsPerRun: 0 }).success).toBe(false);
    // The retired drain-policy keys are tolerated like any unknown key, never fatal.
    expect(
      ImproveProcessConfigSchema.safeParse({ policy: "personal-stash", maxDiffLines: -1, rejectEmpty: true }).success,
    ).toBe(true);
    // An unknown judgment key is not fatal: the loader warns about it and it changes nothing.
    const withUnknown = ImproveProcessConfigSchema.safeParse({ judgment: { engine: "fast", bogus: 1 } });
    expect(withUnknown.success).toBe(true);
    // judgment.mode is retired in favor of a named engine; like any unknown key it is tolerated, not fatal.
    expect(ImproveProcessConfigSchema.safeParse({ judgment: { mode: "llm" } }).success).toBe(true);
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
