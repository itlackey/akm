// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Contract for task source v4's GRAMMAR and its version ROUTER. This file owns
 * the grammar/router half; tests/tasks/source-v4-adapter.test.ts owns the
 * prepare-seam projection.
 *
 * Several assertions below call `validateJsonSchemaSubset` /
 * `checkJsonSchemaDefinition` / `detectSecretShapedParams` directly to DERIVE
 * the expected substring of a task source v4 parser error or warning, rather
 * than guessing implementation-internal wording — the derivation ties this
 * file's pins to real, shipped behavior instead of speculative prose.
 *
 * Routing: task source v3 acceptance is retired from `src`. `version: 2` AND
 * `version: 3` both raise TASK_SCHEMA_VERSION_UNSUPPORTED with the SAME migrate
 * hint — the migrator runs both the v2->v3 and v3->v4 generations in sequence,
 * so one hint covers both starting points. Any OTHER defined NUMBER outside
 * {2, 3, 4} (5, …) is unambiguously a version number this release does not
 * support, so it ALSO takes the migrate-hint UNSUPPORTED path, never
 * TASK_SOURCE_INVALID. Only a MISSING `version:` key, or a `version:` that is
 * not a number at all ("3", null, …), falls through to task source v4's OWN
 * field-level TASK_SOURCE_INVALID wording — "version is required and must be
 * 4." / "version must be exactly 4." — because those inputs are not version
 * numbers to begin with, so there is nothing to route on; they are malformed v4
 * documents, not legacy ones.
 *
 * Naming: this grammar is "task source v4", never bare "v4" — the workflow plan
 * IR is separately versioned and also currently at v4, and the two must not be
 * conflated.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../../src/core/errors";
import {
  checkJsonSchemaDefinition,
  JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS,
  validateJsonSchemaSubset,
} from "../../src/core/json-schema";
import { _resetWarnOnceForTests, _setWarnSinkForTests } from "../../src/core/warn";
import { EXECUTION_MAX_TIMEOUT_MS } from "../../src/execution/limits";
import { TASK_V3_MAX_REDACT_NAMES } from "../../src/tasks/source/bounded-document";
import * as ParseTaskSourceModule from "../../src/tasks/source/parse-task-source";
import * as TaskSourceV4Module from "../../src/tasks/source/task-source-v4";
import { TASK_V3_MAX_SCHEDULES } from "../../src/tasks/source-v3";
import {
  TASK_RUN_BOOLEAN_FLAGS,
  TASK_RUN_RESERVED_FLAG_NAMES,
  TASK_RUN_SELF_DIAGNOSED_FLAGS,
  TASK_RUN_VALUE_FLAGS,
} from "../../src/tasks/task-run-reserved-flags";
import { detectSecretShapedParams } from "../../src/workflows/exec/param-secrets";
import { PROGRAM_PARAM_NAME_PATTERN } from "../../src/workflows/parser";
import { WORKFLOW_MAX_SCHEMA_BYTES } from "../../src/workflows/resource-limits";
import { overrideSeam } from "../_helpers/seams";

const { parseTaskSource, peekTaskSourceVersion } = ParseTaskSourceModule;
type ParsedTaskSource = ParseTaskSourceModule.ParsedTaskSource;

const {
  classifyTaskSourceV4Uses,
  parseTaskSourceV4,
  parseTaskSourceV4Document,
  TASK_INPUT_DECLARATION_KEYS,
  TASK_SOURCE_V4_SCHEDULE_KEYS,
  TASK_SOURCE_V4_TOP_LEVEL_KEYS,
  TASK_SOURCE_V4_VERSION,
} = TaskSourceV4Module;
type TaskSourceV4Document = TaskSourceV4Module.TaskSourceV4Document;

const ROOT = path.resolve(import.meta.dir, "../..");
const FIXTURES_DIR = path.join(ROOT, "tests/fixtures/execution-contracts/tasks/v4");

/** No default target/schedule — every call site supplies exactly the keys it means to exercise. */
function v4Doc(overrides: Record<string, unknown>): Record<string, unknown> {
  return { version: TASK_SOURCE_V4_VERSION, ...overrides };
}

/**
 * Run `fn`, assert it throws a `UsageError` coded `TASK_SOURCE_INVALID`, assert
 * its message matches every pattern given (each checked independently), and
 * return the caught error so callers can layer additional assertions (e.g.
 * {@link expectTopLevelFieldPath}) without re-invoking `fn`.
 */
function expectTaskSourceInvalid(fn: () => unknown, pattern: RegExp | readonly RegExp[]): UsageError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const error = caught as UsageError;
  expect(error.code).toBe("TASK_SOURCE_INVALID");
  for (const one of Array.isArray(pattern) ? pattern : [pattern]) {
    expect(error.message).toMatch(one);
  }
  return error;
}

/**
 * Assert `message` locates the detail at the EXACT top-level dotted field
 * path `field` — not nested under `akm.` — per `sourceError`'s
 * `${dotted} ${detail}` rendering. A v4 implementation that reuses v3's
 * `parseAkm` wholesale (nesting every execution control under
 * `["akm", key]`) would still satisfy a loose `/timeout/i`-style substring
 * match on `"akm.timeout must be …"`; this pins the field path itself so that
 * regression class fails loudly instead of passing vacuously.
 */
function expectTopLevelFieldPath(message: string, field: string): void {
  expect(message).toContain(`: ${field} `);
  expect(message).not.toContain(`akm.${field}`);
}

interface ManifestFixture {
  readonly id: string;
  readonly file: string;
  readonly represents: readonly string[];
  readonly expected: Readonly<Record<string, unknown>>;
}

function loadManifestFixtures(): readonly ManifestFixture[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as { readonly fixtures: readonly ManifestFixture[] };
  return parsed.fixtures;
}

function parseFixture(fixture: ManifestFixture): TaskSourceV4Document {
  const filePath = path.join(FIXTURES_DIR, fixture.file);
  return parseTaskSourceV4({ yaml: fs.readFileSync(filePath, "utf8"), filePath });
}

const MANIFEST_FIXTURES = loadManifestFixtures();

// ── Closed key-set constants ────────────────────────────────────────────────

