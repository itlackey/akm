// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2b Lane B — `akm task explain <ref> [input flags]` (spec
 * docs/plans/specs/p2b-input-bindings.md §4.5, §1.7 B-N4, rows B-52..B-59).
 *
 * A NEW, read-only verb: it never prepares an execution that spawns
 * anything, never writes history, never touches the scheduler. It prints
 * (text + `--format json`): the task source path and owning bundle, input
 * declarations with defaults, supplied values WITH PROVENANCE (`default` |
 * `flag` | `schedule-binding`), the resolved target kind + ref, effective
 * execution settings with field-level provenance, and schedule bindings. It
 * never prints a resolved `env:` value, a prompt body, or a `run:`/script
 * body — those are structural bans, true regardless of shape. A
 * secret-shaped INPUT value (a declaration's `default`, an `enum` entry, a
 * `suppliedInputs` entry, or a `schedule[].inputs` entry) is redacted only
 * on a BEST-EFFORT heuristic basis (`detectSecretShapedParams`,
 * `src/workflows/exec/param-secrets.ts`) — not a guarantee. See the
 * "secret-shaped VALUE redaction" describe block below for the coverage
 * that actually exercises that path.
 *
 * RED TODAY: `akm task explain` does not exist as a subcommand at all —
 * `taskCommand.subCommands` (`src/commands/tasks/tasks-cli.ts`) has no
 * `explain` key, so every invocation below fails with citty's own
 * unknown-subcommand error instead of the behavior pinned here.
 *
 * No `@ts-expect-error` type-suppression pins: every scenario is driven
 * through the REAL `akm` CLI (`runCliCapture`) with plain string argv — no
 * not-yet-existing TypeScript export is referenced directly. The one
 * existing, ALREADY-STABLE export this file touches (`isTaskRunWithId`,
 * `src/cli.ts`) is unaffected by P2b and is asserted as a preservation
 * canary (B-59), not a red assertion.
 *
 * Because the exact rendering layout is Implement's call (the spec pins the
 * CONTENT contract, not a literal template), this file's assertions are
 * deliberately CONTENT-presence checks — the same style
 * tests/integration/commands/tasks-input-flags.test.ts already uses for an
 * under-specified message shape ("check the whole serialized envelope, not
 * one specific field") — rather than a pin on exact text layout.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isTaskRunWithId } from "../../src/cli";
import { resetConfigCache } from "../../src/core/config/config";
import { runCliCapture } from "../_helpers/cli";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeWorkflowTestConfig } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let tasksDir: string;

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  writeWorkflowTestConfig();
  resetConfigCache();
  tasksDir = path.join(storage.stashDir, "tasks");
  fs.mkdirSync(tasksDir, { recursive: true });
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

function writeTask(id: string, yaml: string): void {
  fs.writeFileSync(path.join(tasksDir, `${id}.yml`), yaml, "utf8");
}

const ENV_SECRET_SENTINEL = "SENTINEL-ENV-VALUE-8f3c1a9d";
const PROMPT_BODY_SENTINEL = "RUN-SENTINEL-prose-1a2b3c4d";
const SCHEDULE_CRON = "0 9 * * 1";

/** A v4 task declaring inputs, a secret-shaped env binding, a command target, and one schedule binding with its own inputs. */
const EXPLAIN_DEMO_YAML = [
  "version: 4",
  "name: Explain demo",
  "description: A demo task for akm task explain.",
  "inputs:",
  "  scope:",
  "    type: string",
  "    default: changed",
  "  strict:",
  "    type: boolean",
  "    default: true",
  "  ticket:",
  "    type: string",
  "env:",
  `  API_KEY: "${ENV_SECRET_SENTINEL}"`,
  "uses: commands/explain-note",
  "schedule:",
  `  - cron: "${SCHEDULE_CRON}"`,
  "    inputs:",
  "      scope: all",
  "",
].join("\n");

