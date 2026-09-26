// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P3b Lane B TESTS — `akm workflow plan <ref>` (spec docs/plans/specs/
 * p3b-child-executor.md §4.6, rows B-46…B-59; named in §7's new-suites table
 * as this file). Drives the REAL `akm` CLI in-process (`runCliCapture`),
 * exactly like `tests/integration/commands/tasks-explain.test.ts`'s P2b
 * precedent for a brand-new read-only verb — no not-yet-existing TypeScript
 * export is referenced directly anywhere in this file, so no
 * `@ts-expect-error` directive is needed.
 *
 * RED phase: `workflow plan` is not a registered `workflowCommand`
 * subcommand at all today, so every invocation below fails with citty's own
 * unknown-subcommand error (exit 2) instead of the behavior pinned here.
 *
 * B-59 (the static registration: a required `ref` positional plus the global
 * `format` flag) is the AUTHORIZED additive arm in
 * tests/contracts/command-cli-contract.test.ts (spec F-B4) — this file does
 * not duplicate that exact static assertion; B-58's runtime "no ref -> usage
 * error" test is this file's own behavioral witness of the same requirement.
 *
 * B-53's sentinel coverage is command-body-content and a literal env: value
 * (both simple, unambiguous fixtures); a script-bytes sentinel is not
 * separately constructed here — the closed print-list table (§4.6) still
 * gets its own structural assertion (B-51/B-52) that a script target's
 * `bytesBase64` and a command's `request.command.content` are never among
 * the fields this verb reads at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as yamlParse } from "yaml";
import { resetConfigCache } from "../../../src/core/config/config";
import { getStateDbPath, openStateDatabase } from "../../../src/core/state-db";
import { akmIndex } from "../../../src/indexer/indexer";
import { runCliCapture } from "../../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withIsolatedAkmStorage,
  writeSandboxConfig,
  writeWorkflowTestConfig,
} from "../../_helpers/sandbox";

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
  storage.cleanup();
});

function write(relative: string, content: string): void {
  const file = path.join(storage.stashDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeParent(name: string, stepLines: readonly string[]): void {
  write(
    `workflows/${name}.yml`,
    [
      `name: ${name}`,
      "on:",
      "  workflow_dispatch:",
      "jobs:",
      "  main:",
      "    runs-on: [self-hosted]",
      "    steps:",
      ...stepLines,
      "",
    ].join("\n"),
  );
}

async function index(): Promise<void> {
  await akmIndex({ stashDir: storage.stashDir, full: true });
}

interface DbRowCounts {
  readonly workflow_runs: number;
  readonly workflow_run_steps: number;
  readonly workflow_run_units: number;
  readonly workflow_run_unit_attempts: number;
  readonly events: number;
  readonly usage_events: number;
}

function tableCounts(): DbRowCounts {
  const db = openStateDatabase(getStateDbPath());
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      workflow_runs: count("workflow_runs"),
      workflow_run_steps: count("workflow_run_steps"),
      workflow_run_units: count("workflow_run_units"),
      workflow_run_unit_attempts: count("workflow_run_unit_attempts"),
      events: count("events"),
      usage_events: count("usage_events"),
    };
  } finally {
    db.close();
  }
}

// A closed set of the ONLY keys §4.6 authorizes at the envelope's root.
const ENVELOPE_ROOT_KEYS = new Set([
  "ok",
  "ref",
  "title",
  "sourceFormat",
  "sourcePath",
  "irVersion",
  "planHash",
  "published",
  "execution",
  "budget",
  "params",
  "outputs",
  "steps",
  "notices",
  "warnings",
  // Passthrough envelope stamping (#484), applied uniformly to every
  // command's JSON output — not itself part of §4.6's list, but not a
  // behavior this verb controls either, so it is allowed here rather than
  // asserted against.
  "shape",
  "schemaVersion",
]);

function writeBasicWorkflow(): void {
  write(
    "workflows/basic-plan.md",
    [
      "---",
      "type: workflow",
      "params:",
      "  channel: { type: string }",
      "steps:",
      "  - id: notify",
      "---",
      "",
      "## notify",
      "",
      "Notify the channel.",
      "",
    ].join("\n"),
  );
}