describe("task source v4 — closed key-set constants (D2-N3, D2-N7)", () => {
  test("TASK_SOURCE_V4_VERSION is 4", () => {
    expect(TASK_SOURCE_V4_VERSION).toBe(4);
  });

  test("TASK_SOURCE_V4_TOP_LEVEL_KEYS is exactly D2-N7's closed set (akm and on excluded)", () => {
    expect([...TASK_SOURCE_V4_TOP_LEVEL_KEYS].sort()).toEqual(
      [
        "version",
        "name",
        "description",
        "when_to_use",
        "tags",
        "inputs",
        "output",
        "uses",
        "run",
        "with",
        "env",
        "shell",
        "working-directory",
        "schedule",
        "agent",
        "engine",
        "model",
        "inference",
        "tools",
        "timeout",
        "redact",
        "maxSteps",
        "maxRetries",
      ].sort() as never,
    );
    expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("akm");
    expect(TASK_SOURCE_V4_TOP_LEVEL_KEYS).not.toContain("on");
  });

  test("TASK_SOURCE_V4_SCHEDULE_KEYS closes one schedule-list entry to cron/inputs", () => {
    expect([...TASK_SOURCE_V4_SCHEDULE_KEYS].sort()).toEqual(["cron", "inputs"].sort() as never);
  });

  test("TASK_INPUT_DECLARATION_KEYS derives its JSON-Schema-subset keywords from JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS (D2-N3) rather than restating them", () => {
    const subsetKeywords = JSON_SCHEMA_SUBSET_SUPPORTED_KEYWORDS.split(",").map(
      (entry) => entry.split(":")[0]?.trim() ?? "",
    );
    for (const keyword of subsetKeywords) {
      expect(TASK_INPUT_DECLARATION_KEYS, `must cover subset keyword "${keyword}"`).toContain(keyword);
    }
    expect([...TASK_INPUT_DECLARATION_KEYS].sort()).toEqual(
      [
        "type",
        "enum",
        "properties",
        "required",
        "items",
        "additionalProperties",
        "minItems",
        "maxItems",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "allOf",
        "anyOf",
        "oneOf",
        "not",
        "title",
        "description",
        "default",
      ].sort(),
    );
  });
});

// ── classifyTaskSourceV4Uses — target classification ───────────────────────

describe("classifyTaskSourceV4Uses — target classification (spec §3.3)", () => {
  test.each([
    ["akm/command", { kind: "builtin-command", ref: "akm/command" }],
    ["commands/review", { kind: "command", ref: "commands/review" }],
    ["scripts/nightly-cleanup.sh", { kind: "script", ref: "scripts/nightly-cleanup.sh" }],
    ["workflows/release", { kind: "workflow", ref: "workflows/release" }],
  ] as const)("classifies %s deterministically", (input, expected) => {
    expect(classifyTaskSourceV4Uses(input)).toEqual(expected);
  });

  test("rejects a task ref — a task ref is not an executable task source v4 target (B-14)", () => {
    expect(() => classifyTaskSourceV4Uses("tasks/nightly")).toThrow(/task/i);
  });

  test.each([
    "agents/reviewer",
    "docker://alpine:3",
  ])("rejects non-canonical, local, Docker, traversal, or ambiguous ref %p", (input) => {
    expect(() => classifyTaskSourceV4Uses(input)).toThrow();
  });

  test.each([
    "actions/checkout@v4",
  ])("rejects a github-locator-shaped ref %p by NAMING the removal, not a generic invalid-ref message (B-13)", (input) => {
    expect(() => classifyTaskSourceV4Uses(input)).toThrow(/github/i);
  });

  // `@` is a legal character in a canonical asset ref (`parseBundleRef`/
  // `classifyTargetRef` both accept it), so a value the canonical classifier
  // accepts must classify — the locator SHAPE test runs only on the
  // classification-failure path and never vetoes a valid ref (it exists only to
  // produce a good message, never to accept).
  test.each([
    ["commands/review@v2", { kind: "command", ref: "commands/review@v2" }],
  ] as const)("classifies the canonical '@'-bearing ref %s instead of misreading it as a github locator", (input, expected) => {
    expect(classifyTaskSourceV4Uses(input)).toEqual(expected);
  });

  test("a canonical tasks/ ref containing '@' takes the task-ref rejection (B-14), not the github-removal message", () => {
    expect(() => classifyTaskSourceV4Uses("tasks/nightly@v1")).toThrow(/task ref/i);
  });
});

// ── parseTaskSourceV4Document — target union, with:, shell/working-directory ──