function writeExplainDemoFixture(): void {
  write("commands/explain-note.md", `Echo the ${PROMPT_BODY_SENTINEL} note.\n`);
  writeTask("explain-demo", EXPLAIN_DEMO_YAML);
}

/**
 * Structurally locate a field whose KEY matches `keyPattern` and whose value
 * is the exact string `expected`, anywhere in the JSON envelope — tolerant of
 * whichever concrete field name Implement picks (e.g. "bundle", "bundleName",
 * "owningBundle"), but still a TARGETED proof rather than a whole-envelope
 * substring probe. A whole-envelope probe for the bundle name "stash" would
 * also match unrelated appearances of that exact text — the source PATH
 * itself contains "/stash/" as a directory segment (P2b test-review finding
 * #3) — so this only counts a node that carries the value under a
 * bundle-shaped KEY.
 */
function hasNamedField(json: unknown, keyPattern: RegExp, expected: string): boolean {
  function visit(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(visit);
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (keyPattern.test(key) && value === expected) return true;
    }
    return Object.values(obj).some(visit);
  }
  return visit(json);
}

/** As {@link hasNamedField}, but the value is the NUMBER `expected` — or its exact string spelling, since "the exact rendering layout is Implement's call" (this file's own header comment). */
function hasNamedVersionField(json: unknown, keyPattern: RegExp, expected: number): boolean {
  function visit(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(visit);
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (keyPattern.test(key) && (value === expected || value === String(expected))) return true;
    }
    return Object.values(obj).some(visit);
  }
  return visit(json);
}

/**
 * Locate at least one FIELD-LEVEL EXECUTION PROVENANCE object anywhere in the
 * envelope — the exact `{layer, kind, via}` shape
 * `resolveExecution`'s `provenance` actually returns
 * (`src/integrations/agent/execution.ts`) —
 * structurally, not merely because the resolved engine NAME ("test-agent")
 * appears somewhere in the envelope (P2b test-review finding #3: a whole-
 * envelope substring probe for the engine name alone is satisfiable by an
 * envelope that prints the RESOLVED value with no provenance tracking at
 * all). Finding this shape is the direct, structural proof that `akm task
 * explain` REUSES resolveExecution's own provenance rather than writing
 * a second resolver (spec B-N4).
 */
function hasExecutionFieldProvenance(json: unknown): boolean {
  function visit(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(visit);
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.layer === "string" &&
      obj.layer.length > 0 &&
      typeof obj.kind === "string" &&
      obj.kind.length > 0 &&
      typeof obj.via === "string" &&
      obj.via.length > 0
    ) {
      return true;
    }
    return Object.values(obj).some(visit);
  }
  return visit(json);
}

describe("akm task explain <ref> — text output (B-52)", () => {
  test("prints declarations+defaults, target kind+ref, effective execution settings, and schedule bindings", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo"]);

    expect(result.code).toBe(0);
    const text = result.stdout;

    // Declarations + defaults.
    expect(text).toContain("scope");
    expect(text).toContain("changed");
    expect(text).toContain("strict");
    expect(text).toContain("ticket");

    // Task source path (absolute) and owning bundle (P2b test-review finding
    // #3: neither was pinned before). The path itself is not a secret
    // (B-N4's own field table lists it explicitly), and "stash" is the
    // owning-bundle name this exact sandbox resolves to whether Implement
    // reuses akm task run's own DEFAULT_BUNDLE_NAME fallback
    // (src/tasks/run/load-task.ts) or the working-stash write-target path
    // (src/core/write-source.ts's deriveBundleId, which slugifies stashDir's
    // OWN basename — withIsolatedAkmStorage's stash dir is literally named
    // "stash") — the two independent resolution paths agree here.
    expect(text).toContain(path.join(tasksDir, "explain-demo.yml"));
    expect(text).toContain("stash");

    // Task source version: the fixture is version: 4.
    expect(text).toMatch(/version[^0-9]{0,15}4\b/i);

    // Resolved target kind + ref.
    expect(text).toMatch(/command/i);
    expect(text).toContain("explain-note");

    // Effective execution settings: the config default engine resolves and
    // surfaces even though the task itself declares no engine:.
    expect(text).toContain("test-agent");

    // Schedule bindings: cron, and the binding's own inputs.
    expect(text).toContain(SCHEDULE_CRON);
    expect(text).toContain("all");
  });
});

