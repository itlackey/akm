// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * WI-C gate — the `TYPE_PRESENTATION` renderer data table
 * (`src/core/type-presentation.ts`), implementing
 * `a retired design doc` §2.
 *
 * §2 makes renderer a DATA TABLE keyed on the open `type`. This suite
 * pins that `TYPE_PRESENTATION` reproduces the renderer NAMES VERBATIM — chunk-3 made `TYPE_PRESENTATION` the SINGLE SOURCE OF TRUTH
 * (the old mutable renderer registry it was ported from is deleted), so
 * this suite now holds an INDEPENDENT FROZEN SNAPSHOT of those exact values
 * (`TYPE_TO_RENDERER` below, copied verbatim from the
 * retired `asset-registry.ts`) and asserts the live table cannot drift from it —
 * and that every known type's renderer NAME agrees with the FROZEN Chunk-0b
 * recognition golden. The fixture/goldens are not modified.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { KNOWN_TYPES } from "../../../src/core/recognition-util";
import { allowsFragmentRef, presentationFor, TYPE_PRESENTATION } from "../../../src/core/type-presentation";

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
  task: "task-yaml",
  session: "session-md",
  fact: "fact-md",
  instruction: "knowledge-md",
  rule: "knowledge-md",
};

interface RecognitionGolden {
  byRelPath: Record<string, { type: string; renderer: string }>;
}
const RECOGNITION_GOLDEN = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../fixtures/goldens/recognition/all-types.json"), "utf8"),
) as RecognitionGolden;

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
    // only in TYPE_TO_RENDERER, so their presence is the whole
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
    }
  });
});

describe("TYPE_PRESENTATION — fragment refs follow the parent-action contract", () => {
  test("executable and instruction-bearing actions never receive an opaque Markdown selector", () => {
    for (const type of ["workflow", "command", "agent", "script", "task", "skill", "instruction"]) {
      expect(allowsFragmentRef(type), `${type} must keep its complete parent ref`).toBe(false);
    }
    for (const type of ["knowledge", "memory", "lesson", "fact", "session"]) {
      expect(allowsFragmentRef(type), `${type} can expose a read selector`).toBe(true);
    }
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
    // 13 type-representative entries pinned (wiki retired in chunk 4; the
    // workflow-program-yaml program-form is the skipped exception).
    expect(asserted).toBe(13);
  });
});

describe("presentationFor — foreign/unknown fallback is renderer-less generic (unchanged, §2)", () => {
  test("an unknown type resolves to the generic { label: 'Asset' } with no renderer", () => {
    const generic = presentationFor("some-third-party-okf-type");
    expect(generic).toEqual({ label: "Asset" });
    expect(generic.renderer).toBeUndefined();
  });
});