describe("parseTaskSourceV4Document — target union (uses/run exactly one, D2-N1, B-13..B-18)", () => {
  test("exactly one of uses/run is required (same detail text as v3, B-16) — the FULL message is pinned byte-exactly, proving the D2-N4 'task source v4' label (not 'task v3 source')", () => {
    // The detail text, pinned verbatim: a v4 parser that is really just v3's
    // `parseTaskV3Document` wearing a v4 hat would render "Invalid task v3 source
    // at …" for this exact input — a loose `/exactly one/i` match cannot tell the
    // two labels apart, so this asserts the complete "Invalid task source v4 at
    // <path>: <field> <detail>" shape in one `toBe`, not a substring.
    const error = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({}), { filePath: "/x.yml" }),
      /exactly one/i,
    );
    expect(error.message).toBe(
      "Invalid task source v4 at /x.yml: $ requires exactly one executable selector: uses or run.",
    );

    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/x", run: "echo x" }), { filePath: "/x.yml" }),
      /exactly one/i,
    );
  });

  test("a task ref uses: target is TASK_SOURCE_INVALID (B-14)", () => {
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "tasks/other" }), { filePath: "/x.yml" }),
      [/uses/i, /task/i],
    );
  });

  test("a github-locator uses: is TASK_SOURCE_INVALID, naming the removal (B-13)", () => {
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "actions/checkout@v4" }), { filePath: "/x.yml" }),
      /github/i,
    );
  });

  test("uses: commands/, scripts/, and workflows/ all parse to the nested TaskSourceV4Target shape", () => {
    const command = parseTaskSourceV4Document(v4Doc({ uses: "commands/review" }), { filePath: "/x.yml" });
    expect(command.target).toEqual({ kind: "uses", uses: { kind: "command", ref: "commands/review" } });

    const script = parseTaskSourceV4Document(v4Doc({ uses: "scripts/nightly-cleanup.sh" }), { filePath: "/x.yml" });
    expect(script.target).toEqual({ kind: "uses", uses: { kind: "script", ref: "scripts/nightly-cleanup.sh" } });

    const workflow = parseTaskSourceV4Document(v4Doc({ uses: "workflows/nightly-report" }), { filePath: "/x.yml" });
    expect(workflow.target).toEqual({ kind: "uses", uses: { kind: "workflow", ref: "workflows/nightly-report" } });
  });

  test("with: is accepted on uses: akm/command and validated by the EXISTING parseBuiltinCommandAction (D2-N1)", () => {
    const doc = parseTaskSourceV4Document(v4Doc({ uses: "akm/command", with: { content: "hi" } }), {
      filePath: "/x.yml",
    });
    expect(doc.target).toEqual({
      kind: "uses",
      uses: { kind: "builtin-command", ref: "akm/command" },
      with: { content: "hi" },
      command: { kind: "inline", content: "hi" },
    });
  });

  test("with: on akm/command is rejected by the SAME parseBuiltinCommandAction accept/reject set as v3 (D2-N1)", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "akm/command", with: { ref: "commands/x", content: "y" } }), {
          filePath: "/x.yml",
        }),
      /exactly one/i,
    );
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "akm/command", with: { content: "y", extra: true } }), {
          filePath: "/x.yml",
        }),
      /unsupported field/i,
    );
  });

  test.each([
    ["uses: commands/review", { uses: "commands/review" }],
  ])("with: is rejected and points at inputs: everywhere except uses: akm/command (%s, D2-N1, B-18)", (_label, target) => {
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ ...target, with: { x: 1 } }), { filePath: "/x.yml" }),
      /inputs/i,
    );
  });

  test("shell and working-directory are legal only with run: (mirrors v3)", () => {
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", shell: "bash" }), { filePath: "/x.yml" }),
      /shell/i,
    );
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", "working-directory": "." }), {
          filePath: "/x.yml",
        }),
      /working-directory/i,
    );
  });

  test("shell must be one of the closed host-shell table (mirrors v3)", () => {
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ run: "echo hi", shell: "bash -e {0}" }), { filePath: "/x.yml" }),
      /shell/i,
    );
  });

  test("run: containing a GitHub-style ${{ }} expression is accepted verbatim — akm has no expander on this path, and the workflow side passes these bytes through unchanged", () => {
    const doc = parseTaskSourceV4Document(v4Doc({ run: "echo 'runs-on: ${{ matrix.os }}' >> ci.yml" }), {
      filePath: "/x.yml",
    });
    expect(doc.target).toEqual({ kind: "run", run: "echo 'runs-on: ${{ matrix.os }}' >> ci.yml" });
  });

  test("accepts the closed run/shell/working-directory contract with real physical containment (mirrors v3)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akm-task-source-v4-root-"));
    fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
    try {
      const doc = parseTaskSourceV4Document(
        v4Doc({ run: "printf '%s\\n' exact", shell: "bash", "working-directory": "packages/core" }),
        { filePath: path.join(root, "tasks", "run.yml"), workspaceRoot: root },
      );
      expect(doc.target).toEqual({
        kind: "run",
        run: "printf '%s\\n' exact",
        shell: "bash",
        workingDirectory: "packages/core",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires a workspace root whenever working-directory needs physical containment (mirrors v3)", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ run: "echo hi", "working-directory": "packages/core" }), {
          filePath: "/bundle/tasks/run.yml",
        }),
      /workspace root|physically|contain/i,
    );
  });
});

// ── akm:/on: removal ────────────────────────────────────────────────────────

describe("task source v4 — akm:/on: removal (B-11, B-12)", () => {
  test("an akm: key is TASK_SOURCE_INVALID, naming the removal and pointing at the top-level spellings", () => {
    // The detail must NAME THE REMOVAL, not merely mention "akm" — `checkKeys`'
    // generic unknown-field wording ("akm is an unsupported field.") also matches
    // a bare `/akm/`, so a pattern-only check here is satisfiable by routing
    // `akm:` through the SAME generic closed-key rejection every other
    // unrecognized top-level key gets — exactly the regression class this test
    // must catch. The second pattern requires wording only a removal-specific
    // detail can produce.
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", akm: { schedule: "@daily" } }), {
          filePath: "/x.yml",
        }),
      [/akm/, /removed|no longer|top-level/i],
    );
  });

  test("an on: key is TASK_SOURCE_INVALID, naming the removal and pointing at schedule:", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", on: { schedule: [{ cron: "0 0 * * *" }] } }), {
          filePath: "/x.yml",
        }),
      [/\bon\b/, /schedule/i],
    );
  });

  test("an unrecognized top-level key is rejected by the closed TASK_SOURCE_V4_TOP_LEVEL_KEYS set (generic wording)", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", bogusTopLevelKey: true }), {
          filePath: "/x.yml",
        }),
      /bogusTopLevelKey/,
    );
  });

  test("the akm:/on: removal messages are distinguishable from a generic unknown-key rejection (their detail NAMES the removal, not merely a different interpolated key name)", () => {
    // Compare each message against the GENERIC-SHAPED string for THAT SAME key —
    // the literal wording a naive "route akm/on through the ordinary closed-key
    // check" implementation would produce for exactly this key. (`checkKeys`'
    // generic wording is `"<key> is an unsupported field."`, which interpolates the
    // offending key name, so two generic messages for two DIFFERENT key names would
    // differ trivially and a comparison between them would pass vacuously.) Only a
    // detail that truly names the removal can pass.
    const genericShapedAkmMessage = "Invalid task source v4 at /x.yml: akm is an unsupported field.";
    const genericShapedOnMessage = "Invalid task source v4 at /x.yml: on is an unsupported field.";

    let akmMessage = "";
    try {
      parseTaskSourceV4Document(v4Doc({ uses: "commands/review", akm: { schedule: "@daily" } }), {
        filePath: "/x.yml",
      });
    } catch (error) {
      akmMessage = (error as Error).message;
    }
    let onMessage = "";
    try {
      parseTaskSourceV4Document(v4Doc({ uses: "commands/review", on: { schedule: [{ cron: "0 0 * * *" }] } }), {
        filePath: "/x.yml",
      });
    } catch (error) {
      onMessage = (error as Error).message;
    }

    expect(akmMessage.length).toBeGreaterThan(0);
    expect(onMessage.length).toBeGreaterThan(0);
    expect(akmMessage).not.toBe(genericShapedAkmMessage);
    expect(onMessage).not.toBe(genericShapedOnMessage);
  });
});