/**
 * Compiles cleanly but emits exactly one advisory: `map.over` references
 * `params.chanel`, which the `params:` block does not declare.
 *
 * Its own fixture rather than a tweak to `writeBasicWorkflow`, which many
 * tests here depend on staying warning-free. Previously this suite used the
 * basic workflow directly, because a step with no `output:` schema warned —
 * the advisory #886 deleted for firing on every step while guarding nothing.
 * The behavior under test is that `workflow plan` returns advisories in the
 * envelope instead of calling warn(), so any one advisory serves.
 */
function writeWarningWorkflow(): void {
  write(
    "workflows/warns-plan.md",
    [
      "---",
      "type: workflow",
      "params:",
      "  channel: { type: string }",
      "steps:",
      "  - id: notify",
      "    output: { type: array }",
      "    map: { over: params.chanel }",
      "---",
      "",
      "## notify",
      "",
      "Notify the channel.",
      "",
    ].join("\n"),
  );
}

describe("akm workflow plan <ref> — json by default (#903)", () => {
  test("with no --format and no configured format, emits the JSON envelope like every other command", async () => {
    writeBasicWorkflow();
    await index();

    // `plan` used to be the one verb that defaulted to a human summary. That
    // cost a bespoke branch which could not reliably tell "no format named"
    // from "--format json named globally before the subcommand", so an
    // explicit `--format json` silently did nothing whenever the resolved
    // format was already json. Deleted in #903.
    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.shape).toBe("workflow-plan");
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  test("a global --format json placed BEFORE the subcommand is honoured, not silently ignored", async () => {
    writeBasicWorkflow();
    await index();

    const result = await runCliCapture(["--format", "json", "workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
  });
});

describe("akm workflow plan <ref> — text mode (B-46)", () => {
  test("exits 0 and prints a human summary on stdout", async () => {
    writeBasicWorkflow();
    await index();

    // #903: text is no longer the unmarked default, so ask for it. The
    // renderer itself is unchanged and still worth pinning.
    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--format", "text"]);
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.stdout).toContain("workflows/basic-plan");
    expect(result.stdout.trimStart().startsWith("{")).toBe(false);
  });
});

describe("akm workflow plan <ref> --format json (B-47, B-N9)", () => {
  test("prints one JSON object with the exact closed key set", async () => {
    writeBasicWorkflow();
    await index();

    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope).toBeInstanceOf(Object);
    expect(Array.isArray(envelope)).toBe(false);

    for (const key of Object.keys(envelope)) {
      expect(ENVELOPE_ROOT_KEYS.has(key)).toBe(true);
    }
    expect(envelope.ok).toBe(true);
    expect(envelope.ref).toContain("workflows/basic-plan");
    expect(envelope.published).toBe(false);
    expect(typeof envelope.irVersion).toBe("number");
    expect(typeof envelope.planHash).toBe("string");
    expect(Array.isArray(envelope.steps)).toBe(true);
    expect(Array.isArray(envelope.notices)).toBe(true);
    expect(Array.isArray(envelope.warnings)).toBe(true);
    expect(envelope.execution).toMatchObject({ maxConcurrency: expect.any(Number) });
  });

  test("never spells --json (B-N9): the flag is --format json, and --json is rejected", async () => {
    writeBasicWorkflow();
    await index();
    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--json"]);
    // Unknown-flag rejection (src/cli/unknown-flags.ts UNKNOWN_FLAG usage error)
    // -> exit 2. This path prints a plain-text message, not the JSON error
    // envelope, so there is no `code` field to assert on here. Ground-truthed
    // by probing the actual CLI output before pinning.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Unknown flag "--json"');
  });
});

describe("akm --format json workflow plan <ref> — global (pre-subcommand) flag position (code-review round 4, finding 3 / Review log R3)", () => {
  test("--format json BEFORE the subcommand still emits the JSON envelope, not the text summary", async () => {
    writeBasicWorkflow();
    await index();

    // citty parses each command level against only that level's own
    // remaining argv (the one-parse rule, GLOBAL_OUTPUT_ARGS's doc comment
    // in src/cli/shared.ts): `--format json` typed BEFORE `workflow plan`
    // is consumed by the ROOT command's own declared `format` arg, so the
    // LEAF's `args.format` reads `undefined` here even though a format WAS
    // named explicitly. Reading that leaf arg (rather than the canonical,
    // position-independent argv scan `getOutputMode()` itself is built from)
    // used to fall back to the human-text branch for exactly this
    // invocation shape, at exit 0 — silently discarding an explicit
    // `--format json`.
    const result = await runCliCapture(["--format", "json", "workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
    expect(envelope.published).toBe(false);
    expect(Array.isArray(envelope.steps)).toBe(true);
  });

  test("control: akm --format json workflow list in the same global position already emitted JSON (an unaffected verb, for contrast)", async () => {
    writeBasicWorkflow();
    await index();
    const result = await runCliCapture(["--format", "json", "workflow", "list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
  });

  test("the LEAF (post-subcommand) position keeps working exactly as before — both positions now agree", async () => {
    writeBasicWorkflow();
    await index();
    const globalPosition = await runCliCapture(["--format", "json", "workflow", "plan", "workflows/basic-plan"]);
    const leafPosition = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--format", "json"]);
    expect(globalPosition.code).toBe(0);
    expect(leafPosition.code).toBe(0);
    const globalEnvelope = JSON.parse(globalPosition.stdout) as Record<string, unknown>;
    const leafEnvelope = JSON.parse(leafPosition.stdout) as Record<string, unknown>;
    expect(globalEnvelope.ref).toBe(leafEnvelope.ref);
    expect(globalEnvelope.planHash).toBe(leafEnvelope.planHash);
  });
});

describe("akm workflow plan <ref> honors a persisted output.format config default (code review finding A)", () => {
  test("no --format anywhere, but config sets output.format: yaml -> yaml envelope, not the text summary", async () => {
    writeBasicWorkflow();
    await index();
    writeSandboxConfig({ output: { format: "yaml" } });

    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    // Not the human-text branch's shape (that always contains the bare ref
    // on its own descriptive line, never valid YAML/JSON on its own).
    const parsed = yamlParse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.published).toBe(false);
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  test("no --format anywhere, config sets output.format: json -> the JSON envelope like every other command (#903)", async () => {
    writeBasicWorkflow();
    await index();
    writeSandboxConfig({ output: { format: "json" } });

    // Before #903 this case deliberately produced the human text summary: a
    // resolved "json" was indistinguishable from "nothing configured", so the
    // bespoke branch could not honour it. `plan` is json-by-default now, so
    // there is nothing to distinguish and the envelope is simply correct.
    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.ref).toContain("workflows/basic-plan");
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  test("an explicit --format on the line still wins over a persisted yaml default", async () => {
    writeBasicWorkflow();
    await index();
    writeSandboxConfig({ output: { format: "yaml" } });

    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--format", "json"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope.ok).toBe(true);
  });
});

describe("akm workflow plan <ref> writes NOTHING durable (B-48)", () => {
  test("zero new rows across every workflow table, the events table, and usage_events — either mode", async () => {
    writeBasicWorkflow();
    await index();

    const before = tableCounts();
    const text = await runCliCapture(["workflow", "plan", "workflows/basic-plan"]);
    expect(text.code).toBe(0);
    const afterText = tableCounts();
    expect(afterText).toEqual(before);

    const json = await runCliCapture(["workflow", "plan", "workflows/basic-plan", "--format", "json"]);
    expect(json.code).toBe(0);
    const afterJson = tableCounts();
    expect(afterJson).toEqual(before);
  });

  test("emits no warn()/log output — stderr stays empty on a successful plan (B-56)", async () => {
    writeBasicWorkflow();
    await index();
    const result = await runCliCapture(["workflow", "plan", "workflows/basic-plan"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });
});

describe("akm workflow plan <ref> — compile warnings surface in warnings[] (B-56)", () => {
  test("a compile advisory is returned in warnings[], not written to stderr", async () => {
    // The document below trips a checkWorkflowPlan advisory (compile.ts).
    // The behavior under test is that `workflow plan` returns it in the
    // envelope's warnings[] instead of calling warn() — which would show up on
    // stderr at `akm workflow run`, breaking this verb's B-48 guarantee.
    writeWarningWorkflow();
    await index();
    const result = await runCliCapture(["workflow", "plan", "workflows/warns-plan", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { warnings: string[] };
    expect(envelope.warnings.some((w) => w.includes("params.chanel"))).toBe(true);
    expect(result.stderr).toBe("");
  });
});

describe("akm workflow plan <ref> — lowering notices from freeze surface in notices[] (B-57)", () => {
  // `test-llm` (writeWorkflowTestConfig) declares no `supportsJsonSchema`, so
  // the direct-LLM builder (src/integrations/agent/execution.ts's buildLlm)
  // rejects this step's declared unit output: schema with a real
  // "untranslated-field" notice. That notice is computed at freeze time
  // (freeze/targets/command.ts's commandResult builds the execution) and was
  // once silently discarded — it is exactly the
  // freeze-time notice row B-57 requires `akm workflow plan` to surface,
  // through the same {code, severity, adapter, field, message} projection
  // `akm workflow run` already renders (tests/output-workflow-lowering-notices.test.ts).
  function writeLoweringNoticeWorkflow(): void {
    write(
      "workflows/plan-lowering-notice.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: notify",
        "    unit:",
        "      engine: test-llm",
        "      output:",
        "        type: object",
        "        properties:",
        "          ok:",
        "            type: boolean",
        "---",
        "",
        "## notify",
        "",
        "Notify the channel.",
        "",
      ].join("\n"),
    );
  }

  test("the notice's code/adapter/message reach notices[] in JSON mode and render as a lowering[] line in text mode", async () => {
    writeLoweringNoticeWorkflow();
    await index();

    const json = await runCliCapture(["workflow", "plan", "workflows/plan-lowering-notice", "--format", "json"]);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.stdout) as { notices: Array<Record<string, unknown>> };
    expect(envelope.notices.length).toBeGreaterThan(0);
    const notice = envelope.notices.find((n) => n.code === "untranslated-field");
    expect(notice).toBeDefined();
    expect(notice?.adapter).toBe("llm");
    expect(String(notice?.message)).toContain("outputSchema");

    const text = await runCliCapture(["workflow", "plan", "workflows/plan-lowering-notice", "--format", "text"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("notices:");
    // §4.6's exact line shape: `! lowering[<severity>] <code> (<adapter>): <message>`.
    expect(text.stdout).toContain("! lowering[");
    expect(text.stdout).toContain("untranslated-field");
    expect(text.stdout).toContain("llm");
    expect(text.stdout).toContain("does not translate resolved field outputSchema");
  });
});

describe("akm workflow plan <ref> — a workflow composing a child (B-49)", () => {
  function writeChild(): void {
    write(
      "workflows/plan-child.md",
      [
        "---",
        "type: workflow",
        "outputs:",
        "  report:",
        "    from: steps.work.output",
        "steps:",
        "  - id: work",
        "---",
        "",
        "## work",
        "",
        "Do the work.",
        "",
      ].join("\n"),
    );
  }

  test("a per-step expansion names via: child, the child ref, its planHash, and its declared output names", async () => {
    writeChild();
    writeParent("plan-composes-child", ["      - id: dispatch", "        uses: workflows/plan-child"]);
    await index();

    const result = await runCliCapture(["workflow", "plan", "workflows/plan-composes-child", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { steps: Array<Record<string, unknown>> };
    const dispatch = envelope.steps.find((s) => s.stepId === "dispatch");
    expect(dispatch).toBeDefined();
    const expansion = (dispatch as Record<string, unknown>).expansion as Record<string, unknown>;
    expect(expansion.via).toBe("child");
    expect(String(expansion.childRef)).toContain("plan-child");
    expect(typeof expansion.childPlanHash).toBe("string");
    expect(expansion.childOutputs).toEqual(["report"]);
    expect(Array.isArray(expansion.steps)).toBe(true);
  });

  // Code review finding B: text mode must carry the same child plan hash,
  // `with:` input bindings, and `exports:` line the spec's §4.6 worked
  // example prescribes — not just --format json.
  test("text mode: the step line carries the child's plan hash, a with: line for its bindings, and an exports: line", async () => {
    write(
      "workflows/plan-child-params.md",
      [
        "---",
        "type: workflow",
        "params:",
        "  scope: { type: string }",
        "outputs:",
        "  report:",
        "    from: steps.work.output",
        "steps:",
        "  - id: work",
        "---",
        "",
        "## work",
        "",
        "Do the work.",
        "",
      ].join("\n"),
    );
    writeParent("plan-composes-child-text", [
      "      - id: dispatch",
      "        uses: workflows/plan-child-params",
      "        with:",
      "          scope: urgent",
    ]);
    await index();

    const jsonResult = await runCliCapture([
      "workflow",
      "plan",
      "workflows/plan-composes-child-text",
      "--format",
      "json",
    ]);
    expect(jsonResult.code).toBe(0);
    const envelope = JSON.parse(jsonResult.stdout) as { steps: Array<Record<string, unknown>> };
    const dispatch = envelope.steps.find((s) => s.stepId === "dispatch") as Record<string, unknown>;
    const expansion = dispatch.expansion as Record<string, unknown>;
    const childPlanHash = String(expansion.childPlanHash);

    const textResult = await runCliCapture([
      "workflow",
      "plan",
      "workflows/plan-composes-child-text",
      "--format",
      "text",
    ]);
    expect(textResult.code).toBe(0);
    expect(textResult.stdout).toContain(`(plan ${childPlanHash})`);
    expect(textResult.stdout).toContain('with: scope="urgent" (literal)');
    expect(textResult.stdout).toContain("exports: report");
  });
});

describe("akm workflow plan <ref> — a task-wrapped step (B-50)", () => {
  test("a per-step expansion names via: task and the taskRef", async () => {
    write("commands/plan-noop.md", "Do nothing.\n");
    write("tasks/plan-wrapper.yml", ["version: 4", "run: echo wrapped", "shell: sh", ""].join("\n"));
    writeParent("plan-task-wrapped", ["      - id: dispatch", "        uses: tasks/plan-wrapper"]);
    await index();

    const result = await runCliCapture(["workflow", "plan", "workflows/plan-task-wrapped", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { steps: Array<Record<string, unknown>> };
    const dispatch = envelope.steps.find((s) => s.stepId === "dispatch");
    const expansion = (dispatch as Record<string, unknown>).expansion as Record<string, unknown>;
    expect(expansion.via).toBe("task");
    expect(String(expansion.taskRef)).toContain("plan-wrapper");
  });
});

describe("akm workflow plan <ref> — inputBindings: literal shown, reference shown unresolved (B-51)", () => {
  test("a literal with: value is shown; a reference with: {from:...} shows its from, never a resolved value", async () => {
    write("commands/plan-consume.md", "Consume a note.\n");
    write(
      "tasks/plan-consume-task.yml",
      ["version: 4", "inputs:", "  note:", "    type: string", "uses: commands/plan-consume", ""].join("\n"),
    );
    writeParent("plan-input-bindings", [
      "      - id: produce",
      "        uses: tasks/plan-consume-task",
      "        with:",
      "          note: literal-value-shown",
      "      - id: consume",
      "        uses: tasks/plan-consume-task",
      "        with:",
      "          note:",
      "            from: steps.produce.output",
    ]);
    await index();

    const result = await runCliCapture(["workflow", "plan", "workflows/plan-input-bindings", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { steps: Array<Record<string, unknown>> };
    const produce = envelope.steps.find((s) => s.stepId === "produce") as Record<string, unknown>;
    const consume = envelope.steps.find((s) => s.stepId === "consume") as Record<string, unknown>;
    const produceBindings = produce.inputBindings as Array<Record<string, unknown>>;
    const consumeBindings = consume.inputBindings as Array<Record<string, unknown>>;

    const literalBinding = produceBindings.find((b) => b.name === "note");
    expect(literalBinding).toMatchObject({ kind: "literal", value: "literal-value-shown" });

    const referenceBinding = consumeBindings.find((b) => b.name === "note");
    expect(referenceBinding).toMatchObject({ kind: "reference", from: "steps.produce.output" });
    // Never a resolved value for a reference binding.
    expect(referenceBinding).not.toHaveProperty("value");
  });
});

describe("akm workflow plan <ref> — SECRET-FREE, sentinel proof (B-52, B-53)", () => {
  const COMMAND_SENTINEL = "PLAN-COMMAND-BODY-SENTINEL-7f2a9c";
  const ENV_SENTINEL = "plan-env-sentinel-1";

  function writeSentinelFixture(): void {
    write(
      "workflows/plan-sentinel-command.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: say",
        "---",
        "",
        "## say",
        "",
        `Say ${COMMAND_SENTINEL} out loud.`,
        "",
      ].join("\n"),
    );
    writeParent("plan-sentinel-env", [
      "      - id: run-it",
      "        run: echo hi",
      "        shell: sh",
      "        env:",
      `          NOTE: ${ENV_SENTINEL}`,
    ]);
  }

  test("no sentinel appears in stdout or JSON envelope bytes, in either mode", async () => {
    writeSentinelFixture();
    await index();

    for (const ref of ["workflows/plan-sentinel-command", "workflows/plan-sentinel-env"]) {
      const text = await runCliCapture(["workflow", "plan", ref]);
      expect(text.code).toBe(0);
      expect(text.stdout).not.toContain(COMMAND_SENTINEL);
      expect(text.stdout).not.toContain(ENV_SENTINEL);
      expect(text.stderr).not.toContain(COMMAND_SENTINEL);
      expect(text.stderr).not.toContain(ENV_SENTINEL);

      const json = await runCliCapture(["workflow", "plan", ref, "--format", "json"]);
      expect(json.code).toBe(0);
      expect(json.stdout).not.toContain(COMMAND_SENTINEL);
      expect(json.stdout).not.toContain(ENV_SENTINEL);
    }
  });

  test("environment[] carries only kind/name for a literal binding — never its value", async () => {
    writeParent("plan-env-literal-shape", [
      "      - id: run-it",
      "        run: echo hi",
      "        shell: sh",
      "        env:",
      `          NOTE: ${ENV_SENTINEL}`,
    ]);
    await index();
    const result = await runCliCapture(["workflow", "plan", "workflows/plan-env-literal-shape", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { steps: Array<Record<string, unknown>> };
    const step = envelope.steps.find((s) => s.stepId === "run-it") as Record<string, unknown>;
    const environment = step.environment as Array<Record<string, unknown>>;
    const literal = environment.find((e) => e.name === "NOTE");
    expect(literal).toBeDefined();
    expect(literal).not.toHaveProperty("value");
    expect(JSON.stringify(environment)).not.toContain(ENV_SENTINEL);
  });
});

describe("akm workflow plan <ref> — a workflow that fails to freeze (B-55)", () => {
  function writeBrokenWorkflow(): void {
    write(
      "workflows/plan-broken.md",
      [
        "---",
        "type: workflow",
        "steps:",
        "  - id: first",
        "  - id: second",
        "    inputs: [steps.ghost.output]",
        "---",
        "",
        "## first",
        "",
        "Do the first thing.",
        "",
        "## second",
        "",
        "Do the second thing.",
        "",
      ].join("\n"),
    );
  }

  test("reports the same error/code/exit code as akm workflow run, and still writes nothing", async () => {
    writeBrokenWorkflow();
    await index();
    const before = tableCounts();

    const planResult = await runCliCapture(["workflow", "plan", "workflows/plan-broken"]);
    const runResult = await runCliCapture(["workflow", "run", "workflows/plan-broken"]);

    expect(planResult.code).toBe(runResult.code);
    const planEnvelope = JSON.parse(planResult.stderr) as { ok: boolean; code: string };
    const runEnvelope = JSON.parse(runResult.stderr) as { ok: boolean; code: string };
    expect(planEnvelope.ok).toBe(false);
    expect(planEnvelope.code).toBe(runEnvelope.code);

    expect(tableCounts()).toEqual(before);
  });
});

describe("akm workflow plan — no ref / an unknown ref (B-58)", () => {
  test("no ref at all: usage error, exit 2", async () => {
    const result = await runCliCapture(["workflow", "plan"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });

  test("an unknown ref: not-found error, exit 1", async () => {
    const result = await runCliCapture(["workflow", "plan", "workflows/does-not-exist-at-all"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });
});
