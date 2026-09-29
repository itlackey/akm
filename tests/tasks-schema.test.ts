// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Schema-drift gate for `schemas/akm-task.json`.
 *
 * P2a (spec docs/plans/specs/p2a-task-source-v4.md §5.3, §6 F-1) turned the
 * published schema into a two-arm `oneOf` at the document root: "arm 1:
 * the v3 object"; "arm 2: the v4 object". P4
 * (docs/plans/specs/p4-deletions-closeout.md §3.2) retires task source v3
 * acceptance from `src` entirely, and the published schema's v3 arm goes
 * with it (per the commit-2 F-A1.12 flip's own forward note: "the v3 arm
 * itself is removed from the published schema in commit 3") — the schema
 * flattens back to a single document shape, task source v4's, at the
 * document root. `definitions` stays shared and mostly unchanged: it was
 * never split per-arm, so the v4-only definitions it already held (
 * `taskSourceV4ScheduleEntry`, `inputDeclaration`, …) need no rewiring.
 *
 * Every v3-only test this file used to carry — the strict v3 top-level
 * vocabulary, the `akm:`/`on:` closed shapes, the "exactly one scheduling
 * source" allOf, and the production-parser-agreement check that called the
 * now-migrator-only `parseTaskV3Yaml`/`classifyTaskV3Uses` — is DELETED, not
 * flipped: its subject (the v3 arm) no longer exists in the published
 * schema. The one test P0/F-1 marked "stays as-is" (the runtime-constraints
 * test) survives, re-tightened from "names both parsers" back to naming only
 * `task-source-v4.ts` now that only one parser is authoritative. Every
 * v4-focused test below is unchanged in intent, just re-rooted at the schema
 * document itself instead of `v4Arm(schema)` — there is only one arm left to
 * root at.
 *
 * Every v4 assertion is derived from task source v4's exported constants
 * (`TASK_SOURCE_V4_VERSION`, `TASK_SOURCE_V4_TOP_LEVEL_KEYS`,
 * `TASK_SOURCE_V4_SCHEDULE_KEYS`, `TASK_INPUT_DECLARATION_KEYS`) or from
 * existing shared bounds (`TASK_V3_MAX_SCHEDULES`) —
 * never restated as literals — per the task brief's binding instruction. The
 * `TASK_V3_MAX_*` bound constants keep that name (they are shared,
 * version-agnostic bounded-document primitives task source v4 itself still
 * imports, spec §3.2.3) even though the schema they bound no longer has a
 * v3 arm.
 */

import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { EXECUTION_MAX_TIMEOUT_MS } from "../src/execution/limits";
import {
  TASK_V3_MAX_COLLECTION_ITEMS,
  TASK_V3_MAX_REDACT_NAMES,
  TASK_V3_MAX_SCHEDULES,
  TASK_V3_MAX_STRING_BYTES,
} from "../src/tasks/source/bounded-document";
import {
  classifyTaskSourceV4Uses,
  parseTaskSourceV4,
  TASK_INPUT_DECLARATION_KEYS,
  TASK_SOURCE_V4_SCHEDULE_KEYS,
  TASK_SOURCE_V4_TOP_LEVEL_KEYS,
  TASK_SOURCE_V4_VERSION,
} from "../src/tasks/source/task-source-v4";
import { TASK_RUN_RESERVED_FLAG_NAMES } from "../src/tasks/task-run-reserved-flags";

const root = path.resolve(import.meta.dir, "..");

interface JsonSchema {
  [key: string]: unknown;
  properties: Record<string, JsonSchema>;
  definitions: Record<string, JsonSchema>;
  oneOf: unknown[];
}

function readTaskSchema(): JsonSchema {
  return JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8")) as JsonSchema;
}

test("published task schema pins the exact task source v4 top-level key set (D2-N7)", () => {
  const schema = readTaskSchema();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  expect(schema.properties.version?.const).toBe(TASK_SOURCE_V4_VERSION);
  expect(schema.required).toEqual(["version"]);
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual([...TASK_SOURCE_V4_TOP_LEVEL_KEYS].sort());
  expect(schema.oneOf).toHaveLength(3);
  expect(pkg.files).toContain("schemas");
  // D2-N7: the akm: bag and the on: trigger block are gone in v4 — the
  // published schema is single-arm now (P4 deleted the v3 arm), so this is
  // simply "not in the top-level property set" rather than "not in the v4
  // arm specifically."
  expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("akm");
  expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("on");
  expect(Object.keys(schema.properties)).not.toContain("akm");
  expect(Object.keys(schema.properties)).not.toContain("on");
});

test("every published pattern is valid ECMAScript and the executable-ref pattern agrees with the production classifier", () => {
  const schema = readTaskSchema();
  const patterns: string[] = [];
  const stack: unknown[] = [schema];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "pattern" && typeof child === "string") patterns.push(child);
      else stack.push(child);
    }
  }
  expect(patterns.length).toBeGreaterThan(0);
  for (const pattern of patterns) expect(() => new RegExp(pattern), pattern).not.toThrow();

  const executableRef = new RegExp(schema.definitions.akmExecutableRef?.pattern as string);
  expect(executableRef.test("commands/review")).toBe(true);
  expect(executableRef.test("team//workflows/release")).toBe(true);
  expect(executableRef.test("agents/reviewer")).toBe(false);
  expect(executableRef.test("commands/review//nested")).toBe(false);
  expect(executableRef.test("commands/review/")).toBe(false);
  expect(executableRef.test("commands/my command")).toBe(false);
  for (const candidate of ["commands/./review", "commands/../review", "commands/review\0"]) {
    expect(executableRef.test(candidate), candidate).toBe(false);
    expect(() => classifyTaskSourceV4Uses(candidate), candidate).toThrow();
  }
  // P4 (docs/plans/specs/p4-deletions-closeout.md §3.1.2, F-A1.11): the
  // githubActionRef definition and its probes are deleted along with the
  // locator grammar itself — every github-locator-shaped value is exactly as
  // rejected by the production classifier as any other unrecognized shape.
  for (const candidate of [
    "actions/checkout@v4",
    "owner/repo@@v1",
    "owner/.@v1",
    "owner/..@v1",
    "owner/repo/.@v1",
    "owner/repo/..@v1",
    "owner/repo@v1",
  ]) {
    expect(() => classifyTaskSourceV4Uses(candidate), candidate).toThrow();
  }

  const workingDirectory = new RegExp(schema.properties["working-directory"]?.pattern as string);
  expect(workingDirectory.test("scripts/release")).toBe(true);
  expect(workingDirectory.test("scripts/release/")).toBe(false);
  expect(workingDirectory.test("\\absolute-on-windows")).toBe(false);
});