/**
 * Locate a DECLARATION row for `inputName` — an object holding it under a
 * key equal to the input name (or a `name`/`input`/`key` self-identifying
 * field, mirroring {@link suppliedValueProvenances}'s two shapes) whose own
 * `required` field is `true`. Declaration rows carry no `provenance` key
 * (that is what makes them structurally distinct from a `suppliedInputs`
 * row, per this file's own `suppliedValueProvenances` comment), so this
 * helper intentionally does NOT require one.
 */
function hasRequiredDeclarationRow(json: unknown, inputName: string): boolean {
  function visit(node: unknown): boolean {
    if (Array.isArray(node)) return node.some(visit);
    if (node === null || typeof node !== "object") return false;
    const obj = node as Record<string, unknown>;

    const nameField = obj.name ?? obj.input ?? obj.key;
    if (typeof nameField === "string" && nameField === inputName && obj.required === true) return true;

    if (Object.hasOwn(obj, inputName)) {
      const entry = obj[inputName];
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        const entryObj = entry as Record<string, unknown>;
        if (entryObj.required === true) return true;
      }
    }
    return Object.values(obj).some(visit);
  }
  return visit(json);
}

/**
 * Locate the DECLARATION row for `inputName` (shape (a) or (b), mirroring
 * {@link hasRequiredDeclarationRow}) and return it WHOLE, so a test can read
 * its `enum`/`default`/`redacted` fields directly rather than only checking
 * for presence.
 */
function findDeclarationRow(json: unknown, inputName: string): Record<string, unknown> | undefined {
  function visit(node: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== "object") return undefined;
    const obj = node as Record<string, unknown>;

    const nameField = obj.name ?? obj.input ?? obj.key;
    if (typeof nameField === "string" && nameField === inputName && Object.hasOwn(obj, "required")) return obj;

    if (Object.hasOwn(obj, inputName)) {
      const entry = obj[inputName];
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry as object, "required")
      ) {
        return entry as Record<string, unknown>;
      }
    }
    for (const value of Object.values(obj)) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  }
  return visit(json);
}

/**
 * Locate a SUPPLIED-VALUE (or schedule-binding) row for `inputName` whose
 * `provenance` equals `provenance` (shape (a) or (b), mirroring
 * {@link suppliedValueProvenances}), and return it WHOLE so a test can read
 * its `value`/`redacted` fields directly.
 */
function findSuppliedInputRow(
  json: unknown,
  inputName: string,
  provenance: string,
): Record<string, unknown> | undefined {
  function visit(node: unknown): Record<string, unknown> | undefined {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (node === null || typeof node !== "object") return undefined;
    const obj = node as Record<string, unknown>;

    const nameField = obj.name ?? obj.input ?? obj.key;
    if (typeof nameField === "string" && nameField === inputName && obj.provenance === provenance) return obj;

    if (Object.hasOwn(obj, inputName)) {
      const entry = obj[inputName];
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).provenance === provenance
      ) {
        return entry as Record<string, unknown>;
      }
    }
    for (const value of Object.values(obj)) {
      const found = visit(value);
      if (found) return found;
    }
    return undefined;
  }
  return visit(json);
}