// ── Version router ──────────────────────────────────────────────────────────

describe("task source v4 — version router (spec §3.4, D2-N2's exact routing table)", () => {
  test("peekTaskSourceVersion reads the root version field without over-accepting non-number values", () => {
    expect(peekTaskSourceVersion({ version: 4 })).toBe(4);
    expect(peekTaskSourceVersion({ version: 3 })).toBe(3);
    expect(peekTaskSourceVersion({ version: 2 })).toBe(2);
    expect(peekTaskSourceVersion({})).toBeUndefined();
    expect(peekTaskSourceVersion({ version: "4" })).toBeUndefined();
    expect(peekTaskSourceVersion(null)).toBeUndefined();
    expect(peekTaskSourceVersion("not an object")).toBeUndefined();
  });

  test("version: 4 routes to the new task source v4 parser", () => {
    const yaml = "version: 4\nuses: commands/review\n";
    const filePath = "/bundle/tasks/x.yml";
    const result: ParsedTaskSource = parseTaskSource({ yaml, filePath });
    expect(result.version).toBe(4);
    if (result.version !== 4) throw new Error("unreachable: asserted above");
    expect(result.v4.target).toEqual({ kind: "uses", uses: { kind: "command", ref: "commands/review" } });
    expect(result.v4.manualOnly).toBe(true);
  });

  // The runtime reads only task source v4 (#987). A v2/v3 document, or a v4
  // document still carrying 0.9.15's retired `schedule[].enabled`, is exactly
  // what `akm migrate apply` rewrites; the reader refuses it, naming that
  // command, and never converts it in memory. The caller reports the refusal
  // per file (`akm task sync` keeps reconciling every other task).
  describe("anything `akm migrate apply` would rewrite is refused, naming it", () => {
    let warnCalls: string[] = [];

    beforeEach(() => {
      warnCalls = [];
      _resetWarnOnceForTests();
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      });
    });

    function refusal(yaml: string, filePath: string): UsageError {
      let error: unknown;
      try {
        parseTaskSource({ yaml, filePath });
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(UsageError);
      return error as UsageError;
    }

    test.each([
      ["version: 3", "version: 3\nuses: commands/review\nakm:\n  schedule: '@daily'\n", 3],
      [
        "a convertible version: 2",
        "version: 2\nschedule: '0 2 * * *'\nenabled: true\ncommand: /usr/local/bin/backup.sh\n",
        2,
      ],
      [
        "a version: 2 the migrator itself cannot convert",
        "version: 2\nschedule: '0 2 * * *'\ncommand:\n  - /usr/local/bin/backup.sh\n  - --force\n",
        2,
      ],
    ] as const)("%s raises TASK_SCHEMA_VERSION_UNSUPPORTED naming `akm migrate apply`, without converting it", (_label, yaml, version) => {
      const filePath = "/bundle/tasks/legacy.yml";
      const error = refusal(yaml, filePath);
      expect(error.code).toBe("TASK_SCHEMA_VERSION_UNSUPPORTED");
      expect(error.message).toBe(
        `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version ${version}; this release reads only version 4. Run \`akm migrate apply\` to convert it.`,
      );
      expect(error.hint()).toContain("akm migrate apply --dry-run");
      expect(warnCalls).toEqual([]);
    });

    test("a v4 document with a retired schedule[].enabled raises TASK_SOURCE_INVALID naming `akm migrate apply`, whatever the value", () => {
      for (const value of ["false", "true", "yes"]) {
        const filePath = `/bundle/tasks/retired-${value}.yml`;
        const error = refusal(
          `version: 4\nuses: commands/review\nschedule:\n  - cron: '0 4 * * *'\n    enabled: ${value}\n`,
          filePath,
        );
        expect(error.code).toBe("TASK_SOURCE_INVALID");
        expect(error.message).toBe(
          `Invalid task source v4 at ${filePath}: schedule[].enabled was removed (scheduler activation is host-local config). Run \`akm migrate apply\` to rewrite it.`,
        );
      }
      expect(warnCalls).toEqual([]);
    });

    test("a v4 document without schedule[].enabled parses directly and never warns", () => {
      const yaml = "version: 4\nuses: commands/review\nschedule:\n  - cron: '0 4 * * *'\n";
      const result = parseTaskSource({ yaml, filePath: "/bundle/tasks/z.yml" });
      expect(result.version).toBe(4);
      expect(result.v4.schedule).toHaveLength(1);
      expect(warnCalls).toHaveLength(0);
    });
  });

  // A document with no version: key, or a version: that is NOT A NUMBER, is a
  // malformed v4 document — v4's own TASK_SOURCE_INVALID field error, not the
  // migrate-hint UNSUPPORTED path. A NUMERIC version outside {2, 3, 4} is still
  // unambiguously a version number, so it takes the migrate-hint path below, not
  // this one.
  test.each([
    ["missing version", "uses: commands/review\n", "version is required and must be 4."],
  ] as const)("D2-N2/B-16: %s routes to task source v4's OWN TASK_SOURCE_INVALID wording", (_label, yaml, detail) => {
    const filePath = "/bundle/tasks/x.yml";
    let error: unknown;
    try {
      parseTaskSource({ yaml, filePath });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe(`Invalid task source v4 at ${filePath}:1: ${detail}`);
  });

  // A defined version NUMBER outside {2, 3, 4} is unambiguously a version —
  // "unsupported", not "malformed".
  test("D2-N2: version: 5 (a number, but not one this release accepts) still raises TASK_SCHEMA_VERSION_UNSUPPORTED with the migrate hint, never TASK_SOURCE_INVALID", () => {
    const yaml = "version: 5\nuses: commands/review\n";
    const filePath = "/bundle/tasks/x.yml";
    let error: unknown;
    try {
      parseTaskSource({ yaml, filePath });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SCHEMA_VERSION_UNSUPPORTED");
    expect((error as UsageError).message).toBe(
      `TASK_SCHEMA_VERSION_UNSUPPORTED: Task at ${filePath} uses task schema version 5, which this release does not accept.`,
    );
  });

  // The bounded YAML front end's sourceLabel is "task source"; do not
  // reintroduce "task v3 source" here.
  test("front-end (pre-version) YAML failures render with the 'task source' label (row B-17, P2a's wart closed)", () => {
    // The bounded YAML front end runs ONCE, before `root.version` is even
    // read, so a hostile/malformed-YAML failure has no version to route on
    // yet.
    const yaml = "version: 4\nuses: [\n";
    const filePath = "/bundle/tasks/hostile.yml";
    expect(() => parseTaskSource({ yaml, filePath })).toThrow(/^Invalid task source at/);
  });
});

// ── Optional schedule ───────────────────────────────────────────────────────

describe("task source v4 — optional schedule (D2-N6, D2-N5, B-06..B-10, B-38)", () => {
  test("absent schedule: parses as valid, manual-only, and akm task sync's projection input (B-06, D2-N6)", () => {
    const doc = parseTaskSourceV4Document(v4Doc({ uses: "commands/review" }), { filePath: "/x.yml" });
    expect(doc.manualOnly).toBe(true);
    expect(doc.schedule).toEqual([]);
    expect(Object.isFrozen(doc.schedule)).toBe(true);
  });

  test("schedule: as a bare string is shorthand for one binding with no inputs (B-08)", () => {
    const doc = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", schedule: "0 8 * * 1" }), {
      filePath: "/x.yml",
    });
    expect(doc.manualOnly).toBe(false);
    expect(doc.schedule).toEqual([{ cron: "0 8 * * 1", inputs: {}, source: "schedule", ordinal: 0 }]);
  });

  test("schedule: as a list assigns ordinals and schedule[<i>].cron source strings (B-09)", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ uses: "commands/review", schedule: [{ cron: "0 6 * * *" }, { cron: "30 18 * * 1-5" }] }),
      { filePath: "/x.yml" },
    );
    expect(doc.schedule).toEqual([
      { cron: "0 6 * * *", inputs: {}, source: "schedule[0].cron", ordinal: 0 },
      { cron: "30 18 * * 1-5", inputs: {}, source: "schedule[1].cron", ordinal: 1 },
    ]);
  });

  test("schedule[i].enabled is rejected because activation is host-local config", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ uses: "commands/review", schedule: [{ cron: "0 6 * * *", enabled: false }] }),
          { filePath: "/x.yml" },
        ),
      /enabled|unknown/i,
    );
  });

  test("schedule count is bounded by TASK_V3_MAX_SCHEDULES, reused (B-09)", () => {
    const atBound = Array.from({ length: TASK_V3_MAX_SCHEDULES }, (_, i) => ({ cron: `${i % 60} * * * *` }));
    expect(() =>
      parseTaskSourceV4Document(v4Doc({ uses: "commands/review", schedule: atBound }), { filePath: "/x.yml" }),
    ).not.toThrow();

    const overBound = Array.from({ length: TASK_V3_MAX_SCHEDULES + 1 }, (_, i) => ({ cron: `${i % 60} * * * *` }));
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", schedule: overBound }), { filePath: "/x.yml" }),
      new RegExp(String(TASK_V3_MAX_SCHEDULES)),
    );
  });

  test("schedule[i].inputs validated against the document's input declarations — a satisfying literal is accepted (B-38)", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({
        uses: "commands/review",
        inputs: { scope: { type: "string", enum: ["changed", "all"] } },
        schedule: [{ cron: "0 0 * * *", inputs: { scope: "all" } }],
      }),
      { filePath: "/x.yml" },
    );
    expect(doc.schedule[0]?.inputs).toEqual({ scope: "all" });
  });

  test("schedule[i].inputs violating a declared input's schema is TASK_SOURCE_INVALID (B-38)", () => {
    const derived = validateJsonSchemaSubset("bogus", { type: "string", enum: ["changed", "all"] });
    expect(derived.length).toBeGreaterThan(0);
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({
            uses: "commands/review",
            inputs: { scope: { type: "string", enum: ["changed", "all"] } },
            schedule: [{ cron: "0 0 * * *", inputs: { scope: "bogus" } }],
          }),
          { filePath: "/x.yml" },
        ),
      /not one of|enum|scope/i,
    );
  });

  test("schedule[i].inputs carrying a key the document does not declare is rejected — TASK_SOURCE_INVALID at schedule[<i>].inputs.<name> (fail-closed, code-review finding)", () => {
    // `validateInputs`'s synthetic {type:"object", properties} schema has no
    // additionalProperties: false — a general-purpose contract validator correctly
    // leaves that choice to its callers. Parsing a schedule[i].inputs literal is
    // one such caller, and it closes against the declared contract itself
    // (mirroring materializeInputFlags' own exact-name rule), so an undeclared key
    // is rejected here rather than silently accepted-but-ignored forever.
    const error = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({
            uses: "commands/review",
            inputs: { scope: { type: "string" } },
            schedule: [{ cron: "0 0 * * *", inputs: { scope: "changed", undeclared: "ignored" } }],
          }),
          { filePath: "/x.yml" },
        ),
      /undeclared/,
    );
    expect(error.message).toContain("schedule[0].inputs.undeclared");
  });
});

