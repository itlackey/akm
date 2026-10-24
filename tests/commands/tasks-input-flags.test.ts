// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `akm task run`'s exact-name input flags.
 *
 * A *valid* input flag set is not delivered anywhere beyond the invocation and
 * leaves the run's OBSERVABLE result byte-identical to the same run without
 * those flags. So the claim "akm task run <id> --scope all --strict passes
 * literal inputs into the invocation" cannot be read off `TaskRunResult`,
 * stdout, or the run log; the dedicated end-to-end describe block near the
 * bottom of this file pins that byte-identity through the REAL `akm task run`
 * CLI path. The isolated Stage 2 (materialize + attach) behavior is asserted
 * through a test-only seam instead: `RunTaskOptions.captureTaskInvocation`,
 * called once with the CONSTRUCTED `TaskInvocation` that Stage 2 (load-task.ts)
 * builds, before dispatch and never read back by production code. The
 * load-bearing assertion is `TaskInvocation.inputs`. The seam is modeled on the
 * other test-only overrides on `RunTaskOptions` (`beforeNativeDispatch`,
 * `spawnFn`, `runAgentImpl`, …, src/tasks/run/task-result.ts); it hands back
 * the whole `TaskInvocation` so that a side-channel-only implementation cannot
 * satisfy it without attaching `.inputs` to a real invocation.
 *
 * The declared-input enumeration and the underlying-detail requirement are
 * pinned by checking the WHOLE serialized `{ok,error,code,hint}` envelope
 * (`JSON.stringify(envelope)`), not `.error` alone — `emitJsonError`
 * (src/cli/shared.ts) serializes a UsageError's `hint` into the envelope too,
 * and the workflow analogue's own "Declared parameters: …" text lives in
 * exactly that separate `hint`, not the message (src/workflows/ir/params.ts).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isTaskRunWithId } from "../../src/cli";
import * as TasksCliModule from "../../src/commands/tasks/tasks-cli";
import { validateJsonSchemaSubset } from "../../src/core/json-schema";
import type { TaskInputBinding } from "../../src/execution/input-contract";
import type { TaskInvocation } from "../../src/tasks/model/invocation";
import { loadPreparedTask } from "../../src/tasks/run/load-task";
import type { RunTaskOptions } from "../../src/tasks/run/task-result";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const { parseTaskInputFlags, TASK_RUN_BOOLEAN_FLAGS, TASK_RUN_VALUE_FLAGS } = TasksCliModule;

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
  writeSandboxConfig({
    bundles: { fixture: { path: storage.stashDir, writable: true } },
    defaultBundle: "fixture",
    semanticSearchMode: "off",
  });
});

afterEach(() => storage.cleanup());

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

/**
 * A task source v4 document with two OPTIONAL, defaulted inputs — no flag is
 * ever required to run it. `run:`/`shell:` (rather than `uses:
 * commands/...`) so preparation needs no engine/agent config (mirrors
 * tests/tasks-runtime-v3-runner.test.ts's `run: exit 7\nshell:
 * sh` fixtures).
 */
const REVIEW_TASK_YAML = [
  "version: 4",
  "name: Review",
  "inputs:",
  "  scope:",
  "    type: string",
  "    enum: [changed, all]",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  'run: "true"',
  "shell: sh",
  "",
].join("\n");

/** The same two optional inputs, plus one REQUIRED `ticket` input. */
const TICKETED_TASK_YAML = [
  "version: 4",
  "name: Ticketed review",
  "inputs:",
  "  scope:",
  "    type: string",
  "    enum: [changed, all]",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  "  ticket:",
  "    type: string",
  "    required: true",
  'run: "true"',
  "shell: sh",
  "",
].join("\n");

/** One optional ARRAY-declared input — the array-grouping path. */
const TAGGED_TASK_YAML = [
  "version: 4",
  "name: Tagged review",
  "inputs:",
  "  tags:",
  "    type: array",
  "    items:",
  "      type: string",
  'run: "true"',
  "shell: sh",
  "",
].join("\n");