test("published schema declares the authoritative runtime-only resource constraints", () => {
  const schema = readTaskSchema();
  const constraints = schema["x-akm-runtimeConstraints"] as Record<string, unknown>;
  // P4 re-tightens this from P2a's "names both parsers" (task source v3 was
  // still accepted then) back to naming only the one parser `src` accepts
  // today.
  expect(constraints.authoritativeParser).toBe("src/tasks/source/task-source-v4.ts");
  expect(constraints.maxSourceUtf8Bytes).toBe(1_048_576);
  expect(constraints.maxStringUtf8Bytes).toBe(TASK_V3_MAX_STRING_BYTES);
  expect(constraints.maxJsonDepth).toBe(64);
  expect(constraints.maxJsonNodes).toBe(10_000);
  expect(constraints.canonicalRefsRequireNfc).toBe(true);
  expect(constraints.workingDirectoryRequiresWorkspaceRoot).toBe(true);

  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const byteBounded = { version: TASK_SOURCE_V4_VERSION, name: "😀".repeat(70_000), run: "echo hi" };
  expect(validate(byteBounded), JSON.stringify(validate.errors)).toBe(true);

  const noncanonicalRef = { version: TASK_SOURCE_V4_VERSION, uses: "commands/café" };
  expect(validate(noncanonicalRef), JSON.stringify(validate.errors)).toBe(true);
  expect(() => classifyTaskSourceV4Uses("commands/café")).toThrow(/canonical|ref|uses/i);
});

test("published outputSchema grammar rejects keywords the runtime subset cannot enforce", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const validTask = {
    version: TASK_SOURCE_V4_VERSION,
    uses: "commands/review",
    output: {
      type: "object",
      properties: { result: { type: "string", minLength: 1 } },
      required: ["result"],
      additionalProperties: false,
    },
  };
  const unsupported = structuredClone(validTask);
  unsupported.output.properties.result = { type: "string", pattern: "^ok$" } as never;

  expect(validate(validTask), JSON.stringify(validate.errors)).toBe(true);
  expect(validate(unsupported), JSON.stringify(validate.errors)).toBe(false);
});