// ── A declared inputs: name may not collide with a flag `akm task` claims ──

describe("task source v4 — inputs: names that collide with akm task's own flags are rejected at declaration time", () => {
  test("every TASK_RUN_RESERVED_FLAG_NAMES member is rejected as a declared input name", () => {
    for (const name of TASK_RUN_RESERVED_FLAG_NAMES) {
      const error = expectTaskSourceInvalid(
        () =>
          parseTaskSourceV4Document(v4Doc({ uses: "commands/review", inputs: { [name]: { type: "string" } } }), {
            filePath: "/x.yml",
          }),
        new RegExp(`inputs\\.${name.replace(/-/g, "\\-")} `),
      );
      // `no-quiet` / `no-verbose` are citty's `--no-` negations: a hyphen is
      // not a legal input name to begin with, so they are already rejected one
      // check earlier by INPUT_NAME_PATTERN. Every name that COULD have been
      // declared reaches the collision rejection itself.
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        expect(error.message, name).toContain("declare the input under a different name.");
      } else {
        expect(error.message, name).toContain("must match the input name pattern");
      }
    }
  });

  // `target` is reserved from the DIAGNOSTIC side, not the declared-arg side: it
  // is in neither scanner set, so `parseTaskInputFlags`
  // (src/commands/tasks/tasks-cli.ts) would happily capture `--target=<value>` as
  // an input flag — but `rejectRetiredTaskTargetFlag` throws the 0.9 `--target`
  // -> `--bundle` rename hint for EVERY spelling of the name before that scanner
  // ever runs, so a task declaring an input named `target` would have no
  // reachable way to be given one. Reserving the NAME here makes the unusable
  // declaration impossible to author instead of narrowing the rejecter (which
  // would reopen the silently-ignored `--target=team`).
  test("`target` is reserved even though it is in neither scanner set, and its message names the retired spelling", () => {
    expect(TASK_RUN_SELF_DIAGNOSED_FLAGS).toEqual(["target"]);
    expect(TASK_RUN_VALUE_FLAGS).not.toContain("target");
    expect(TASK_RUN_BOOLEAN_FLAGS).not.toContain("target");
    expect(TASK_RUN_RESERVED_FLAG_NAMES.has("target")).toBe(true);

    const error = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ run: "echo hi", inputs: { target: { type: "string", default: "staging" } } }),
          {
            filePath: "/x.yml",
          },
        ),
      /inputs\.target/,
    );
    expect(error.message).toContain("collides with the retired `akm task --target` spelling");
  });

  test("a name that is merely SIMILAR to a reserved flag still parses — the check is exact-name, not fuzzy", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ run: "echo hi", inputs: { target_env: { type: "string" }, bundles: { type: "string" } } }),
      { filePath: "/x.yml" },
    );
    expect(Object.keys(doc.inputs ?? {}).sort()).toEqual(["bundles", "target_env"]);
  });
});