describe("akm task run — exact-name input flags materialize literal bindings (P2a spec §5.1)", () => {
  // The materialized literals must become `readonly TaskInputBinding[]` on the
  // `TaskInvocation` the run CONSTRUCTS (`TaskInvocation.inputs?`,
  // src/tasks/model/invocation.ts). The seam hands back that
  // `TaskInvocation` itself rather than a bespoke array, so a differently-shaped,
  // side-channel-only implementation (one production code never actually
  // reads) cannot satisfy the test without attaching `.inputs` to a real
  // `TaskInvocation`. A seam is needed at all because test-only observability
  // is otherwise impossible: the model-purity ratchet
  // (tests/tasks/model-contracts.test.ts) keeps `TaskInvocation` a pure,
  // IO-free type, and nothing in production reads the inputs back.
  test('"--scope all --strict" materializes both as literal TaskInputBinding entries on the constructed TaskInvocation before dispatch (B-06, B-30, B-31)', async () => {
    writeTask("review", REVIEW_TASK_YAML);
    let captured: TaskInvocation | undefined;

    // Stage 1 (the CLI's parseTaskInputFlags, tasks-cli.ts) would produce
    // exactly this InputFlag[] for `akm task run review --scope all
    // --strict`: a following non-flag token is consumed as the value
    // ("all"); a trailing boolean flag with no following value materializes
    // `true` (mirrors parseWorkflowParameterFlags in
    // src/commands/workflow-cli.ts). Constructed by hand here so
    // this test exercises Stage 2 (materialize + attach) in isolation from
    // Stage 1's own argv-scanning, which the envelope tests below exercise
    // for real through the actual CLI.
    const options: RunTaskOptions = { bundleDir: storage.stashDir, bundleName: "fixture" };
    options.inputFlags = [
      { name: "scope", value: "all" },
      { name: "strict", value: true },
    ];
    options.captureTaskInvocation = (invocation: TaskInvocation) => {
      captured = invocation;
    };

    await loadPreparedTask("review", options);

    if (!captured)
      throw new Error(
        "captureTaskInvocation was never called — Stage 2 did not construct a TaskInvocation, or the seam is wired to a different name",
      );
    const inputs = captured.inputs as readonly TaskInputBinding[] | undefined;
    if (!inputs) throw new Error("TaskInvocation.inputs was not populated");
    const byName = [...inputs].sort((a, b) => a.name.localeCompare(b.name));
    expect(byName).toEqual([
      { kind: "literal", name: "scope", value: "all" },
      { kind: "literal", name: "strict", value: true },
    ]);
  });

  // `emitJsonError` (src/cli/shared.ts) serializes BOTH `error` and (when the
  // UsageError carries one) `hint` into the envelope, and
  // `TASK_INPUT_DIAGNOSTICS.unknownFlag`
  // (src/tasks/source/task-input-diagnostics.ts) is not required to put the
  // declared-input enumeration in one specific field — the workflow
  // analogue's `unknown workflow parameter` error puts it in the SEPARATE
  // `hint`. This checks the whole serialized envelope rather than assuming
  // the enumeration is in `.error`; a bare `typeof envelope.error === "string"`
  // check would be satisfied by any non-empty string.
  test("an input flag the task does not declare fails UNKNOWN_FLAG, naming the offending flag and enumerating the declared inputs (B-27)", async () => {
    writeTask("review", REVIEW_TASK_YAML);
    const result = await runCliCapture(["task", "run", "review", "--not-a-declared-input", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string; hint?: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_FLAG");
    const rendered = JSON.stringify(envelope);
    // Names the offending flag …
    expect(rendered).toContain("not-a-declared-input");
    // … and enumerates BOTH declared input names, mirroring the workflow
    // analogue's "Declared parameters: --alpha, --beta." hint
    // (src/workflows/ir/params.ts).
    expect(rendered).toContain("scope");
    expect(rendered).toContain("strict");
  });

  test("a value that violates its input's declared schema fails INPUT_BINDING_INVALID, naming the input and carrying validateJsonSchemaSubset's own detail (B-28)", async () => {
    writeTask("ticketed", TICKETED_TASK_YAML);
    // `scope` is declared `enum: [changed, all]`; "bogus" satisfies neither.
    // `--ticket` is supplied so this fails on the VALUE, not the separate
    // missing-required path the next test covers.
    //
    // Derive the expected detail fragment from the real
    // validateJsonSchemaSubset (src/core/json-schema.ts) rather than guessing
    // its wording — mirrors tests/tasks/source-v4.test.ts. The declaration's
    // `default`/root `required` are stripped before validation, so the schema
    // handed to the validator here omits both, matching what `validateInputs`
    // will actually check against. `redactValues: true` mirrors
    // `validateInputs`'s own call (credential safety: typed-input flags can
    // carry credentials, so the CLI's actual envelope never echoes the
    // supplied "bogus" value — this oracle must not either, or the
    // `toContain` check below could never pass).
    const [rawDetail] = validateJsonSchemaSubset(
      "bogus",
      { type: "string", enum: ["changed", "all"] },
      { redactValues: true },
    );
    if (!rawDetail) throw new Error("expected validateJsonSchemaSubset to report a violation for this fixture");
    const detailSuffix = rawDetail.replace(/^\$:\s*/, "");

    const result = await runCliCapture(["task", "run", "ticketed", "--ticket", "T-1", "--scope", "bogus"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string; hint?: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    // `detailSuffix` comes straight from `validateJsonSchemaSubset`
    // (never JSON-encoded) and legitimately embeds literal `"` characters
    // (`is not one of ["changed","all"]`) — `JSON.stringify(envelope)` would
    // re-escape those to `\"`, so a substring check against the STRINGIFIED
    // envelope can never match the RAW detail text. Checking the already
    // `JSON.parse`d string fields directly (still real, unescaped strings)
    // is the byte-accurate comparison; the whole envelope stays covered by
    // joining every textual field the diagnostics vocabulary might use.
    const rendered = [envelope.error, envelope.hint]
      .filter((part): part is string => typeof part === "string")
      .join(" ");
    // Names the offending input …
    expect(rendered).toContain("scope");
    // … and carries validateJsonSchemaSubset's own underlying detail text.
    expect(rendered).toContain(detailSuffix);
  });

  test("omitting a required: true input with no flag at all fails INPUT_BINDING_INVALID, naming the missing input (B-29)", async () => {
    writeTask("ticketed", TICKETED_TASK_YAML);
    const result = await runCliCapture(["task", "run", "ticketed"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    // The detail names the missing input: its own name must appear somewhere
    // in the rendered envelope.
    expect(JSON.stringify(envelope)).toContain("ticket");
  });
});

// ── Duplicate/array-grouped input flags end to end, through the REAL
// `akm task run` CLI path and the REAL TASK_INPUT_DIAGNOSTICS vocabulary —
// not the sentinel UsageErrors the probe-based unit tests in
// tests/execution/input-contract.test.ts construct themselves. These tests
// drive real argv through `akm task run`, asserting on the REAL, serialized
// {ok:false,error,code} envelope (or, for the success case, the real run
// result).

describe("akm task run — B-31 array grouping and its failure modes, end to end", () => {
  test("`--tags a --tags b` on a type: array input succeeds with the grouped array (B-31)", async () => {
    writeTask("tagged", TAGGED_TASK_YAML);
    const result = await runCliCapture(["task", "run", "tagged", "--tags", "a", "--tags", "b"]);

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { result: { id: string; status: string } };
    expect(envelope.result.id).toBe("tagged");
    expect(envelope.result.status).toBe("completed");
  });

  test("a repeated flag on a NON-array-declared input fails INPUT_BINDING_INVALID on the real envelope (B-31)", async () => {
    writeTask("review", REVIEW_TASK_YAML);
    // `scope` is declared `type: string` (not array) — two distinct,
    // individually-valid enum values still trip the duplicate-non-array
    // rejection, which fires on flag COUNT before any per-value check.
    const result = await runCliCapture(["task", "run", "review", "--scope", "changed", "--scope", "all"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    expect(JSON.stringify(envelope)).toContain("scope");
  });

  test("a malformed JSON-array shorthand (`[not json`) fails INPUT_BINDING_INVALID on the real envelope (B-31)", async () => {
    writeTask("tagged", TAGGED_TASK_YAML);
    const result = await runCliCapture(["task", "run", "tagged", "--tags", "[not json"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INPUT_BINDING_INVALID");
    expect(JSON.stringify(envelope)).toContain("tags");
  });
});

// ── A valid input flag set is byte-identical to the same run without flags; a
// manual-only v4 task runs end-to-end.

describe("akm task run — end to end (B-26, §0: a valid flag set is byte-identical to the same run without flags)", () => {
  /** Fields that legitimately differ between two separate runs of the identical task (timestamps, the per-run log file path). */
  const VOLATILE_RESULT_FIELDS = ["startedAt", "finishedAt", "durationMs", "log"] as const;

  function stableResult(result: Record<string, unknown>): Record<string, unknown> {
    const stable = { ...result };
    for (const field of VOLATILE_RESULT_FIELDS) delete stable[field];
    return stable;
  }

  test("the same version: 4 task run bare and run with a valid --scope/--strict flag set produce byte-identical exit codes, run results, and history rows", async () => {
    writeTask("review", REVIEW_TASK_YAML);

    const bare = await runCliCapture(["task", "run", "review"]);
    const flagged = await runCliCapture(["task", "run", "review", "--scope", "all", "--strict"]);

    expect(bare.code).toBe(flagged.code);
    const bareEnvelope = JSON.parse(bare.stdout) as { result: Record<string, unknown> };
    const flaggedEnvelope = JSON.parse(flagged.stdout) as { result: Record<string, unknown> };
    expect(stableResult(flaggedEnvelope.result)).toEqual(stableResult(bareEnvelope.result));

    const history = await runCliCapture(["task", "history", "--id", "review", "--limit", "2"]);
    const rows = (JSON.parse(history.stdout) as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toHaveLength(2);
    expect(stableResult(rows[0] as Record<string, unknown>)).toEqual(stableResult(rows[1] as Record<string, unknown>));
  });

  test("a manual-only version: 4 task (no schedule:) parses AND runs successfully end-to-end via akm task run (§9 acceptance bullet)", async () => {
    writeTask("review", REVIEW_TASK_YAML);
    const result = await runCliCapture(["task", "run", "review"]);

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as { result: { id: string; status: string } };
    expect(envelope.result.id).toBe("review");
    expect(envelope.result.status).toBe("completed");
  });
});

// ── Retired --target and `akm task run`'s own declared flags are PRESERVED,
// never treated as inputs.

describe("akm task run <id> --target x — the retired-flag usage error is unchanged (B-32, PRESERVE)", () => {
  test("still rejects with the retired-flag INVALID_FLAG_VALUE usage error, exit 2 — --target is NEVER treated as an input", async () => {
    // rejectRetiredTaskTargetFlag() (src/commands/tasks/tasks-cli.ts) runs
    // BEFORE any task lookup, so the id need not exist for this to fire.
    const result = await runCliCapture(["task", "run", "anything", "--target", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(envelope.error).toBe("`akm task --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.");
  });

  // The rejecter must catch the inline `=` spellings too: `hasFlag("--target")`
  // compares WHOLE tokens against `--target` and `--target=true` only, so
  // `--target=team` would slip past it. Nothing else catches it either: the
  // generic pre-dispatch gate exempts `target` on every `task` subcommand by
  // NAME (`src/cli/unknown-flags.ts`'s `SELF_DIAGNOSED_FLAGS`) precisely so
  // this handler can answer with the rename hint, so an unrejected
  // `--target=team` would be absorbed silently by citty's non-strict parser
  // and the user's chosen bundle quietly ignored.
  test("the inline `--target=<value>` spelling gets the SAME rename error, on every task subcommand that declares --bundle", async () => {
    for (const argv of [
      ["task", "run", "anything", "--target=x"],
      ["task", "history", "--target=x"],
      ["task", "sync", "--target=x"],
    ]) {
      const label = argv.join(" ");
      const result = await runCliCapture(argv);

      expect(result.code, label).toBe(2);
      const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
      expect(envelope.ok, label).toBe(false);
      expect(envelope.code, label).toBe("INVALID_FLAG_VALUE");
      expect(envelope.error, label).toBe(
        "`akm task --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.",
      );
    }
  });

  // Rejecting `--target` by NAME also swallows `--target=<value>`, which would
  // otherwise be the only working way to supply a legally-declared task input
  // NAMED `target` — `target` sits in neither TASK_RUN_VALUE_FLAGS nor
  // TASK_RUN_BOOLEAN_FLAGS, so parseTaskInputFlags would capture it as an
  // ordinary input flag, while the bare `--target x` spelling is already
  // rejected at whole-token level. The rejecter is NOT narrowed back (that
  // reopens the silently-ignored `--target=team` above): `target` is reserved
  // at DECLARATION time instead (TASK_RUN_SELF_DIAGNOSED_FLAGS,
  // src/tasks/task-run-reserved-flags.ts), so the unusable declaration cannot
  // be authored and the rename hint stays the only thing `--target` can mean.
  test("a task that DECLARES an input named `target` is rejected at parse time, so no run can ever need the flag the rename hint eats", async () => {
    writeTask(
      "deploy",
      [
        "version: 4",
        "inputs:",
        "  target:",
        "    type: string",
        "    default: staging",
        'run: "true"',
        "shell: sh",
        "",
      ].join("\n"),
    );

    for (const argv of [
      ["task", "run", "deploy"],
      ["task", "explain", "deploy"],
    ]) {
      const label = argv.join(" ");
      const result = await runCliCapture(argv);

      expect(result.code, label).toBe(2);
      const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
      expect(envelope.ok, label).toBe(false);
      expect(envelope.code, label).toBe("TASK_SOURCE_INVALID");
      expect(envelope.error, label).toContain("inputs.target collides with the retired `akm task --target` spelling");
      expect(envelope.error, label).toContain("declare the input under a different name.");
    }
  });
});

describe("parseTaskInputFlags — akm task run's own declared flags are excluded from the captured input set (B-33, PRESERVE)", () => {
  test("--bundle/--format/--scheduled/--quiet are parsed as their declared flags and never appear in the materialized flag set; a genuine input flag still does", () => {
    const flags = parseTaskInputFlags(
      ["review", "--bundle", "fixture", "--format", "json", "--scheduled", "--quiet", "--scope", "all"],
      "review",
    );
    expect(flags).toEqual([{ name: "scope", value: "all" }]);
  });

  test("TASK_RUN_VALUE_FLAGS / TASK_RUN_BOOLEAN_FLAGS are exactly the closed sets spec §5.1 names", () => {
    expect([...TASK_RUN_VALUE_FLAGS].sort()).toEqual(["bundle", "detail", "format", "output", "shape"].sort());
    expect([...TASK_RUN_BOOLEAN_FLAGS].sort()).toEqual(
      ["help", "no-quiet", "no-verbose", "quiet", "scheduled", "verbose"].sort(),
    );
  });
});

describe("isTaskRunWithId — F-5's explicit classification requirement", () => {
  test("`akm task run <id> --scope all` still classifies as a task-run-with-id", () => {
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "run", "nightly", "--scope", "all"])).toBe(true);
  });

  // PRESERVED companion: unaffected non-task-run invocations still classify
  // false, so the pin above cannot be satisfied by an always-true stub.
  test("a non-task-run invocation still classifies false", () => {
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "history"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "workflow", "run", "workflows/x"])).toBe(false);
  });
});