describe("akm task explain <ref> — a required input with no default, left unsupplied (B-52)", () => {
  test("prints the declaration instead of refusing to explain — the exact case the verb exists to explain", async () => {
    writeTask(
      "explain-required",
      [
        "version: 4",
        "name: Explain required demo",
        "inputs:",
        "  assignee:",
        "    type: string",
        "    required: true",
        "run: echo required-demo",
        "shell: sh",
        "",
      ].join("\n"),
    );

    const text = await runCliCapture(["task", "explain", "explain-required"]);
    expect(text.code).toBe(0);
    expect(text.stdout.length).toBeGreaterThan(0);
    expect(text.stdout).toContain("assignee");

    const json = await runCliCapture(["task", "explain", "explain-required", "--format", "json"]);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.stdout);

    // The declaration row is present and marked required, structurally —
    // not merely because the word "assignee" appears somewhere.
    expect(hasRequiredDeclarationRow(envelope, "assignee")).toBe(true);

    // No suppliedInputs entry / provenance row exists for the unsupplied
    // required input: it has neither a default nor a flag-supplied value.
    expect(suppliedValueProvenances(envelope, "assignee")).toEqual([]);
  });
});

describe("akm task explain <ref> --format json (B-53)", () => {
  test("prints one JSON object on stdout carrying the same fields", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(envelope).toBeInstanceOf(Object);
    expect(Array.isArray(envelope)).toBe(false);

    const rendered = JSON.stringify(envelope);
    expect(rendered).toContain("scope");
    expect(rendered).toContain("changed");
    expect(rendered).toContain(SCHEDULE_CRON);
    expect(rendered).toContain("explain-note");

    // (P2b test-review finding #3) B-N4's field table lists eight facts;
    // these four were unpinned by every existing assertion in this
    // describe: the absolute source path and owning bundle name, the source
    // version, and at least one FIELD-LEVEL execution-provenance object
    // proving `explain` reuses resolveExecution's own provenance rather
    // than writing a second resolver.
    expect(rendered).toContain(path.join(tasksDir, "explain-demo.yml"));
    expect(hasNamedField(envelope, /bundle/i, "stash")).toBe(true);
    expect(hasNamedVersionField(envelope, /version/i, 4)).toBe(true);
    expect(hasExecutionFieldProvenance(envelope)).toBe(true);
  });

  test("stable key order: two consecutive explain calls on the identical task produce byte-identical JSON", async () => {
    writeExplainDemoFixture();
    const first = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);
    const second = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe(first.stdout);
  });
});

/**
 * Locate every "provenance" tag attached to a supplied-value row for
 * `inputName`, recursively, tolerant of whichever concrete JSON SHAPE
 * Implement picks for the envelope — the spec pins the CONTENT contract
 * (B-N4), never a literal layout (this file's own header comment). Two
 * shapes are considered, since either is a reasonable reading of "one row
 * per declared input" (§4.5 B-N4):
 *
 *   (a) an array of `{name: "scope", provenance: "default", ...}` rows;
 *   (b) a map keyed BY input name: `{scope: {provenance: "default", ...}}`.
 *
 * A candidate must carry an OWN `provenance` key to count — this is what
 * makes the search STRUCTURAL rather than a whole-envelope substring probe
 * (P2b test-review finding #7): the input DECLARATION section also has a
 * node named "scope" (with its OWN `default` key, per B-N4's field list),
 * but that node has no `provenance` key, so it is never matched here.
 */
function suppliedValueProvenances(json: unknown, inputName: string): unknown[] {
  const found: unknown[] = [];
  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;

    // Shape (a): this object IS the row — it names itself and carries its
    // own provenance.
    const nameField = obj.name ?? obj.input ?? obj.key;
    if (typeof nameField === "string" && nameField === inputName && Object.hasOwn(obj, "provenance")) {
      found.push(obj.provenance);
    }
    // Shape (b): this object HOLDS the row under a key equal to the input
    // name.
    if (Object.hasOwn(obj, inputName)) {
      const entry = obj[inputName];
      if (
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry as object, "provenance")
      ) {
        found.push((entry as Record<string, unknown>).provenance);
      }
    }
    for (const value of Object.values(obj)) visit(value);
  }
  visit(json);
  return found;
}