// ── Every schedule binding must be independently runnable ──────────────────

/**
 * A scheduled firing supplies NO input flags — `compileTaskSchedulerBindings`
 * appends only the entry's own `schedule[i].inputs` to the invocation tail
 * (`src/tasks/scheduler-binding.ts`) — so an entry's literals PLUS the
 * declared defaults are the complete value set the run will see. A
 * `required: true` declaration may not carry a `default`, so a schedule entry
 * that names no value for it can never satisfy the contract.
 *
 * The check happens at parse time for every entry shape, including the string
 * shorthand and a list entry with no `inputs:` key; otherwise those would parse
 * clean and defer to `akm task sync`'s own projectability proof
 * (`src/tasks/scheduler-sync.ts`), which rejects the desired set before
 * mutation but only tells the author at sync time and only for the install
 * path. The source document alone knows both the contract and the schedule, so
 * the contradiction is a grammar error.
 */
describe("task source v4 — a schedule entry must satisfy the declared inputs once defaults are applied", () => {
  const REQUIRED_TICKET = { ticket: { type: "string", required: true } } as const;

  test("schedule: string shorthand + a required, default-less input is TASK_SOURCE_INVALID naming the input (B-08 shape is unchanged; the contradiction is)", () => {
    const error = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", inputs: REQUIRED_TICKET, schedule: "0 8 * * 1" }), {
          filePath: "/x.yml",
        }),
      [/schedule /, /ticket/, /is required/],
    );
    // Located at the `schedule` key itself — the shorthand has no entry index
    // and no `inputs:` sub-path to point at.
    expect(error.message).toContain("/x.yml: schedule ");
  });

  test("a schedule LIST entry with no inputs: key at all is rejected the same way, at its own ordinal", () => {
    const error = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({
            uses: "commands/review",
            inputs: REQUIRED_TICKET,
            schedule: [{ cron: "0 6 * * *", inputs: { ticket: "OPS-1" } }, { cron: "30 18 * * 1-5" }],
          }),
          { filePath: "/x.yml" },
        ),
      [/ticket/, /is required/],
    );
    // The FIRST entry satisfies the contract; only the second is at fault.
    expect(error.message).toContain("schedule[1]");
    expect(error.message).not.toContain("schedule[0]");
  });

  test("an entry that supplies the required input parses, and its literal survives verbatim", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({
        uses: "commands/review",
        inputs: REQUIRED_TICKET,
        schedule: [{ cron: "0 6 * * *", inputs: { ticket: "OPS-7" } }],
      }),
      { filePath: "/x.yml" },
    );
    expect(doc.schedule[0]?.inputs).toEqual({ ticket: "OPS-7" });
  });

  test("a declared default satisfies the contract for every entry — shorthand and inputs-less list entry alike (defaults are applied first)", () => {
    const defaulted = { scope: { type: "string", enum: ["changed", "all"], default: "changed" } };
    expect(
      parseTaskSourceV4Document(v4Doc({ uses: "commands/review", inputs: defaulted, schedule: "0 8 * * 1" }), {
        filePath: "/x.yml",
      }).schedule,
    ).toHaveLength(1);
    expect(
      parseTaskSourceV4Document(
        v4Doc({ uses: "commands/review", inputs: defaulted, schedule: [{ cron: "0 6 * * *" }] }),
        { filePath: "/x.yml" },
      ).schedule[0]?.inputs,
      // The default is NOT materialized into the frozen binding — it is
      // applied again at run time (load-task.ts) from the same declaration.
    ).toEqual({});
  });
});

// ── Typed input declarations ────────────────────────────────────────────────

