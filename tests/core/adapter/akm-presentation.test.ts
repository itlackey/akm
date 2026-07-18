// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-C gate — the `TYPE_PRESENTATION` renderer/action data table
 * (`src/core/type-presentation.ts`), implementing
 * `docs/design/akm-0.9.0-bundle-adapter-spec.md` §2.
 *
 * §2 makes renderer/action a DATA TABLE keyed on the open `type`. This suite
 * pins that `TYPE_PRESENTATION` reproduces the renderer NAMES + action-builder
 * OUTPUTS VERBATIM — chunk-3 made `TYPE_PRESENTATION` the SINGLE SOURCE OF TRUTH
 * (the old mutable renderer/action registry it was ported from is deleted), so
 * this suite now holds an INDEPENDENT FROZEN SNAPSHOT of those exact values
 * (`EXPECTED_RENDERER` / `ACTION_BUILDERS` below, copied verbatim from the
 * retired `asset-registry.ts`) and asserts the live table cannot drift from it —
 * and that every known type's renderer NAME agrees with the FROZEN Chunk-0b
 * recognition golden. The fixture/goldens are not modified.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { KNOWN_TYPES } from "../../../src/core/recognition-util";
import { presentationFor, TYPE_PRESENTATION } from "../../../src/core/type-presentation";

// Frozen snapshot of the renderer names the retired `asset-registry.ts`
// `TYPE_TO_RENDERER` held — the drift-guard oracle `TYPE_PRESENTATION` must
// reproduce for every known type.
const TYPE_TO_RENDERER: Record<string, string> = {
  script: "script-source",
  skill: "skill-md",
  command: "command-md",
  agent: "agent-md",
  knowledge: "knowledge-md",
  lesson: "lesson-md",
  memory: "memory-md",
  workflow: "workflow-md",
  env: "env-file",
  secret: "secret-file",
  wiki: "wiki-md",
  task: "task-yaml",
  session: "session-md",
  fact: "fact-md",
  instruction: "knowledge-md",
};

/** POSIX-shell single-quote — copied verbatim from the retired asset-registry action-builder chain. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function buildWorkflowAction(ref: string): string {
  return `Resume the active run or start a new run with \`akm workflow next ${shellQuote(ref)}\`.`;
}

// Frozen snapshot of the action builders the retired `asset-registry.ts`
// `ACTION_BUILDERS` held — reproduced verbatim so this suite pins
// `TYPE_PRESENTATION`'s action outputs against an independent copy.
const ACTION_BUILDERS: Record<string, (ref: string) => string> = {
  script: (ref) => `akm show ${ref} -> execute the run command`,
  skill: (ref) => `akm show ${ref} -> follow the instructions`,
  command: (ref) => `akm show ${ref} -> fill placeholders and dispatch`,
  agent: (ref) => `akm show ${ref} -> dispatch with full prompt`,
  knowledge: (ref) => `akm show ${ref} -> read reference material`,
  lesson: (ref) => `akm show ${ref} -> read the lesson and apply when_to_use`,
  memory: (ref) => `akm show ${ref} -> recall context`,
  workflow: (ref) => buildWorkflowAction(ref),
  env: (ref) =>
    `akm show ${ref} -> inspect key names; akm env run ${ref} -- <command> -> run with the whole .env injected (prefer --clean to minimize inherited parent env; child stdout is not redacted). akm env export ${ref} --out <file> writes a sourceable script (values to a file, not stdout).`,
  secret: (ref) =>
    `akm show ${ref} -> name only (value never shown); akm secret path ${ref} -> file path; akm secret run ${ref} <VAR> -- <command> -> run with value injected into $VAR`,
  wiki: (ref) => `akm show ${ref} -> read the wiki page`,
  task: (ref) =>
    `akm tasks show ${ref.replace(/^task:/, "")} -> inspect; akm tasks run <id> -> run now; akm tasks remove <id> -> unschedule`,
  session: (ref) =>
    `akm show ${ref} -> read the session summary; follow the \`access\` frontmatter to open the raw log at \`log_path\``,
  fact: (ref) => `akm show ${ref} -> read the stash fact and apply it as durable context`,
  instruction: (ref) => `akm show ${ref} -> read the project instructions`,
};

interface RecognitionGolden {
  byRelPath: Record<string, { type: string; renderer: string }>;
}
const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
) as RecognitionGolden;

/** A handful of representative refs to exercise every action-builder branch (incl. the `task:` strip). */
const SAMPLE_REFS = ["personal//knowledge/http-caching", "team//workflows/release", "task:deploy", "b//x"];