// ── the v4 arm's own tests — unchanged in intent, re-rooted at the schema ──
// ── document itself now that it is the only arm left (P4 §3.2) ─────────────

test("published task schema's root oneOf rejects an akm: or on: key — retired task-v3 vocabulary, D2-N7", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  // Sanity: the base document (no akm:/on:) is otherwise valid — proves the
  // two rejections below are specifically about akm:/on:, not some unrelated
  // shape mistake in this fixture.
  expect(validate(base), JSON.stringify(validate.errors)).toBe(true);
  expect(validate({ ...base, akm: { schedule: "@daily" } }), "akm: must fail — task-v3 vocabulary is retired").toBe(
    false,
  );
  expect(validate({ ...base, on: { workflow_dispatch: null } }), "on: must fail — task-v3 vocabulary is retired").toBe(
    false,
  );
});

// P4 (docs/plans/specs/p4-deletions-closeout.md §3.1.2/§3.2, F-A1.12): the
// githubActionRef definition and both $refs to it were deleted from the
// published schema in commit 2; the v3 arm's own rejection half this test
// used to pin here is gone in commit 3 along with the arm itself.
test("published task schema rejects a github-action uses: shape (B-13)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const githubRef = "actions/checkout@v4";

  expect(validate({ version: TASK_SOURCE_V4_VERSION, uses: githubRef }), "must reject a github-action uses:").toBe(
    false,
  );
  expect(
    validate({ version: TASK_SOURCE_V4_VERSION, uses: "commands/review" }),
    "must still accept a canonical uses: ref",
  ).toBe(true);
});

test("published task schema's schedule: bounds at TASK_V3_MAX_SCHEDULES and closes each entry to TASK_SOURCE_V4_SCHEDULE_KEYS (D2-N5)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };
  const entry = (i: number) => ({ cron: `${i % 60} * * * *` });

  const atBound = Array.from({ length: TASK_V3_MAX_SCHEDULES }, (_, i) => entry(i));
  const overBound = [...atBound, entry(TASK_V3_MAX_SCHEDULES)];
  expect(validate({ ...base, schedule: atBound }), `schedule: at exactly ${TASK_V3_MAX_SCHEDULES} entries`).toBe(true);
  expect(validate({ ...base, schedule: overBound }), `schedule: one entry over ${TASK_V3_MAX_SCHEDULES}`).toBe(false);

  // String shorthand (D2): one enabled binding, no inputs.
  expect(validate({ ...base, schedule: "0 8 * * 1" })).toBe(true);

  // Every TASK_SOURCE_V4_SCHEDULE_KEYS key is accepted on one entry...
  const fullEntry: Record<string, unknown> = { cron: "0 8 * * 1" };
  if (TASK_SOURCE_V4_SCHEDULE_KEYS.includes("inputs")) fullEntry.inputs = { scope: "all" };
  expect(Object.keys(fullEntry).sort()).toEqual([...TASK_SOURCE_V4_SCHEDULE_KEYS].sort());
  expect(validate({ ...base, schedule: [fullEntry] }), JSON.stringify(validate.errors)).toBe(true);

  // ...but a key outside that closed set is rejected.
  expect(validate({ ...base, schedule: [{ cron: "0 8 * * 1", bogusKey: true }] }), "an unlisted schedule key").toBe(
    false,
  );
});

