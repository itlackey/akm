// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2a Lane C — `akm task run`'s exact-name input flags (spec
 * docs/plans/specs/p2a-task-source-v4.md §5.1, §1.4 "Lane C — CLI + schema +
 * docs"). This lane owns ONLY this file plus the AUTHORIZED updates to
 * tests/integration/tasks-schema.test.ts (§6 F-1).
 *
 * RED phase: task source v4 (`src/tasks/source/task-source-v4.ts`, Lane A),
 * the shared input contract (`src/execution/input-contract.ts`, Lane B), and
 * this lane's own additions — `RunTaskOptions.inputFlags` on
 * `src/tasks/run/task-result.ts`, plus this file's own test-only
 * `captureTaskInvocation` seam on that same options bag — do not exist yet.
 * Every reference to one of those not-yet-existing names carries a
 * directly-preceding
 *
 *   // @ts-expect-error P2a red-phase: <symbol> lands in Implement
 *
 * directive, per the task brief's RED-PHASE TYPE PINS contract. This mirrors
 * the convention `tests/tasks/source-v4.test.ts` and
 * `tests/execution/input-contract.test.ts` already established for this
 * phase: one pin exactly where `tsc` reports the diagnostic (the module
 * specifier line for an unresolved import; the assignment line for a
 * property TypeScript does not yet know about on an existing type), verified
 * empirically against this repo's tsconfig — never a second pin on a
 * downstream use once the name is bound.
 *
 * §0 of the spec ("What P2a is not") is binding for the first test below: a
 * *valid* input flag set is not delivered anywhere in P2a and leaves the
 * run's OBSERVABLE result byte-identical to the same run without those
 * flags (B-26). That means the claim "akm task run <id> --scope all --strict
 * passes literal inputs into the invocation" cannot be read off
 * `TaskRunResult`, stdout, or the run log — every one of those is required
 * to stay unchanged by a valid flag set (see the dedicated end-to-end
 * describe block near the bottom of this file, which pins exactly that
 * byte-identity through the REAL `akm task run` CLI path). The task brief
 * anticipates exactly this and offers two ways to assert the isolated Stage 2
 * (materialize + attach) behavior: "the run result/log or an injected seam".
 * This file uses the seam: `RunTaskOptions.captureTaskInvocation`, called
 * with the CONSTRUCTED `TaskInvocation` Stage 2 (load-task.ts) builds, once —
 * before dispatch, never read back by production code — so the load-bearing
 * assertion is `TaskInvocation.inputs` (the widened model field §4.4
 * authorizes), not a bespoke side channel. It is modeled on the
 * already-existing test-only overrides on `RunTaskOptions`
 * (`beforeNativeDispatch`, `spawnFn`, `runAgentImpl`, …,
 * src/tasks/run/task-result.ts) and is this test's OWN addition, not a name
 * the spec itself pins — if Implement satisfies "the result becomes
 * TaskInvocation.inputs" through a differently-shaped seam, update this
 * test's call site and pins to match rather than re-deriving intent. (An
 * earlier version of this file's seam handed back only a bare
 * `TaskInputBinding[]`, which a side channel production code never reads
 * could satisfy without ever attaching `.inputs` to a real `TaskInvocation`
 * — test-review finding, tests/integration/commands/tasks-input-flags.test.ts:150.)
 *
 * B-27's declared-input enumeration and B-28's underlying-detail requirement
 * (test-review finding, tests/integration/commands/tasks-input-flags.test.ts:187)
 * are pinned by checking the WHOLE serialized `{ok,error,code,hint}` envelope
 * (`JSON.stringify(envelope)`), not `.error` alone — `emitJsonError`
 * (src/cli/shared.ts:113) serializes a UsageError's `hint` into the envelope
 * too, and the workflow analogue's own "Declared parameters: …" text lives in
 * exactly that separate `hint`, not the message (params.ts:51-56).
 *
 * IMPORTANT FINDING, recorded for Implement (out of scope for this
 * test-only lane to fix): `src/cli/unknown-flags.ts`'s `assertKnownFlags`
 * rejects, BEFORE a command's own body ever runs, any flag the resolved
 * command's declared `args` does not name. Today it carves out exactly one
 * dynamic per-command flag namespace — `known.path.join(" ") ===
 * "workflow run"` (`dynamicWorkflowParams`, unknown-flags.ts:225,270) — and
 * `task run` is not in it. The spec's Lane C file list never names
 * unknown-flags.ts, but `task run`'s exact-name input flags need the
 * identical carve-out: without it, EVERY input flag on `akm task run`,
 * declared or not, valid or not, is rejected by this generic gate before
 * `materializeInputFlags` ever sees it — and (a separate, pre-existing gap,
 * see `tests/integration/cli-errors.test.ts`'s "retired flags..." test
 * comment) that specific rejection path does not even render the
 * `{ok:false,error,code}` JSON envelope through this repo's in-process CLI
 * test harness (`tests/_helpers/cli.ts`'s `runCliCapture`), only through a
 * real subprocess. The three envelope-asserting tests below drive `akm task
 * run` through `runCliCapture` and will only go green once `task run` joins
 * `assertKnownFlags`'s passthrough set (so the eventual UNKNOWN_FLAG /
 * INPUT_BINDING_INVALID is raised from INSIDE the command body, where
 * `runWithJsonErrors` already renders the proper envelope) — verified
 * empirically: today, `akm task run <id> --scope all` on a plain v3 task
 * exits 2 with the bare text `Unknown flag "--scope".` on stderr, not a JSON
 * envelope, confirming both gaps are still open at the time this file was
 * written.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isTaskRunWithId } from "../../src/cli";