describe("TYPE_PRESENTATION — renderer NAMES reproduce TYPE_TO_RENDERER verbatim (§2)", () => {
  test("every KNOWN_TYPE's renderer equals the live TYPE_TO_RENDERER entry", () => {
    for (const type of KNOWN_TYPES) {
      expect(TYPE_PRESENTATION[type].renderer, `renderer for ${type}`).toBe(TYPE_TO_RENDERER[type]);
    }
  });

  test("presentationFor(type).renderer equals TYPE_TO_RENDERER for every KNOWN_TYPE", () => {
    for (const type of KNOWN_TYPES) {
      expect(presentationFor(type).renderer, `presentationFor(${type}).renderer`).toBe(TYPE_TO_RENDERER[type]);
    }
  });

  test("the 6 static-only mappings (script/skill/command/agent/knowledge/memory) are present", () => {
    // These carried NO `rendererName` on their old asset-spec (§6) — they lived
    // only in TYPE_TO_RENDERER/ACTION_BUILDERS, so their presence is the whole
    // point of the port.
    const expected: Record<string, string> = {
      script: "script-source",
      skill: "skill-md",
      command: "command-md",
      agent: "agent-md",
      knowledge: "knowledge-md",
      memory: "memory-md",
    };
    for (const [type, renderer] of Object.entries(expected)) {
      expect(TYPE_PRESENTATION[type as keyof typeof TYPE_PRESENTATION].renderer).toBe(renderer);
      expect(TYPE_PRESENTATION[type as keyof typeof TYPE_PRESENTATION].action).toBeDefined();
    }
  });
});

describe("TYPE_PRESENTATION — action builders reproduce ACTION_BUILDERS verbatim (§2)", () => {
  test("presentationFor(type).action(ref) equals ACTION_BUILDERS[type](ref) for every KNOWN_TYPE and sample ref", () => {
    for (const type of KNOWN_TYPES) {
      const action = presentationFor(type).action;
      expect(action, `action defined for ${type}`).toBeDefined();
      for (const ref of SAMPLE_REFS) {
        expect(action?.(ref), `action(${ref}) for ${type}`).toBe(ACTION_BUILDERS[type](ref));
      }
    }
  });

  test("the workflow action reproduces buildWorkflowAction (single-quoted ref, resume/next form)", () => {
    const out = presentationFor("workflow").action?.("team//workflows/release");
    expect(out).toBe("Resume the active run or start a new run with `akm workflow next 'team//workflows/release'`.");
    expect(out).toBe(ACTION_BUILDERS.workflow("team//workflows/release"));
  });

  test("the task action reproduces the `task:` prefix strip", () => {
    expect(presentationFor("task").action?.("task:deploy")).toBe(ACTION_BUILDERS.task("task:deploy"));
    expect(presentationFor("task").action?.("task:deploy")).toContain("akm tasks show deploy ->");
  });
});

describe("TYPE_PRESENTATION — renderer NAMES agree with the frozen recognition golden (§2)", () => {
  test("every recognition-golden entry's renderer matches presentationFor(type).renderer", () => {
    let asserted = 0;
    for (const [relPath, entry] of Object.entries(RECOGNITION_GOLDEN.byRelPath)) {
      // The YAML workflow *program* uses a distinct renderer FORM
      // (workflow-program-yaml), not the `workflow` type's default renderer —
      // it is not a TYPE_PRESENTATION entry (the table keys on `type`, and
      // workflow's type-default is workflow-md). Documented §2 exception.
      if (entry.renderer === "workflow-program-yaml") {
        expect(entry.type).toBe("workflow");
        continue;
      }
      expect(presentationFor(entry.type).renderer, `renderer for ${relPath} (${entry.type})`).toBe(entry.renderer);
      asserted += 1;
    }
    // 14 type-representative entries pinned (the 15th is the program-form exception).
    expect(asserted).toBe(14);
  });
});

describe("presentationFor — foreign/unknown fallback is renderer-less generic (unchanged, §2)", () => {
  test("an unknown type resolves to the generic { label: 'Asset' } with no renderer/action", () => {
    const generic = presentationFor("some-third-party-okf-type");
    expect(generic).toEqual({ label: "Asset" });
    expect(generic.renderer).toBeUndefined();
    expect(generic.action).toBeUndefined();
  });
});