test("published task schema's input declarations are closed to TASK_INPUT_DECLARATION_KEYS (D2-N3)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  // Sample values for every key TASK_INPUT_DECLARATION_KEYS lists (spec
  // §1.5 D2-N3), each offered one at a time alongside a bare `type: "string"`
  // base so a bad sample for one key cannot mask a real rejection of
  // another. Values are illustrative only — the SET of keys under test comes
  // from the constant, not from this map.
  const sampleValueByKey: Readonly<Record<string, unknown>> = {
    type: "string",
    enum: ["a", "b"],
    properties: { a: { type: "string" } },
    required: true, // D2-N3: at the declaration ROOT, `required` is a boolean, not a JSON-Schema array.
    items: { type: "string" },
    additionalProperties: false,
    minItems: 0,
    maxItems: 10,
    minLength: 0,
    maxLength: 10,
    minimum: 0,
    maximum: 10,
    allOf: [{ type: "string" }],
    anyOf: [{ type: "string" }],
    oneOf: [{ type: "string" }],
    not: { type: "number" },
    title: "Title",
    description: "Description",
    default: "value",
  };

  for (const key of TASK_INPUT_DECLARATION_KEYS) {
    if (!Object.hasOwn(sampleValueByKey, key)) continue; // no sample authored above — not a coverage gap in the constant, just this test's fixture table
    const declaration = { type: "string", [key]: sampleValueByKey[key] };
    const doc = { ...base, inputs: { x: declaration } };
    expect(
      validate(doc),
      `inputs.x.${key} = ${JSON.stringify(sampleValueByKey[key])}: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);
  }

  // Every sample key offered above is actually one TASK_INPUT_DECLARATION_KEYS lists.
  for (const key of Object.keys(sampleValueByKey)) {
    expect(TASK_INPUT_DECLARATION_KEYS, `${key} must be listed in TASK_INPUT_DECLARATION_KEYS`).toContain(key);
  }

  // `pattern` is deliberately absent from TASK_INPUT_DECLARATION_KEYS (it is
  // also the runtime-subset probe the outputSchema test above uses) — a
  // declaration that names it must be rejected as an unknown key.
  expect(TASK_INPUT_DECLARATION_KEYS).not.toContain("pattern");
  expect(
    validate({ ...base, inputs: { x: { type: "string", pattern: "^ok$" } } }),
    "an input declaration with an unlisted keyword must be rejected",
  ).toBe(false);

  // D2-N3: `required` at the declaration root is the boolean flag, not JSON
  // Schema's `required` ARRAY — the array shape must be rejected here even
  // though it is a perfectly ordinary keyword one level down (inside
  // `properties`, tested implicitly above via the `properties` sample).
  expect(
    validate({ ...base, inputs: { x: { type: "string", required: ["x"] } } }),
    "declaration-root required: must be boolean, not an array",
  ).toBe(false);
});

test("published task schema's output: rejects null (schema/parser agreement)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);

  // task source v4's parseOutputSchema (src/tasks/source/task-source-v4.ts)
  // goes straight to asRecord and rejects null with "output must be a
  // mapping." — the published schema must reject it too, not accept a shape
  // the production parser never does. Probed on a COMMAND target, the one
  // kind where `output:` is legal at all (see the target-agreement test
  // below), so what fails here is the null, not the target kind.
  expect(
    validate({ version: TASK_SOURCE_V4_VERSION, uses: "commands/review", output: null }),
    "output: null must be rejected — the production parser does",
  ).toBe(false);
  expect(
    validate({ version: TASK_SOURCE_V4_VERSION, run: "echo hi", output: null }),
    "output: null must be rejected on a run: target too",
  ).toBe(false);

  // A valid bounded schema is still accepted.
  expect(
    validate({
      version: TASK_SOURCE_V4_VERSION,
      uses: "commands/review",
      output: { type: "object", properties: { summary: { type: "string" } } },
    }),
    JSON.stringify(validate.errors),
  ).toBe(true);
});

// 0.9.2 review round 2: c09ad27b made parseTaskSourceV4 reject `output:` on
// every target whose runtime never consumes it (`targetConsumesOutputSchema`
// — only `uses: commands/<ref>` and `uses: akm/command` do), but the
// published schema still accepted it everywhere, so an author's editor
// green-lit a document `akm task run` refuses to load. `schemas/` ships in
// package.json `files` and is served at the `$id` URL, so that divergence is
// user-visible, not editor-only.
test("published task schema's output: is legal only on a command target, exactly as targetConsumesOutputSchema decides (schema/parser agreement)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const outputSchema = { type: "object", properties: { summary: { type: "string" } } };

  // The two target kinds whose runtime forwards output: as the invocation's
  // outputSchema — the schema must keep accepting both.
  for (const target of [
    { uses: "commands/review" },
    { uses: "team//commands/review" },
    { uses: "akm/command", with: { ref: "commands/review" } },
  ]) {
    const document = { version: TASK_SOURCE_V4_VERSION, ...target, output: outputSchema };
    expect(validate(document), `${JSON.stringify(target)}: ${JSON.stringify(validate.errors)}`).toBe(true);
  }

  // The three kinds that carry no output schema anywhere — the schema must
  // now refuse each, and the production parser must agree.
  for (const target of [
    { run: "echo hi", shell: "sh" },
    { uses: "scripts/deploy" },
    { uses: "workflows/nightly" },
    { uses: "team//scripts/deploy" },
  ]) {
    const document = { version: TASK_SOURCE_V4_VERSION, ...target, output: outputSchema };
    const label = JSON.stringify(target);
    expect(validate(document), `${label} + output: must be rejected — the production parser rejects it`).toBe(false);
    expect(() => parseTaskSourceV4({ yaml: JSON.stringify(document), filePath: "/b/tasks/x.yml" }), label).toThrow(
      /output is legal only with a command target/,
    );

    // …and each is still perfectly valid WITHOUT output:, so the rejection is
    // scoped to the field, not to the target kind.
    expect(
      validate({ version: TASK_SOURCE_V4_VERSION, ...target }),
      `${label} without output: ${JSON.stringify(validate.errors)}`,
    ).toBe(true);
  }

  // The commands/-only ref pattern the arm keys on agrees with the production
  // classifier about which executable refs are commands.
  const commandRef = new RegExp(schema.definitions.akmCommandRef?.pattern as string);
  for (const ref of ["commands/review", "team//commands/review", "commands/nested/review"]) {
    expect(classifyTaskSourceV4Uses(ref).kind, ref).toBe("command");
    expect(commandRef.test(ref), ref).toBe(true);
  }
  for (const ref of ["scripts/deploy", "workflows/nightly", "team//scripts/deploy"]) {
    expect(classifyTaskSourceV4Uses(ref).kind, ref).not.toBe("command");
    expect(commandRef.test(ref), ref).toBe(false);
  }
});

test("published task schema's schedule[].inputs is closed to the input name pattern, not the free-form jsonObject $ref (fail-closed hardening)", () => {
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  // A property name matching PROGRAM_PARAM_NAME_PATTERN still validates.
  expect(
    validate({ ...base, schedule: [{ cron: "0 8 * * 1", inputs: { scope: "all" } }] }),
    JSON.stringify(validate.errors),
  ).toBe(true);

  // A property name failing the pattern is rejected at the schema level too
  // — static JSON Schema cannot cross-reference the document's own inputs:
  // declarations, but it can at least close the key SHAPE, rather than
  // publishing the fully free-form jsonObject definition.
  expect(
    validate({ ...base, schedule: [{ cron: "0 8 * * 1", inputs: { "not a name": "x" } }] }),
    "a schedule input key failing the input-name pattern must be rejected",
  ).toBe(false);

  const scheduleEntry = schema.definitions.taskSourceV4ScheduleEntry as JsonSchema;
  const inputsSchema = scheduleEntry.properties.inputs as JsonSchema;
  expect(inputsSchema.$ref).not.toBe("#/definitions/jsonObject");
});

test("published task schema's definitions.jsonArray/jsonValue stay bounded at the shared collection/string limits", () => {
  const schema = readTaskSchema();
  expect(schema.definitions.jsonArray?.maxItems).toBe(TASK_V3_MAX_COLLECTION_ITEMS);
  expect(schema.definitions.jsonValue?.oneOf).toContainEqual({
    type: "string",
    maxLength: TASK_V3_MAX_STRING_BYTES,
  });
});

test("published task schema's akm: options bag equivalents (timeout/redact) stay bounded at their parser limits", () => {
  const schema = readTaskSchema();
  expect(schema.properties.redact?.maxItems).toBe(TASK_V3_MAX_REDACT_NAMES);
  expect((schema.properties.timeout?.oneOf as JsonSchema[])[0]?.maximum).toBe(EXECUTION_MAX_TIMEOUT_MS);
});

test("published task schema's inputs: rejects every name akm task run reserves for its own flags (code-review finding)", () => {
  // `parseInputDeclarations` (src/tasks/source/task-source-v4.ts) rejects any
  // declared input name in TASK_RUN_RESERVED_FLAG_NAMES with
  // TASK_SOURCE_INVALID — the CLI would always treat that flag as its own,
  // never as this input's (src/tasks/task-run-reserved-flags.ts's header).
  // The published schema must reject the same documents, not merely accept
  // and defer to the runtime parser.
  const schema = readTaskSchema();
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const base = { version: TASK_SOURCE_V4_VERSION, run: "echo hi" };

  for (const name of TASK_RUN_RESERVED_FLAG_NAMES) {
    expect(
      validate({ ...base, inputs: { [name]: { type: "string" } } }),
      `inputs: declaring reserved name "${name}" must be rejected: ${JSON.stringify(validate.errors)}`,
    ).toBe(false);
  }

  // A name that is NOT reserved must still validate — the fix must not have
  // over-tightened `propertyNames` into rejecting everything.
  expect(validate({ ...base, inputs: { ticket: { type: "string" } } }), JSON.stringify(validate.errors)).toBe(true);
});