describe("task source v4 — typed input declarations (D2-N3, B-19..B-23)", () => {
  test("accepts a bounded JSON Schema declaration, validated through the EXISTING validateJsonSchemaSubset/checkJsonSchemaDefinition", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ uses: "commands/review", inputs: { scope: { type: "string", enum: ["changed", "all"] } } }),
      { filePath: "/x.yml" },
    );
    expect(doc.inputs).toEqual({
      scope: { schema: { type: "string", enum: ["changed", "all"] }, required: false },
    });
  });

  test("default is accepted, stripped from .schema, and carried on InputDeclaration.default", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ uses: "commands/review", inputs: { strict: { type: "boolean", default: true } } }),
      { filePath: "/x.yml" },
    );
    expect(doc.inputs?.strict).toEqual({ schema: { type: "boolean" }, default: true, required: false });
  });

  test("default together with required: true is TASK_SOURCE_INVALID at inputs.<name> (B-20)", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ uses: "commands/review", inputs: { ticket: { type: "string", required: true, default: "x" } } }),
          { filePath: "/x.yml" },
        ),
      /inputs\.ticket/,
    );
  });

  test("an unknown declaration key is TASK_SOURCE_INVALID at inputs.<name>.<key> (B-19)", () => {
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ uses: "commands/review", inputs: { scope: { type: "string", bogusKey: 1 } } }),
          { filePath: "/x.yml" },
        ),
      /inputs\.scope\.bogusKey/,
    );
  });

  test("default must itself satisfy its own (stripped) declaration — a violation is TASK_SOURCE_INVALID at inputs.<name>.default, carrying validateJsonSchemaSubset's own error text (B-21)", () => {
    const derived = validateJsonSchemaSubset(-5, { type: "integer", minimum: 0 });
    expect(derived[0]).toMatch(/below minimum/);
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ uses: "commands/review", inputs: { count: { type: "integer", minimum: 0, default: -5 } } }),
          { filePath: "/x.yml" },
        ),
      [/inputs\.count\.default/, /below minimum/],
    );
  });

  test("input name grammar is PROGRAM_PARAM_NAME_PATTERN, identical to workflow params (D2-N3, D3-N1)", () => {
    expect(PROGRAM_PARAM_NAME_PATTERN.test("scope")).toBe(true);
    expect(PROGRAM_PARAM_NAME_PATTERN.test("scope_2")).toBe(true);
    expect(PROGRAM_PARAM_NAME_PATTERN.test("2scope")).toBe(false);
    expect(PROGRAM_PARAM_NAME_PATTERN.test("my-scope")).toBe(false);

    expect(() =>
      parseTaskSourceV4Document(v4Doc({ uses: "commands/review", inputs: { scope_2: { type: "string" } } }), {
        filePath: "/x.yml",
      }),
    ).not.toThrow();
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", inputs: { "my-scope": { type: "string" } } }), {
          filePath: "/x.yml",
        }),
      /my-scope/,
    );
  });

  test("one declaration's serialized schema size is bounded by WORKFLOW_MAX_SCHEMA_BYTES, reused (D2-N3)", () => {
    const bigEnum = Array.from({ length: 1024 }, (_, i) => `${"x".repeat(280)}${i}`);
    expect(JSON.stringify(bigEnum).length).toBeGreaterThan(WORKFLOW_MAX_SCHEMA_BYTES);
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(
          v4Doc({ uses: "commands/review", inputs: { big: { type: "string", enum: bigEnum } } }),
          { filePath: "/x.yml" },
        ),
      /big/,
    );
  });

  describe("secret-shaped default warning (D2-N3, B-22)", () => {
    let warnCalls: string[] = [];

    beforeEach(() => {
      warnCalls = [];
      overrideSeam(_setWarnSinkForTests, (level, args) => {
        if (level !== "warn") return;
        warnCalls.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
      });
    });

    test("a secret-shaped default warns via warn() — same detector, same phrasing family as workflow params — and parsing still succeeds", () => {
      const secretValue = `sk-${"A".repeat(40)}`;
      const derivedWarnings = detectSecretShapedParams({ ticket: secretValue });
      expect(derivedWarnings.length).toBeGreaterThan(0);

      const doc = parseTaskSourceV4Document(
        v4Doc({ uses: "commands/review", inputs: { ticket: { type: "string", default: secretValue } } }),
        { filePath: "/x.yml" },
      );
      expect(doc.inputs?.ticket?.default).toBe(secretValue);
      expect(warnCalls.join("\n")).toContain(derivedWarnings[0] as string);
    });

    test("an ordinary (non-secret-shaped) default does not warn", () => {
      parseTaskSourceV4Document(
        v4Doc({ uses: "commands/review", inputs: { scope: { type: "string", default: "changed" } } }),
        { filePath: "/x.yml" },
      );
      expect(warnCalls).toEqual([]);
    });
  });
});

// ── Optional output schema ──────────────────────────────────────────────────

describe("task source v4 — optional output schema", () => {
  test("a valid bounded JSON Schema is accepted and preserved verbatim", () => {
    const schema = { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] };
    const doc = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", output: schema }), { filePath: "/x.yml" });
    expect(doc.output).toEqual(schema);
  });

  test("a malformed output schema is TASK_SOURCE_INVALID, re-rooted at 'output' (not 'akm.outputSchema')", () => {
    const derivedIssues = checkJsonSchemaDefinition({ type: "not-a-real-type" });
    expect(derivedIssues[0]?.kind).toBe("malformed");
    expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", output: { type: "not-a-real-type" } }), {
          filePath: "/x.yml",
        }),
      /output/i,
    );
  });

  // Only command invocations consume output: — the prepare seam forwards it into
  // prepareCommandInvocation (src/tasks/prepare/prepare.ts) for uses:
  // commands/<ref> and uses: akm/command, while run:/scripts//workflows/
  // executions carry no output schema anywhere (run-native-task.ts decides status
  // from the exit code alone; the workflow arm freezes a child plan without one).
  // An authored output: on those kinds would be a silently unenforced contract,
  // so parse fails closed, mirroring with:'s target-kind restriction.
  test.each([
    ["run: echo hi", { run: "echo hi" }],
  ])("output: on a non-command target (%s) is TASK_SOURCE_INVALID at field path output, naming the restriction", (_label, target) => {
    const error = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ ...target, output: { type: "object" } }), { filePath: "/x.yml" }),
      [/output/i, /command target/i],
    );
    expectTopLevelFieldPath(error.message, "output");
  });

  test("output: stays legal on uses: akm/command — the builtin command target consumes it too", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ uses: "akm/command", with: { content: "hi" }, output: { type: "object" } }),
      { filePath: "/x.yml" },
    );
    expect(doc.output).toEqual({ type: "object" });
  });
});

// ── Top-level execution controls (same extracted helpers as v3, so ───────────
// ── accept/reject sets and detail texts match v3's BY CONSTRUCTION) ─────────