describe("akm task explain <ref> --<flag> — supplied-value provenance (B-54)", () => {
  test("an unflagged input's supplied value is attributed to its DEFAULT, structurally — not merely because the word 'default' appears anywhere in the envelope", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    // Not `rendered).toMatch(/default/i)` against the whole serialized
    // envelope — the input DECLARATION for "scope" carries its OWN
    // `default: "changed"` key regardless of provenance tracking, so that
    // whole-envelope probe is satisfiable by an envelope with NO provenance
    // at all (P2b test-review finding #7). Locate the SUPPLIED-VALUE row
    // instead and read its provenance field directly.
    expect(suppliedValueProvenances(envelope, "scope")).toContain("default");
  });

  test("--scope urgent overrides the default: the supplied value is attributed to FLAG provenance, structurally — and is no longer attributed to default", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--scope", "urgent", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    const provenances = suppliedValueProvenances(envelope, "scope");
    expect(provenances).toContain("flag");
    // Negates a broken implementation that always labels the CURRENT
    // supplied-value row "default" regardless of where the value actually
    // came from.
    expect(provenances).not.toContain("default");
  });

  test("the schedule binding's own inputs are attributed to SCHEDULE-BINDING provenance — coexisting with, and distinct from, the CURRENT row's default/flag provenance for the identical input name", async () => {
    writeExplainDemoFixture();
    const unflagged = JSON.parse((await runCliCapture(["task", "explain", "explain-demo", "--format", "json"])).stdout);
    const flagged = JSON.parse(
      (await runCliCapture(["task", "explain", "explain-demo", "--scope", "urgent", "--format", "json"])).stdout,
    );

    // The fixture's ONE schedule entry supplies `scope: all` (line 96)
    // alongside the task's OWN `scope` declaration — an unflagged explain
    // call therefore carries TWO rows for the same input name "scope": the
    // CURRENT value (provenance "default") and the schedule entry's OWN
    // value (provenance "schedule-binding"). Finding BOTH tags attached to
    // the SAME input name in the SAME envelope is the direct, structural
    // proof that they are tracked as genuinely distinct provenance values,
    // not a single global tag for the whole explain call.
    const unflaggedScopeProvenances = suppliedValueProvenances(unflagged, "scope");
    expect(unflaggedScopeProvenances).toContain("schedule-binding");
    expect(unflaggedScopeProvenances).toContain("default");

    // The schedule entry's own provenance is unaffected by an unrelated
    // CLI flag on the CURRENT row — it is still "schedule-binding", never
    // reclassified to "flag", when --scope is supplied for this call.
    expect(suppliedValueProvenances(flagged, "scope")).toContain("schedule-binding");

    // All three vocabulary values the spec names (B-N4: "default | flag |
    // schedule-binding") are pairwise distinct, observed together across
    // the unflagged + flagged calls above.
    const observed = new Set([
      ...unflaggedScopeProvenances.filter((p) => p === "default" || p === "schedule-binding"),
      ...suppliedValueProvenances(flagged, "scope").filter((p) => p === "flag"),
    ]);
    expect(observed).toEqual(new Set(["default", "schedule-binding", "flag"]));
  });
});

describe("akm task explain <ref> --<undeclared> — UNKNOWN_FLAG (B-55)", () => {
  test("an undeclared flag fails UNKNOWN_FLAG, exit 2, {ok:false,error,code} on stderr", async () => {
    writeExplainDemoFixture();
    const result = await runCliCapture(["task", "explain", "explain-demo", "--not-a-declared-input", "x"]);

    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("UNKNOWN_FLAG");
    expect(result.stderr).toContain("not-a-declared-input");
  });
});

