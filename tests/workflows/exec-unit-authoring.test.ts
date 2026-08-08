// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `exec` (shell) unit AUTHORING surface, end to end through the pure
 * layers: parser → compile → freeze → frozen-plan decoder → work-list.
 *
 * Dispatch itself (real subprocesses, redaction, journaling, worktrees, replay)
 * lives in `tests/integration/workflows/exec-unit.test.ts`; everything here is
 * pure and needs no state.db.
 */

import { describe, expect, test } from "bun:test";
import { computeStepWorkList } from "../../src/workflows/exec/step-work";
import type { IrUnitNode, WorkflowPlanGraph } from "../../src/workflows/ir/schema";
import { decodeWorkflowPlanV3 } from "../../src/workflows/ir/schema";
import { parseWorkflow } from "../../src/workflows/parser";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  execContextLimits,
  WORKFLOW_MAX_EXEC_ARGV,
  WORKFLOW_MAX_EXEC_CONTEXT_BYTES_POSIX,
  WORKFLOW_MAX_EXEC_CONTEXT_BYTES_WIN32,
  WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX,
  WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32,
  WORKFLOW_MAX_EXEC_PASS_ENV,
} from "../../src/workflows/resource-limits";
import { freezeWorkflow } from "../_helpers/workflow";

function doc(stepLines: string[], body = "## work\n\nDo it.\n", extra: string[] = []): string {
  return ["---", "type: workflow", ...extra, "steps:", "  - id: work", ...stepLines, "---", "", body].join("\n");
}

function parseErrors(markdown: string): Array<{ line: number; message: string }> {
  const result = parseWorkflow(markdown, { path: "workflows/exec.md" });
  return result.ok ? [] : result.errors;
}

function rootUnit(plan: WorkflowPlanGraph, index = 0): IrUnitNode {
  const root = plan.steps[index]!.root;
  if (!root) throw new Error("step has no root");
  return root.kind === "map" ? root.template : root;
}

const EXEC_STEP = ["    unit:", "      exec:", '        command: ["bun", "run", "test:unit"]'];

describe("exec unit — authoring surface", () => {
  test("an argv command freezes into an exec node with NO invocation and no engine reference", () => {
    const plan = freezeWorkflow(doc(EXEC_STEP));
    const unit = rootUnit(plan);
    expect(unit.exec).toEqual({ command: ["bun", "run", "test:unit"], timeoutMs: DEFAULT_EXEC_TIMEOUT_MS });
    expect(unit.invocation).toBeUndefined();
    // The whole point of "no engine": an exec-only workflow freezes on an
    // install with nothing configured, and references no engine catalog entry.
    expect(plan.execution.engines).toEqual({});
  });

  test("the work list classifies it as the exec runner and carries the frozen spec", () => {
    const plan = freezeWorkflow(doc(EXEC_STEP));
    const list = computeStepWorkList(plan.steps[0]!, {
      runId: "run",
      params: {},
      stepOutputs: {},
      engines: plan.execution.engines,
    });
    if (!list.ok) throw new Error(list.error);
    const unit = list.list.units[0]!;
    expect(unit.runner).toBe("exec");
    expect(unit.engine).toBeUndefined();
    expect(unit.invocation).toBeUndefined();
    expect(unit.exec?.command).toEqual(["bun", "run", "test:unit"]);
    expect(unit.timeoutMs).toBe(DEFAULT_EXEC_TIMEOUT_MS);
  });

  test("a relative cwd is carried through; timeout/retry/on_error/env/isolation all still apply", () => {
    const plan = freezeWorkflow(
      doc([
        "    unit:",
        "      exec:",
        '        command: ["make", "build"]',
        "        cwd: packages/core",
        '      timeout: "90s"',
        "      retry: { max: 2, on: [non_zero_exit] }",
        "      on_error: continue",
        "      env: [env/ci]",
        "      isolation: worktree",
      ]),
    );
    const unit = rootUnit(plan);
    expect(unit.exec).toEqual({ command: ["make", "build"], cwd: "packages/core", timeoutMs: 90_000 });
    expect(unit.retry).toEqual({ max: 2, on: ["non_zero_exit"] });
    expect(unit.onError).toBe("continue");
    expect(unit.env).toEqual(["env/ci"]);
    expect(unit.isolation).toBe("worktree");
  });

  test("timeout resolution: unit > document defaults > DEFAULT_EXEC_TIMEOUT_MS, and `none` means unbounded", () => {
    const withDefault = freezeWorkflow(doc(EXEC_STEP, undefined, ['defaults: { timeout: "45s" }']));
    expect(rootUnit(withDefault).exec?.timeoutMs).toBe(45_000);

    const unitWins = freezeWorkflow(
      doc([...EXEC_STEP, '      timeout: "5s"'], undefined, ['defaults: { timeout: "45s" }']),
    );
    expect(rootUnit(unitWins).exec?.timeoutMs).toBe(5_000);

    const unbounded = freezeWorkflow(doc([...EXEC_STEP, '      timeout: "none"']));
    expect(rootUnit(unbounded).exec?.timeoutMs).toBeNull();
  });

  test("a map step fans an exec unit out over an item list", () => {
    const plan = freezeWorkflow(
      doc(
        [
          "    map:",
          "      over: params.targets",
          "      concurrency: 3",
          "      unit:",
          "        exec:",
          '          command: ["make", "check"]',
        ],
        "## work\n\nCheck each target.\n",
        ["params:", "  targets: { type: array }"],
      ),
    );
    const root = plan.steps[0]!.root!;
    expect(root.kind).toBe("map");
    if (root.kind !== "map") throw new Error("expected a map root");
    expect(root.concurrency).toBe(3);
    expect(root.template.exec?.command).toEqual(["make", "check"]);
  });
});