// `tasks-cli.ts` already exists (real exports: tasksCommand, etc.), so this
// namespace import itself resolves cleanly today and carries NO pin — only
// the destructuring below, which reaches for three not-yet-existing exports,
// needs one (a namespace import, not 3 separate named imports, per this
// file's own RED-phase import convention above: biome `--write` merges
// same-specifier named imports and stacks their pins, leaving all but the
// last "unused").
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
 * tests/integration/tasks-runtime-v3-runner.test.ts's `run: exit 7\nshell:
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

/** The same two optional inputs, plus one REQUIRED `ticket` input (B-28/B-29). */
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

/** One optional ARRAY-declared input — B-31's array-grouping path (spec §5.1, §4.2). */
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
  // Test-review remediation (finding recorded against
  // tests/integration/commands/tasks-input-flags.test.ts:150): §4.4/§5.1
  // require the materialized literals to become `readonly TaskInputBinding[]`
  // on the `TaskInvocation` the run CONSTRUCTS — `TaskInvocation.inputs?` is
  // the model-type declaration §4.4 explicitly authorizes
  // (src/tasks/model/invocation.ts). The original version of this test only
  // asserted a bespoke `captureInputBindings(bindings)` callback that this
  // file itself invented — a pin that a differently-shaped, side-channel-only
  // implementation (one production code never actually reads) could satisfy
  // without ever attaching `.inputs` to a real `TaskInvocation`. The seam
  // below still exists (test-only observability is otherwise impossible — the
  // model-purity ratchet, tests/tasks/parse-v3-adapter.test.ts, keeps
  // `TaskInvocation` a pure, IO-free type, so nothing production reads it back
  // from in P2a either, per spec §0), but it now hands back the CONSTRUCTED
  // `TaskInvocation` itself, and the load-bearing assertion is
  // `invocation.inputs` — the widened model field — not a bespoke array.
  test('"--scope all --strict" materializes both as literal TaskInputBinding entries on the constructed TaskInvocation before dispatch (B-06, B-30, B-31)', async () => {
    writeTask("review", REVIEW_TASK_YAML);
    let captured: TaskInvocation | undefined;

    // Stage 1 (the CLI's parseTaskInputFlags, tasks-cli.ts) would produce
    // exactly this InputFlag[] for `akm task run review --scope all
    // --strict`: a following non-flag token is consumed as the value
    // ("all"); a trailing boolean flag with no following value materializes
    // `true` (mirrors parseWorkflowParameterFlags,
    // src/commands/workflow-cli.ts:277-287). Constructed by hand here so
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

  // Test-review remediation (finding recorded against
  // tests/integration/commands/tasks-input-flags.test.ts:187): §9 requires
  // "every NEW row of §2 has at least one test asserting its code AND its
  // message text", and B-27's row requires the detail to list the declared
  // inputs — the original version of this test asserted only
  // `typeof envelope.error === "string"` and a non-zero length, which any
  // non-empty string satisfies. `emitJsonError` (src/cli/shared.ts:113)
  // serializes BOTH `error` and (when the UsageError carries one) `hint` into
  // the envelope, and `TASK_INPUT_DIAGNOSTICS.unknownFlag`
  // (src/tasks/source/task-input-diagnostics.ts) is not required to put the
  // declared-input enumeration in one specific field — `params.ts`'s own
  // `unknown workflow parameter` analogue puts it in the SEPARATE `hint`
  // (params.ts:51-56). This checks the whole serialized envelope (mirroring
  // the B-29 test below, already written this way) rather than assuming it
  // is in `.error` specifically.
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
    // (src/workflows/ir/params.ts:54).
    expect(rendered).toContain("scope");
    expect(rendered).toContain("strict");
  });

  test("a value that violates its input's declared schema fails INPUT_BINDING_INVALID, naming the input and carrying validateJsonSchemaSubset's own detail (B-28)", async () => {
    writeTask("ticketed", TICKETED_TASK_YAML);
    // `scope` is declared `enum: [changed, all]`; "bogus" satisfies neither.
    // `--ticket` is supplied so this fails on the VALUE, not the separate
    // missing-required path the next test covers.
    //
    // Derive the expected detail fragment from the REAL, already-implemented
    // validateJsonSchemaSubset (src/core/json-schema.ts) rather than guessing
    // wording the task input contract has not been written yet to produce —
    // mirrors tests/tasks/source-v4.test.ts's established derivation
    // convention. The declaration's `default`/root `required` are stripped
    // before validation (D2-N3), so the schema handed to the validator here
    // omits both, matching what `validateInputs` will actually check against.
    // `redactValues: true` mirrors `validateInputs`'s own call (credential
    // safety: typed-input flags can carry credentials, so the CLI's actual
    // envelope never echoes the supplied "bogus" value — this oracle must not
    // either, or the `toContain` check below could never pass).
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
    // Test-review fix: `detailSuffix` comes straight from `validateJsonSchemaSubset`
    // (never JSON-encoded) and legitimately embeds literal `"` characters
    // (`is not one of ["changed","all"]`) — `JSON.stringify(envelope)` would
    // re-escape those to `\"`, so a substring check against the STRINGIFIED
    // envelope can never match the RAW detail text. Checking the already
    // `JSON.parse`d string fields directly (still real, unescaped strings)
    // is the byte-accurate comparison; §5.1/B-27's "check the whole envelope,
    // not just .error" intent is preserved by joining every textual field
    // the diagnostics vocabulary might use, mirroring the B-27 test's own
    // "not required to put the enumeration in one specific field" rationale.
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
    // B-29 (spec §2): "detail names the missing input" — the missing input's
    // own name must appear somewhere in the rendered envelope.
    expect(JSON.stringify(envelope)).toContain("ticket");
  });
});