// Regression (finding F7): `--scheduled` is `akm task run`'s own reserved
// boolean flag (`../../../src/tasks/task-run-reserved-flags.ts`), so the
// exact-name scanner `task explain` shares with `task run`
// (`parseTaskInputFlags`) silently skipped it instead of ever surfacing it as
// an input flag — and the generic pre-dispatch flag gate exempts `task
// explain`'s whole dynamic namespace (`../../../src/cli/unknown-flags.ts`'s
// `dynamicNamedFlagCommands`), so nothing else caught it either. `akm task
// explain <ref> --scheduled` silently accepted and discarded the flag rather
// than rejecting it, even though `scheduled` can never be a declared input
// name (same reserved-name module) — so `--scheduled` can never be anything
// but a mistake on `explain`. Same B-55 diagnostic shape: UNKNOWN_FLAG,
// exit 2, `{ok:false,error,code}` on stderr.
//
// The table below covers every spelling of the SAME flag NAME, not just the
// bare token (review round 1): the first fix rejected only the two literal
// tokens `--scheduled` and `--scheduled=true`, so `--scheduled=false` and
// `--scheduled=1` still slipped through to the shared scanner — which splits
// on `=` before its reserved-name check and therefore swallowed them exactly
// as before. Rejection is now keyed on the name before the first `=`, the
// same split `parseTaskInputFlags` itself performs.
describe("akm task explain <ref> --scheduled — UNKNOWN_FLAG (F7)", () => {
  for (const token of ["--scheduled", "--scheduled=true", "--scheduled=false", "--scheduled=1"]) {
    test(`\`${token}\` (task run's own reserved flag) fails UNKNOWN_FLAG on explain instead of being silently discarded`, async () => {
      writeExplainDemoFixture();
      const result = await runCliCapture(["task", "explain", "explain-demo", token]);

      expect(result.code, token).toBe(2);
      const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean; code: string };
      expect(envelope.ok, token).toBe(false);
      expect(envelope.code, token).toBe("UNKNOWN_FLAG");
      expect(result.stderr, token).toContain("scheduled");
    });
  }
});

describe("akm task explain <ref> — structural bans (B-56, B-N4): env:/prompt/run: bodies never reach this module", () => {
  test("never prints a resolved env: value, a prompt body, or a run:/script sentinel — in EITHER output format", async () => {
    writeExplainDemoFixture();
    const text = await runCliCapture(["task", "explain", "explain-demo"]);
    const json = await runCliCapture(["task", "explain", "explain-demo", "--format", "json"]);

    expect(text.code).toBe(0);
    expect(json.code).toBe(0);

    for (const output of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      expect(output).not.toContain(ENV_SECRET_SENTINEL);
      expect(output).not.toContain(PROMPT_BODY_SENTINEL);
    }
  });

  test("a shell task's run: command text never appears — only its target kind/ref", async () => {
    const RUN_SENTINEL = "RUN-COMMAND-TEXT-SENTINEL-9e7d";
    writeTask(
      "explain-shell",
      ["version: 4", "name: Explain shell", `run: echo ${RUN_SENTINEL}`, "shell: sh", ""].join("\n"),
    );
    const result = await runCliCapture(["task", "explain", "explain-shell", "--format", "json"]);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain(RUN_SENTINEL);
    expect(result.stdout).toMatch(/shell/i);
  });
});

// Finding 1 (code review): a secret-shaped value survived unredacted when it
// appeared in an input declaration's JSON-Schema `enum:` list, even though
// the IDENTICAL value was already redacted under that same declaration's
// `default:`, in `suppliedInputs`, and in `schedule[].inputs`. Finding 3: no
// test in this file exercised ANY of those redaction paths at all — this
// describe block is that missing coverage, for every place a declared or
// supplied VALUE can appear. Each secret-shaped sentinel below is chosen to
// trip `detectSecretShapedParams`'s VALUE-shape heuristic on its own (the
// `sk-` prefix, `src/workflows/exec/param-secrets.ts`'s
// `SECRET_VALUE_PREFIX`) — deliberately under an input NAME
// (`scope`/`note`) that does not itself match the heuristic's KEY-name hint
// list, so a passing test proves value-shape detection specifically, not
// merely name-based detection. `apiKey` is the inverse case: a plainly
// non-secret VALUE under a secret-suggesting NAME, proving the existing
// (previously untested) `default:` redaction still fires on name alone.
const ENUM_SECRET_SENTINEL = "sk-EnumSecretSentinelValue1234567890";
const SUPPLIED_SECRET_SENTINEL = "sk-SuppliedSecretSentinelValue1234567890";
const SCHEDULE_SECRET_SENTINEL = "sk-ScheduleSecretSentinelValue1234567890";
// `scope`'s default must itself satisfy its own `enum:` (task source v4
// validates a declaration's default against its own schema), so the
// non-secret control value here is the enum's own plain member "public"
// rather than an arbitrary string.
const PLAIN_SCOPE_DEFAULT = "public";
const PLAIN_NOTE_DEFAULT = "plain-note-default";
const PLAIN_APIKEY_DEFAULT = "plain-apikey-default-value";