describe("exec unit — environment scope (`inherit_env` / `pass_env`)", () => {
  test("the DEFAULT freezes neither key — the allowlist is the absence of both", () => {
    expect(rootUnit(freezeWorkflow(doc(EXEC_STEP))).exec).toEqual({
      command: ["bun", "run", "test:unit"],
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
    });
  });

  test("`inherit_env: true` freezes into the plan and reaches the work list", () => {
    const plan = freezeWorkflow(doc([...EXEC_STEP, "        inherit_env: true"]));
    expect(rootUnit(plan).exec?.inheritEnv).toBe(true);
    const list = computeStepWorkList(plan.steps[0]!, {
      runId: "run",
      params: {},
      stepOutputs: {},
      engines: plan.execution.engines,
    });
    if (!list.ok) throw new Error(list.error);
    expect(list.list.units[0]!.exec?.inheritEnv).toBe(true);
  });

  test("`inherit_env: false` is the default and freezes NOTHING — one encoding per state", () => {
    // A `false` that froze as a key would give the same unit two hashes for
    // the same behavior. It is normalized away at parse time instead.
    expect(
      rootUnit(freezeWorkflow(doc([...EXEC_STEP, "        inherit_env: false"]))).exec?.inheritEnv,
    ).toBeUndefined();
  });

  test("`pass_env` freezes the extra NAMES, deduplicated grammar enforced", () => {
    const plan = freezeWorkflow(doc([...EXEC_STEP, "        pass_env: [CARGO_HOME, SCCACHE_DIR]"]));
    expect(rootUnit(plan).exec?.passEnv).toEqual(["CARGO_HOME", "SCCACHE_DIR"]);
  });

  test.each([
    ["a non-boolean inherit_env", "        inherit_env: yes-please", '"exec.inherit_env" must be true or false'],
    ["an empty pass_env", "        pass_env: []", '"exec.pass_env" must be a non-empty list'],
    ["a non-list pass_env", "        pass_env: CARGO_HOME", '"exec.pass_env" must be a non-empty list'],
    ["a malformed name", '        pass_env: ["9BAD"]', '"exec.pass_env[0]" must be an environment variable name'],
    ["a duplicate name", "        pass_env: [CARGO_HOME, CARGO_HOME]", 'lists "CARGO_HOME" more than once'],
  ])("%s is rejected", (_label, line, message) => {
    const errors = parseErrors(doc([...EXEC_STEP, line]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(message);
  });

  test("an over-long pass_env is rejected and points at `inherit_env`", () => {
    const tooMany = JSON.stringify(Array.from({ length: WORKFLOW_MAX_EXEC_PASS_ENV + 1 }, (_, i) => `VAR_${i}`));
    const errors = parseErrors(doc([...EXEC_STEP, `        pass_env: ${tooMany}`]));
    expect(errors[0]!.message).toContain(`at most ${WORKFLOW_MAX_EXEC_PASS_ENV} entries`);
    expect(errors[0]!.message).toContain("inherit_env: true");
  });

  test("a bad value is anchored to ITS OWN line, not the document or the step", () => {
    // 1: ---, 2: type, 3: steps, 4: id, 5: unit, 6: exec, 7: command, 8: inherit_env
    expect(parseErrors(doc([...EXEC_STEP, "        inherit_env: nope"]))[0]!.line).toBe(8);
    expect(parseErrors(doc([...EXEC_STEP, "        pass_env: []"]))[0]!.line).toBe(8);
  });
});

describe("exec unit — parser rejections (line-anchored)", () => {
  test.each([
    ["engine", "      engine: test-llm"],
    ["model", "      model: gpt-x"],
    ["llm", "      llm: { temperature: 0 }"],
  ])("declaring exec alongside %s is rejected", (key, line) => {
    const errors = parseErrors(doc([...EXEC_STEP, line]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(`declares both "exec" and "${key}"`);
  });

  test("a missing command is rejected and names the argv-array requirement", () => {
    const errors = parseErrors(doc(["    unit:", "      exec:", "        cwd: sub"]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('requires "command": a non-empty argv list');
    expect(errors[0]!.message).toContain("never through a shell");
  });

  test("a bare shell STRING is rejected — there is no shell-string spelling", () => {
    const errors = parseErrors(doc(["    unit:", "      exec:", '        command: "bun run test && echo ok"']));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("a non-empty argv list");
  });

  test("an empty argv entry, an over-long argv, and an unknown exec key are rejected", () => {
    expect(parseErrors(doc(["    unit:", "      exec:", '        command: ["bun", ""]']))[0]!.message).toContain(
      '"exec.command[1]" must be a non-empty string',
    );
    const tooMany = JSON.stringify(Array.from({ length: WORKFLOW_MAX_EXEC_ARGV + 1 }, () => "x"));
    expect(parseErrors(doc(["    unit:", "      exec:", `        command: ${tooMany}`]))[0]!.message).toContain(
      `at most ${WORKFLOW_MAX_EXEC_ARGV} entries`,
    );
    expect(
      parseErrors(doc(["    unit:", "      exec:", '        command: ["ls"]', "        shell: true"]))[0]!.message,
    ).toContain('Unknown Step "work" "exec" key "shell". Allowed keys: command, cwd, pass_env, inherit_env.');
  });

  test.each([
    "/etc",
    "../outside",
    "sub/../../escape",
    "~/home",
    "C:\\\\windows",
  ])("an escaping cwd (%s) is rejected at parse time", (cwd) => {
    const errors = parseErrors(doc(["    unit:", "      exec:", '        command: ["ls"]', `        cwd: "${cwd}"`]));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must be a RELATIVE path inside the unit's working directory");
  });

  test("the error is anchored to the offending line, not the document", () => {
    const errors = parseErrors(doc([...EXEC_STEP, "      engine: test-llm"]));
    // 1: ---, 2: type, 3: steps, 4: id, 5: unit, 6: exec, 7: command, 8: engine
    expect(errors[0]!.line).toBe(8);
  });
});

describe("exec unit — frozen-plan decoder (corruption gate)", () => {
  const base = (): WorkflowPlanGraph => freezeWorkflow(doc(EXEC_STEP));

  function mutate(fn: (unit: Record<string, unknown>) => void): () => WorkflowPlanGraph {
    return () => {
      const plan = JSON.parse(JSON.stringify(base())) as WorkflowPlanGraph;
      fn(plan.steps[0]!.root as unknown as Record<string, unknown>);
      return decodeWorkflowPlanV3(plan);
    };
  }

  test("a unit carrying BOTH invocation and exec is rejected", () => {
    expect(
      mutate((unit) => {
        unit.invocation = { engine: "test-llm", model: "test-model", timeoutMs: 1000 };
      }),
    ).toThrow(/exactly one of invocation or exec/);
  });

  test("a unit carrying NEITHER is rejected", () => {
    expect(
      mutate((unit) => {
        delete unit.exec;
      }),
    ).toThrow(/exactly one of invocation or exec/);
  });

  test("a tampered plan cannot smuggle an absolute or escaping cwd past the decoder", () => {
    for (const cwd of ["/etc", "../..", "sub/../../x", "~/x"]) {
      expect(
        mutate((unit) => {
          (unit.exec as Record<string, unknown>).cwd = cwd;
        }),
      ).toThrow(/cwd must be a relative path contained/);
    }
  });

  test("a tampered argv (empty, non-string, over the bound) is rejected", () => {
    for (const command of [[], [""], ["ok", 3], Array.from({ length: WORKFLOW_MAX_EXEC_ARGV + 1 }, () => "x")]) {
      expect(
        mutate((unit) => {
          (unit.exec as Record<string, unknown>).command = command;
        }),
      ).toThrow(/command must be an argv array/);
    }
  });

  test("a tampered timeout outside the legal range is rejected", () => {
    for (const timeoutMs of [0, -1, 2 ** 31, "10m"]) {
      expect(
        mutate((unit) => {
          (unit.exec as Record<string, unknown>).timeoutMs = timeoutMs;
        }),
      ).toThrow(/timeoutMs must be null or an integer/);
    }
  });

  test("a tampered env scope is rejected: inheritEnv must be exactly `true`, passEnv a bounded name list", () => {
    for (const inheritEnv of [false, "true", 1, null]) {
      expect(
        mutate((unit) => {
          (unit.exec as Record<string, unknown>).inheritEnv = inheritEnv;
        }),
      ).toThrow(/inheritEnv must be true when present/);
    }
    for (const passEnv of [
      [],
      "CARGO_HOME",
      ["9BAD"],
      ["OK", "OK"],
      Array.from({ length: WORKFLOW_MAX_EXEC_PASS_ENV + 1 }, (_, i) => `VAR_${i}`),
    ]) {
      expect(
        mutate((unit) => {
          (unit.exec as Record<string, unknown>).passEnv = passEnv;
        }),
      ).toThrow(/passEnv must be 1 through/);
    }
  });

  test("a canonical env scope round-trips through the decoder unchanged", () => {
    const plan = freezeWorkflow(doc([...EXEC_STEP, "        inherit_env: true", "        pass_env: [CARGO_HOME]"]));
    const decoded = decodeWorkflowPlanV3(JSON.parse(JSON.stringify(plan)));
    expect(rootUnit(decoded).exec).toEqual({
      command: ["bun", "run", "test:unit"],
      passEnv: ["CARGO_HOME"],
      inheritEnv: true,
      timeoutMs: DEFAULT_EXEC_TIMEOUT_MS,
    });
  });

  test("an unknown key inside the frozen exec spec is rejected", () => {
    expect(
      mutate((unit) => {
        (unit.exec as Record<string, unknown>).shell = true;
      }),
    ).toThrow(/contains unknown key shell/);
  });

  test("exec units MAY carry env + worktree isolation; llm units still may not", () => {
    // exec has a real child process, which is exactly what env injection and
    // worktree isolation require — the constraint was never about the keys, it
    // was about there being a process to apply them to.
    expect(() =>
      freezeWorkflow(
        doc([
          "    unit:",
          "      exec:",
          '        command: ["ls"]',
          "      env: [env/ci]",
          "      isolation: worktree",
        ]),
      ),
    ).not.toThrow();
    expect(() => freezeWorkflow(doc(["    unit:", "      engine: test-llm", "      env: [env/ci]"]))).toThrow(
      /cannot use env injection or worktree isolation/,
    );
    expect(() => freezeWorkflow(doc(["    unit:", "      engine: test-llm", "      isolation: worktree"]))).toThrow(
      /cannot use env injection or worktree isolation/,
    );
  });
});

describe("exec unit — replay identity / input hashing", () => {
  function hashOf(markdown: string): string {
    const plan = freezeWorkflow(markdown);
    const list = computeStepWorkList(plan.steps[0]!, {
      runId: "run",
      params: {},
      stepOutputs: {},
      engines: plan.execution.engines,
    });
    if (!list.ok) throw new Error(list.error);
    const resolved = list.list.units[0]!.resolved;
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.inputHash;
  }

  test("ADDITIVE: an existing llm unit's input hash is byte-identical to the pre-exec engine", () => {
    // Pinned against the value produced by the engine BEFORE the exec unit
    // existed. `exec` was added to the hash preimage as a key present only on
    // exec units, so `hashVersion` stays 4 and no in-flight run re-dispatches
    // work it already completed. If this changes, the migration cost of the
    // change must be understood before the pin is updated.
    expect(
      hashOf(
        [
          "---",
          "type: workflow",
          "steps:",
          "  - id: review",
          "    unit:",
          "      engine: test-llm",
          "---",
          "",
          "## review",
          "",
          "Review the diff.",
          "",
        ].join("\n"),
      ),
    ).toBe("60e27411ec236a7cb96a24eb46277e57d70f97bb0bd70598de9b4cbe10e5dd26");
  });

  test("the exec hash is deterministic and moves with every dispatch-significant field", () => {
    const baseline = hashOf(doc(EXEC_STEP));
    expect(hashOf(doc(EXEC_STEP))).toBe(baseline);

    // argv
    expect(hashOf(doc(["    unit:", "      exec:", '        command: ["bun", "run", "lint"]']))).not.toBe(baseline);
    // cwd
    expect(hashOf(doc([...EXEC_STEP, "        cwd: sub"]))).not.toBe(baseline);
    // timeout
    expect(hashOf(doc([...EXEC_STEP, '      timeout: "5s"']))).not.toBe(baseline);
    // env NAMES
    expect(hashOf(doc([...EXEC_STEP, "      env: [env/ci]"]))).not.toBe(baseline);
    // isolation
    expect(hashOf(doc([...EXEC_STEP, "      isolation: worktree"]))).not.toBe(baseline);
    // environment SCOPE — both keys change what the child can see, so both
    // must re-dispatch rather than reuse a row produced under the other scope.
    expect(hashOf(doc([...EXEC_STEP, "        inherit_env: true"]))).not.toBe(baseline);
    expect(hashOf(doc([...EXEC_STEP, "        pass_env: [CARGO_HOME]"]))).not.toBe(baseline);
    expect(hashOf(doc([...EXEC_STEP, "        pass_env: [SCCACHE_DIR]"]))).not.toBe(
      hashOf(doc([...EXEC_STEP, "        pass_env: [CARGO_HOME]"])),
    );
  });

  test("ADDITIVE: the default env scope hashes exactly as it did before the keys existed", () => {
    // Pinned against the value the exec unit produced when the child still
    // inherited akm's whole environment: the allowlist default freezes NEITHER
    // env-scope key, so every already-frozen exec unit keeps its hash and no
    // in-flight run re-dispatches a completed command.
    expect(hashOf(doc(EXEC_STEP))).toBe("7d8cf6b136c3d69ad64a07a02190b03fe145b8ddec96380903907c7dd886e85f");
    // Writing the default explicitly is the same state, so the same hash.
    expect(hashOf(doc([...EXEC_STEP, "        inherit_env: false"]))).toBe(hashOf(doc(EXEC_STEP)));
  });

  test("`retry` and `on_error` stay OUT of the hash — a completed exec row survives a policy change", () => {
    expect(
      hashOf(doc([...EXEC_STEP, "      retry: { max: 3, on: [non_zero_exit] }", "      on_error: continue"])),
    ).toBe(hashOf(doc(EXEC_STEP)));
  });

  test("the preimage carries env asset REF NAMES only — never a resolved secret value", () => {
    // Structural proof: the frozen node (which IS the preimage source) exposes
    // the ref name and nothing else. Secret values live only in the resolved
    // dispatch env, which never reaches the hash.
    const plan = freezeWorkflow(doc([...EXEC_STEP, "      env: [env/ci]"]));
    expect(rootUnit(plan).env).toEqual(["env/ci"]);
    expect(JSON.stringify(plan)).not.toContain("AKM_");
  });
});

describe("exec unit — the AKM_* context ceilings are PER-PLATFORM", () => {
  test("each platform is checked against its OWN spawn ceiling, not the smallest one", () => {
    // The guard's only job is to convert an INEVITABLE E2BIG / CreateProcess
    // failure into an actionable error. Applying the smallest supported
    // platform's ceiling everywhere would instead fail spawns Linux and macOS
    // accept — machinery that makes a run fail where it would have succeeded.
    expect(execContextLimits("win32")).toEqual({
      perVarBytes: WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32,
      totalBytes: WORKFLOW_MAX_EXEC_CONTEXT_BYTES_WIN32,
      source: expect.stringContaining("32 767 characters"),
    });
    for (const platform of ["linux", "darwin", "freebsd"]) {
      expect(execContextLimits(platform)).toEqual({
        perVarBytes: WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX,
        totalBytes: WORKFLOW_MAX_EXEC_CONTEXT_BYTES_POSIX,
        source: expect.stringContaining("MAX_ARG_STRLEN"),
      });
    }
    // Unknown platforms get the POSIX bound; every platform akm supports other
    // than win32 is POSIX, and guessing the tighter Windows number for one would
    // be the same tripwire in miniature.
    expect(execContextLimits("sunos").perVarBytes).toBe(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX);
    // The default is THIS host.
    expect(execContextLimits()).toEqual(execContextLimits(process.platform));
  });

  test("every constant sits with real margin under the OS number it cites", () => {
    // Windows: SetEnvironmentVariable caps one variable at 32 767 CHARACTERS.
    // Measuring UTF-8 bytes is conservative in the right direction, so the
    // constant may sit exactly at the documented number.
    expect(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32).toBe(32_767);
    // Linux: MAX_ARG_STRLEN = 32 * PAGE_SIZE = 131 072 bytes per argv/environ
    // string. The per-variable bound leaves 32 KiB of headroom for the NAME,
    // the `=`, the NUL and the kernel's own accounting.
    const LINUX_MAX_ARG_STRLEN = 32 * 4096;
    expect(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX).toBeLessThan(LINUX_MAX_ARG_STRLEN);
    expect(LINUX_MAX_ARG_STRLEN - WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX).toBe(32 * 1024);
    // macOS: ARG_MAX = 256 KiB over argv + environ COMBINED. akm's own context
    // takes at most half, leaving the rest for argv, the allowlist and bindings.
    const MACOS_ARG_MAX = 256 * 1024;
    expect(WORKFLOW_MAX_EXEC_CONTEXT_BYTES_POSIX).toBe(MACOS_ARG_MAX / 2);
    // A per-variable bound above the total would be unreachable machinery.
    expect(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX).toBeLessThan(WORKFLOW_MAX_EXEC_CONTEXT_BYTES_POSIX);
    expect(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32).toBeLessThan(WORKFLOW_MAX_EXEC_CONTEXT_BYTES_WIN32);
    // Every POSIX bound is strictly WIDER than the Windows one — that widening
    // is the tripwire removal.
    expect(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_POSIX).toBeGreaterThan(WORKFLOW_MAX_EXEC_CONTEXT_VAR_BYTES_WIN32);
    expect(WORKFLOW_MAX_EXEC_CONTEXT_BYTES_POSIX).toBeGreaterThan(WORKFLOW_MAX_EXEC_CONTEXT_BYTES_WIN32);
  });
});