// ── B-31 end to end, through the REAL `akm task run` CLI path and the REAL ──
// ── TASK_INPUT_DIAGNOSTICS vocabulary — not the sentinel UsageErrors the ────
// ── probe-based unit tests in tests/execution/input-contract.test.ts ────────
// ── construct themselves. Test-review remediation (finding recorded against ─
// ── tests/execution/input-contract.test.ts:455): B-31's task-side code and ──
// ── message were unpinned — the only assertions were an err.code check ──────
// ── against a `new UsageError("PROBE:duplicateNonArray", ──────────────────
// ── "INPUT_BINDING_INVALID")` that file authored itself, which proves ───────
// ── nothing about src/tasks/source/task-input-diagnostics.ts. These three ───
// ── tests drive real argv through `akm task run`, asserting on the REAL, ────
// ── serialized {ok:false,error,code} envelope (or, for the success case, ────
// ── the real run result) — mirroring the B-27/B-28/B-29 tests just above. ───

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

// ── B-26 / §0 — a valid input flag set is byte-identical; a manual-only v4 ──
// ── task runs end-to-end. Test-review remediation (finding recorded against ──
// ── docs/plans/specs/p2a-task-source-v4.md:520): §0's central observable ────
// ── contract had no end-to-end pin at all — the one v4 run test stopped at ──
// ── loadPreparedTask, never reaching `akm task run` itself. ─────────────────

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