function writeExplainSecretsFixture(): void {
  writeTask(
    "explain-secrets",
    [
      "version: 4",
      "name: Explain secrets demo",
      "description: A demo task for secret-shaped VALUE redaction (Finding 1).",
      "inputs:",
      "  scope:",
      "    type: string",
      "    enum:",
      "      - public",
      `      - "${ENUM_SECRET_SENTINEL}"`,
      `    default: ${PLAIN_SCOPE_DEFAULT}`,
      "  note:",
      "    type: string",
      `    default: ${PLAIN_NOTE_DEFAULT}`,
      "  apiKey:",
      "    type: string",
      `    default: ${PLAIN_APIKEY_DEFAULT}`,
      "run: echo ok",
      "shell: sh",
      "schedule:",
      `  - cron: "${SCHEDULE_CRON}"`,
      "    inputs:",
      // `scope` carries an `enum:` constraint, so a schedule literal for it
      // must itself be one of the two declared enum values — bind the
      // schedule's own secret-shaped literal to `note` instead (no `enum:`
      // constraint) so this fixture can use a THIRD, independent sentinel.
      `      note: "${SCHEDULE_SECRET_SENTINEL}"`,
      "",
    ].join("\n"),
  );
}

describe("akm task explain <ref> — secret-shaped VALUE redaction (Finding 1: enum was NOT covered; Finding 3: this coverage did not exist)", () => {
  test("a secret-shaped enum ENTRY is redacted per-value — the sibling non-secret entry and the declaration's own default stay visible", async () => {
    writeExplainSecretsFixture();
    const result = await runCliCapture(["task", "explain", "explain-secrets", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);

    const row = findDeclarationRow(envelope, "scope");
    expect(row).toBeDefined();
    expect(row?.enum).toEqual(["public", "<redacted>"]);
    expect(row?.redacted).toBe(true);
    // The declaration's OWN default is a DIFFERENT, non-secret-shaped value
    // under a non-secret-shaped name — proof this is a per-VALUE check, not
    // a check that blanks the whole declaration once ANY field on it looks
    // secret-shaped.
    expect(row?.default).toBe(PLAIN_SCOPE_DEFAULT);

    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(ENUM_SECRET_SENTINEL);
    }
  });

  test("a plainly non-secret enum entry and default are NOT redacted (over-redaction guard)", async () => {
    writeExplainSecretsFixture();
    const result = await runCliCapture(["task", "explain", "explain-secrets", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    const row = findDeclarationRow(envelope, "scope");
    expect(row?.enum).toContain("public");
    expect(row?.default).toBe(PLAIN_SCOPE_DEFAULT);

    const noteRow = findDeclarationRow(envelope, "note");
    expect(noteRow?.default).toBe(PLAIN_NOTE_DEFAULT);
    expect(noteRow?.redacted).toBeUndefined();
  });

  test("a secret-SUGGESTING input NAME redacts its default even when the value itself doesn't look secret-shaped", async () => {
    writeExplainSecretsFixture();
    const result = await runCliCapture(["task", "explain", "explain-secrets", "--format", "json"]);
    const envelope = JSON.parse(result.stdout);

    const row = findDeclarationRow(envelope, "apiKey");
    expect(row?.default).toBe("<redacted>");
    expect(row?.redacted).toBe(true);
    expect(result.stdout).not.toContain(PLAIN_APIKEY_DEFAULT);
  });

  test("a secret-shaped SUPPLIED (flag) value is redacted in suppliedInputs; the unflagged default is not", async () => {
    writeExplainSecretsFixture();

    const defaulted = await runCliCapture(["task", "explain", "explain-secrets", "--format", "json"]);
    expect(defaulted.code).toBe(0);
    const defaultedEnvelope = JSON.parse(defaulted.stdout);
    const defaultRow = findSuppliedInputRow(defaultedEnvelope, "note", "default");
    expect(defaultRow?.value).toBe(PLAIN_NOTE_DEFAULT);
    expect(defaultRow?.redacted).toBeUndefined();

    const flagged = await runCliCapture([
      "task",
      "explain",
      "explain-secrets",
      "--note",
      SUPPLIED_SECRET_SENTINEL,
      "--format",
      "json",
    ]);
    expect(flagged.code).toBe(0);
    const flaggedEnvelope = JSON.parse(flagged.stdout);
    const flagRow = findSuppliedInputRow(flaggedEnvelope, "note", "flag");
    expect(flagRow?.value).toBe("<redacted>");
    expect(flagRow?.redacted).toBe(true);

    for (const output of [flagged.stdout, flagged.stderr]) {
      expect(output).not.toContain(SUPPLIED_SECRET_SENTINEL);
    }
  });

  test("a secret-shaped schedule[].inputs literal is redacted", async () => {
    writeExplainSecretsFixture();
    const result = await runCliCapture(["task", "explain", "explain-secrets", "--format", "json"]);
    expect(result.code).toBe(0);
    const envelope = JSON.parse(result.stdout);

    const row = findSuppliedInputRow(envelope, "note", "schedule-binding");
    expect(row?.value).toBe("<redacted>");
    expect(row?.redacted).toBe(true);

    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(SCHEDULE_SECRET_SENTINEL);
    }
  });

  test("text output (no --format) never leaks any of the secret-shaped sentinels either", async () => {
    writeExplainSecretsFixture();
    const result = await runCliCapture(["task", "explain", "explain-secrets", "--note", SUPPLIED_SECRET_SENTINEL]);
    expect(result.code).toBe(0);

    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain(ENUM_SECRET_SENTINEL);
      expect(output).not.toContain(SUPPLIED_SECRET_SENTINEL);
      expect(output).not.toContain(SCHEDULE_SECRET_SENTINEL);
    }
  });
});

