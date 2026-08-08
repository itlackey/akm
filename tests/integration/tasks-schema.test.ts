import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EXTRA_PARAMS_CREDENTIAL_KEYS, EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS } from "../../src/core/extra-params";
import { parseTaskDocument } from "../../src/tasks/parser";
import { TASK_MAX_TIMEOUT_MS } from "../../src/tasks/schema";
import { WORKFLOW_MAX_RETRIES } from "../../src/workflows/resource-limits";

const root = path.resolve(import.meta.dir, "..", "..");

/** The slice of `schemas/akm-task.json` these tests assert against. */
interface TaskSchemaDoc {
  properties: Record<string, { minimum?: number; maximum?: number }>;
  oneOf: Array<{ required: string[]; not: { anyOf: Array<{ required: string[] }> } }>;
}

function readTaskSchema(): TaskSchemaDoc {
  return JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8")) as TaskSchemaDoc;
}

/** Fields the published schema's `oneOf` branch for `target` forbids. */
function forbiddenFieldsFor(schema: TaskSchemaDoc, target: string): string[] {
  const branch = schema.oneOf.find((entry) => entry.required.includes(target));
  if (!branch) throw new Error(`no oneOf branch requires "${target}"`);
  return branch.not.anyOf.map((entry) => entry.required[0] as string);
}

test("task schema and package contents pin the strict v2 public artifact", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "akm-task.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  expect(schema.properties.version.const).toBe(2);
  expect(schema.additionalProperties).toBe(false);
  expect(schema.required).toContain("version");
  expect(schema.properties).not.toHaveProperty("profile");
  expect(schema.oneOf).toHaveLength(3);
  expect(pkg.files).toContain("schemas");
  expect(pkg.files).toContain("docs/migration/v0.8-to-v0.9.md");
  const extraParams = schema.definitions.extraParams;
  expect(extraParams["x-akm-protectedTopLevelNormalizedKeys"]).toEqual(EXTRA_PARAMS_PROTECTED_TOP_LEVEL_KEYS);
  expect(extraParams["x-akm-recursivelyForbiddenNormalizedKeys"]).toEqual(EXTRA_PARAMS_CREDENTIAL_KEYS);
  expect(schema.definitions.extraParamValue.anyOf[1].items.$ref).toBe("#/definitions/extraParamValue");
});

// ── issue 11: workflow-task run bounds ──────────────────────────────────────
//
// `schemas/akm-task.json` is the published contract for the same YAML the
// parser reads, so a field the parser now accepts (or a restriction it dropped)
// has to move in lockstep or an editor validates a file the runner rejects.

test("published task schema exposes the workflow run bounds the parser accepts", () => {
  const schema = readTaskSchema();

  expect(schema.properties).toHaveProperty("maxSteps");
  expect(schema.properties).toHaveProperty("maxRetries");
  expect(schema.properties.maxSteps?.minimum).toBe(1);
  expect(schema.properties.maxRetries?.minimum).toBe(0);
  // Bounds mirror the constants the parser enforces — pinned, not restated.
  expect(schema.properties.maxRetries?.maximum).toBe(WORKFLOW_MAX_RETRIES);
  expect(schema.properties.timeoutMs?.maximum).toBe(TASK_MAX_TIMEOUT_MS);

  // A workflow task may now set `timeoutMs` (its whole-run timeout) but still
  // no engine/model/llm — those come from the workflow's frozen plan.
  expect(forbiddenFieldsFor(schema, "workflow")).toEqual(["prompt", "command", "engine", "model", "llm"]);
  // The run bounds are workflow-only on both other branches.
  expect(forbiddenFieldsFor(schema, "prompt")).toContain("maxSteps");
  expect(forbiddenFieldsFor(schema, "prompt")).toContain("maxRetries");
  expect(forbiddenFieldsFor(schema, "command")).toContain("maxSteps");
  expect(forbiddenFieldsFor(schema, "command")).toContain("maxRetries");
});

test("the parser accepts exactly the workflow-task fields the schema declares", () => {
  const schema = readTaskSchema();
  const yaml = [
    "version: 2",
    'schedule: "@daily"',
    "workflow: workflows/daily-backup",
    "timeoutMs: 1800000",
    "maxSteps: 8",
    "maxRetries: 1",
    "",
  ].join("\n");
  const task = parseTaskDocument({ yaml, filePath: "/stash/tasks/daily.yml", id: "daily" });

  expect(task.target).toEqual({
    kind: "workflow",
    ref: "workflows/daily-backup",
    params: {},
    timeoutMs: 1800000,
    maxSteps: 8,
    maxRetries: 1,
  });
  for (const key of ["timeoutMs", "maxSteps", "maxRetries"]) {
    expect(schema.properties).toHaveProperty(key);
    expect(forbiddenFieldsFor(schema, "workflow")).not.toContain(key);
  }
});