// ── B-32 / B-33 — retired --target and akm task run's own declared flags ────
// ── are PRESERVED, never treated as inputs. Test-review remediation (finding ──
// ── recorded against docs/plans/specs/p2a-task-source-v4.md:526): neither ───
// ── B-32 nor B-33 nor F-5's isTaskRunWithId test existed anywhere. ──────────

describe("akm task run <id> --target x — the retired-flag usage error is unchanged (B-32, PRESERVE)", () => {
  test("still rejects with the retired-flag INVALID_FLAG_VALUE usage error, exit 2 — --target is NEVER treated as an input", async () => {
    // rejectRetiredTaskTargetFlag() (src/commands/tasks/tasks-cli.ts) runs
    // BEFORE any task lookup, so the id need not exist for this to fire —
    // this is ALREADY-REAL, ALREADY-GREEN production behavior today; grep for
    // "was renamed to `--bundle`" in tests/ returns nothing anywhere in the
    // repo before this test.
    const result = await runCliCapture(["task", "run", "anything", "--target", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; error: string; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("INVALID_FLAG_VALUE");
    expect(envelope.error).toBe("`akm task --target` was renamed to `--bundle` in 0.9. Use `--bundle <name>` instead.");
  });

  // Review round 1: the rejecter tested `hasFlag("--target")`, which compares
  // WHOLE tokens against `--target` and `--target=true` only — so the inline
  // `=` spellings slipped past it. Nothing else caught them either: the
  // generic pre-dispatch gate exempts `target` on every `task` subcommand by
  // NAME (`src/cli/unknown-flags.ts`'s `SELF_DIAGNOSED_FLAGS`) precisely so
  // this handler can answer with the rename hint, so an unrejected
  // `--target=team` was absorbed silently by citty's non-strict parser and the
  // user's chosen bundle was quietly ignored.
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

  // Review round 2, the other half of that widening: rejecting `--target` by
  // NAME also swallowed `--target=<value>`, which was the last working way to
  // supply a legally-declared task input NAMED `target` — `target` sits in
  // neither TASK_RUN_VALUE_FLAGS nor TASK_RUN_BOOLEAN_FLAGS, so
  // parseTaskInputFlags captured it as an ordinary input flag, and the bare
  // `--target x` spelling was already rejected at whole-token level before
  // round 1. The fix is NOT to narrow the rejecter back (that reopens the
  // silently-ignored `--target=team` above): `target` is reserved at
  // DECLARATION time instead (TASK_RUN_SELF_DIAGNOSED_FLAGS,
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
  // false, so the new pin above cannot be satisfied by an always-true stub.
  test("a non-task-run invocation still classifies false", () => {
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "history"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "workflow", "run", "workflows/x"])).toBe(false);
  });
});