// P4 (docs/plans/specs/p4-deletions-closeout.md §3.2, row B-57) DELETES this
// describe block, not flips it: task source v3 acceptance is retired from
// `src` entirely, so "akm task explain resolves a genuine legacy-schema
// (version:3) task" is no longer a claim any fixture can demonstrate — there
// is no second version left to structurally distinguish the row-310 v4
// case's `hasNamedVersionField(..., 4)` check against. B-57's underlying
// claim (declared inputs/target/execution settings resolve for whatever
// version a task actually is) stays covered by this file's v4 fixtures.

describe("akm task explain — no ref / an unknown ref (B-58)", () => {
  test("no ref at all: usage error, exit 2", async () => {
    const result = await runCliCapture(["task", "explain"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });

  test("an unknown ref: not-found error, exit 1", async () => {
    const result = await runCliCapture(["task", "explain", "does-not-exist"]);
    expect(result.code).toBe(1);
    const envelope = JSON.parse(result.stderr.trim()) as { ok: boolean };
    expect(envelope.ok).toBe(false);
  });
});

describe("isTaskRunWithId — akm task explain never classifies as a task run (B-59, PRESERVE)", () => {
  test("`akm task explain <ref>` classifies false; `akm task run <ref>` is unaffected and still classifies true", () => {
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "explain", "explain-demo"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "explain", "explain-demo", "--scope", "all"])).toBe(false);
    expect(isTaskRunWithId(["bun", "cli.ts", "task", "run", "explain-demo"])).toBe(true);
  });
});