describe("task source v4 — top-level execution controls", () => {
  test("timeout accepts a common duration string and rejects a value beyond EXECUTION_MAX_TIMEOUT_MS, at the TOP-LEVEL field path (not akm.timeout)", () => {
    const ok = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", timeout: "20m" }), { filePath: "/x.yml" });
    expect(ok.execution.timeout).toBe("20m");
    const error = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", timeout: EXECUTION_MAX_TIMEOUT_MS + 1 }), {
          filePath: "/x.yml",
        }),
      /timeout/i,
    );
    // v3's parseTimeout hardcodes ["akm", "timeout"] — a v4 implementation that
    // reuses it unmodified would render "akm.timeout …", which /timeout/i alone
    // cannot distinguish from the correct top-level "timeout …".
    expectTopLevelFieldPath(error.message, "timeout");
  });

  test("engine/model/agent accept null and reject an empty string, each at its OWN top-level field path (not akm.<key>)", () => {
    const ok = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", engine: null, model: null, agent: null }), {
      filePath: "/x.yml",
    });
    expect(ok.execution.engine).toBeNull();
    expect(ok.execution.model).toBeNull();
    expect(ok.execution.agent).toBeNull();

    // v3's nullableSelector hardcodes ["akm", key] for every one of
    // engine/model/agent — pin all three field paths individually, not just
    // "engine".
    const engineError = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", engine: "" }), { filePath: "/x.yml" }),
      /engine/i,
    );
    expectTopLevelFieldPath(engineError.message, "engine");

    const modelError = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", model: "" }), { filePath: "/x.yml" }),
      /model/i,
    );
    expectTopLevelFieldPath(modelError.message, "model");

    const agentError = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", agent: "" }), { filePath: "/x.yml" }),
      /agent/i,
    );
    expectTopLevelFieldPath(agentError.message, "agent");
  });

  test("redact rejects duplicate names and more than TASK_V3_MAX_REDACT_NAMES entries, at the TOP-LEVEL field path (not akm.redact)", () => {
    const ok = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", redact: ["TOKEN"] }), {
      filePath: "/x.yml",
    });
    expect(ok.execution.redact).toEqual(["TOKEN"]);
    const duplicateError = expectTaskSourceInvalid(
      () =>
        parseTaskSourceV4Document(v4Doc({ uses: "commands/review", redact: ["TOKEN", "TOKEN"] }), {
          filePath: "/x.yml",
        }),
      /duplicate/i,
    );
    // v3's redact duplicate/bound checks hardcode ["akm", "redact"] — pin the
    // top-level field path.
    expectTopLevelFieldPath(duplicateError.message, "redact");
    const tooMany = Array.from({ length: TASK_V3_MAX_REDACT_NAMES + 1 }, (_, i) => `TOKEN_${i}`);
    const tooManyError = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", redact: tooMany }), { filePath: "/x.yml" }),
      new RegExp(String(TASK_V3_MAX_REDACT_NAMES)),
    );
    expectTopLevelFieldPath(tooManyError.message, "redact");
  });

  test("env rejects an invalid environment variable name", () => {
    const ok = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", env: { MODE: "safe" } }), {
      filePath: "/x.yml",
    });
    expect(ok.env).toEqual({ MODE: "safe" });
    expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", env: { "1bad": "x" } }), { filePath: "/x.yml" }),
      /env/i,
    );
  });

  test("maxSteps requires a positive safe integer, at the TOP-LEVEL field path (not akm.maxSteps)", () => {
    const ok = parseTaskSourceV4Document(v4Doc({ uses: "commands/review", maxSteps: 8 }), { filePath: "/x.yml" });
    expect(ok.execution.maxSteps).toBe(8);
    const error = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", maxSteps: 0 }), { filePath: "/x.yml" }),
      /maxSteps/i,
    );
    // v3 hardcodes ["akm", "maxSteps"] — pin the top-level field path.
    expectTopLevelFieldPath(error.message, "maxSteps");
  });

  test("when_to_use, tags, inference, and tools survive as top-level v4 keys with identical validation (D2-N7)", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({
        uses: "commands/review",
        when_to_use: "Run during release review",
        tags: ["contract", "review"],
        inference: { seed: 7 },
        tools: ["read", "grep"],
      }),
      { filePath: "/x.yml" },
    );
    expect(doc.when_to_use).toBe("Run during release review");
    expect(doc.tags).toEqual(["contract", "review"]);
    expect(doc.execution.inference).toEqual({ seed: 7 });
    expect(doc.execution.tools).toEqual(["read", "grep"]);
  });

  test("an invalid tags: value is TASK_SOURCE_INVALID at the TOP-LEVEL field path 'tags' (not akm.tags, D2-N7)", () => {
    // v3 hardcodes ["akm", "tags"] — pin the top-level field path.
    const error = expectTaskSourceInvalid(
      () => parseTaskSourceV4Document(v4Doc({ uses: "commands/review", tags: "not-an-array" }), { filePath: "/x.yml" }),
      /tags/i,
    );
    expectTopLevelFieldPath(error.message, "tags");
  });

  test("name/description round-trip as top-level v4 keys (description is NOT re-homed under akm here, unlike v3)", () => {
    const doc = parseTaskSourceV4Document(
      v4Doc({ uses: "commands/review", name: "Review code", description: "Reviews the diff" }),
      { filePath: "/x.yml" },
    );
    expect(doc.name).toBe("Review code");
    expect(doc.description).toBe("Reviews the diff");
  });
});

// ── Fixture-driven round trip (tests/fixtures/execution-contracts/tasks/v4/) ──

describe("task source v4 fixtures (tests/fixtures/execution-contracts/tasks/v4/) parse per manifest.json's raw-parse expectations", () => {
  test.each(
    MANIFEST_FIXTURES.map((fixture) => [fixture.id, fixture] as const),
  )("%s parses to the shape manifest.json pins", (_id, fixture) => {
    const result = parseFixture(fixture);
    expect(result.manualOnly).toBe(fixture.expected.manualOnly as never);
    expect(result.schedule).toEqual(fixture.expected.schedule as never);
    expect(result.target).toEqual(fixture.expected.target as never);
    expect(result.inputs).toEqual(fixture.expected.inputs as never);
    expect(result.output).toEqual(fixture.expected.output as never);
    expect(result.env).toEqual(fixture.expected.env as never);
    expect(result.execution).toEqual(fixture.expected.execution ?? {});
    expect(Object.isFrozen(result)).toBe(true);
  });
});
