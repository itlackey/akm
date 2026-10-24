// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `src/tasks/source/bounded-document.ts` — the version-agnostic bounded YAML
 * front end — renders every source label its callers supply through the SAME
 * shared funnel.
 *
 * Two DISTINCT labels are in real production use, and this file pins both:
 *
 *   1. `"task source"` — `src/tasks/source/parse-task-source.ts`'s own
 *      version-agnostic front end, for a failure that happens BEFORE the
 *      document's `version:` is even known.
 *   2. `"task source v4"` — `src/tasks/source/task-source-v4.ts`'s own
 *      internal label, for a field-level failure once routing has confirmed
 *      `version: 4`.
 *
 * The first describe block below calls `assertBoundedTaskYamlDocument`
 * directly with `sourceLabel: "task source"`, and cross-checks it against
 * real production `parseTaskSource` output on the identical hostile YAML —
 * so "the front end's rendering is unchanged by using this label" is proven
 * by equality against production rather than a hand-copied string that could
 * drift. The second half of that same describe block, and the `sourceError`
 * describe block below it, prove the two labels are a PURE substitution —
 * same wording, ordering, and file/line suffix — by running the identical
 * input through the identical assertion with only the label swapped.
 */

import { describe, expect, test } from "bun:test";
import { LineCounter, parseDocument } from "yaml";
import { UsageError } from "../../src/core/errors";
import {
  assertBoundedTaskYamlDocument,
  sourceError,
  TASK_V3_MAX_STRING_BYTES,
} from "../../src/tasks/source/bounded-document";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";
import { parseTaskSourceV4, parseTaskSourceV4Document } from "../../src/tasks/source/task-source-v4";

/** A hostile-YAML fixture: an aliased mapping. */
const ALIASED_YAML = "version: 4\nuses: commands/a\ninputs: &a {}\ncopy: *a\n";
const FILE_PATH = "/bundle/tasks/hostile.yml";

/** Catch a synchronous throw once and return it (never a `.toThrow()` substring match — every pin below is byte-exact). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("assertBoundedTaskYamlDocument — the sourceLabel seam renders 'task source' identically to real production parseTaskSource", () => {
  test("the front-end-labeled call is byte-identical to real production parseTaskSource on the identical hostile YAML", () => {
    const productionError = caught(() => parseTaskSource({ yaml: ALIASED_YAML, filePath: FILE_PATH }));
    expect(productionError).toBeInstanceOf(UsageError);

    const lineCounter = new LineCounter();
    const document = parseDocument(ALIASED_YAML, { lineCounter, uniqueKeys: true });
    const directError = caught(() =>
      assertBoundedTaskYamlDocument(document, { filePath: FILE_PATH, sourceLabel: "task source", lineCounter }),
    );
    expect(directError).toBeInstanceOf(UsageError);

    expect((directError as UsageError).message).toBe((productionError as UsageError).message);
    expect((directError as UsageError).message).toStartWith("Invalid task source at");
  });

  test("the SAME hostile YAML, run through the SAME assertion with sourceLabel: 'task source v4', renders only the label swapped — byte-exact otherwise", () => {
    const frontEndLineCounter = new LineCounter();
    const frontEndDocument = parseDocument(ALIASED_YAML, { lineCounter: frontEndLineCounter, uniqueKeys: true });
    const frontEndError = caught(() =>
      assertBoundedTaskYamlDocument(frontEndDocument, {
        filePath: FILE_PATH,
        sourceLabel: "task source",
        lineCounter: frontEndLineCounter,
      }),
    ) as UsageError;

    // A FRESH parse + LineCounter: assertBoundedTaskYamlDocument mutates
    // nothing about the yaml package's own document/counter, but a second
    // traversal of the SAME document instance is not part of its contract —
    // parse again so this call is unambiguously independent of the first.
    const v4LineCounter = new LineCounter();
    const v4Document = parseDocument(ALIASED_YAML, { lineCounter: v4LineCounter, uniqueKeys: true });
    const v4Error = caught(() =>
      assertBoundedTaskYamlDocument(v4Document, {
        filePath: FILE_PATH,
        sourceLabel: "task source v4",
        lineCounter: v4LineCounter,
      }),
    ) as UsageError;

    expect(v4Error.message).toStartWith("Invalid task source v4 at");
    expect(v4Error.message).not.toBe(frontEndError.message);
    // The ONLY difference between the two renderings is the label text
    // itself — proves sourceLabel is a pure substitution, not a hint that
    // also happens to change wording, ordering, or the file/line suffix.
    expect(v4Error.message).toBe(frontEndError.message.replace("Invalid task source", "Invalid task source v4"));
    expect(v4Error.code).toBe(frontEndError.code);
  });
});

describe("sourceError — the per-field funnel renders both source labels via its sourceLabel context field (D2-N4)", () => {
  test("sourceLabel: 'task source' renders the 'Invalid task source at …' shape", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task source" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task source at /x.yml: foo bar.");
  });

  test("sourceLabel: 'task source v4' renders the 'Invalid task source v4 at …' shape — same field path, same detail, only the label differs", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: foo bar.");
  });

  test("a line number, when the context supplies lineAt, is rendered identically regardless of label", () => {
    const lineAt = () => 3;
    const frontEndError = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    const v4Error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    expect(frontEndError.message).toBe("Invalid task source at /x.yml:3: foo bar.");
    expect(v4Error.message).toBe("Invalid task source v4 at /x.yml:3: foo bar.");
  });

  test("an empty field path renders the '$' root selector for both labels (B-16's shape)", () => {
    const error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, [], "top-level detail."),
    );
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: $ top-level detail.");
  });
});

/**
 * Hostile input and resource bounds for this file's bounded-document front end
 * (assertBoundedTaskYamlDocument, cloneBoundedJson, readBoundedTaskSourceYaml),
 * which parseTaskSourceV4 / parseTaskSourceV4Document route through on every
 * parse: the Proxy / prototype / accessor / cycle / depth / byte-bound /
 * hostile-YAML guards.
 *
 * Every hostile-shape assertion fires inside `cloneBoundedJson`'s recursive
 * clone/bound pass (object fixtures) or `assertBoundedTaskYamlDocument`'s AST
 * walk (YAML fixtures) — both run BEFORE `parseTaskSourceV4Document` ever
 * reaches target/field semantics (`parseTarget`'s with-on-command guard
 * included), so which top-level field a hostile value sits under does not
 * change what throws first. Task source v4 has no mandatory scheduling field,
 * so a bare `{version: 4, uses: "commands/x"}` is already a structurally valid
 * base.
 */
describe("task source v4 hostile input and resource bounds", () => {
  test("rejects custom prototypes, accessors, non-enumerable fields, and symbols without invoking code", () => {
    expect(() => parseTaskSourceV4Document(new Date(), { filePath: "bad.yml" })).toThrow(/plain|null prototype/i);

    let reads = 0;
    const accessor = Object.defineProperty({ version: 4, uses: "commands/x" }, "uses", {
      enumerable: true,
      get() {
        reads += 1;
        return "commands/x";
      },
    });
    expect(() => parseTaskSourceV4Document(accessor, { filePath: "bad.yml" })).toThrow(/accessor|data property/i);
    expect(reads).toBe(0);

    const hidden = Object.defineProperty({ version: 4, uses: "commands/x" }, "hidden", {
      value: true,
      enumerable: false,
    });
    expect(() => parseTaskSourceV4Document(hidden, { filePath: "bad.yml" })).toThrow(/non-enumerable|enumerable/i);
    expect(() =>
      parseTaskSourceV4Document({ version: 4, uses: "commands/x", [Symbol("extra")]: true }, { filePath: "bad.yml" }),
    ).toThrow(/symbol/i);
  });

  test("rejects proxies before invoking any proxy trap", () => {
    let traps = 0;
    const proxy = new Proxy(
      { version: 4, uses: "commands/x" },
      {
        getOwnPropertyDescriptor() {
          traps += 1;
          throw new Error("proxy trap must not run");
        },
        ownKeys() {
          traps += 1;
          throw new Error("proxy trap must not run");
        },
      },
    );
    expect(() => parseTaskSourceV4Document(proxy, { filePath: "bad.yml" })).toThrow(/Proxy/i);
    expect(traps).toBe(0);
  });

  test("rejects nested hostile descriptors, sparse arrays, cycles, and excessive depth", () => {
    const nested = Object.create({ inherited: true }) as Record<string, unknown>;
    nested.value = "x";
    expect(() =>
      parseTaskSourceV4Document({ version: 4, uses: "commands/x", with: { nested } }, { filePath: "bad.yml" }),
    ).toThrow(/plain|null prototype/i);

    const sparse = new Array(2);
    sparse[1] = "x";
    expect(() =>
      parseTaskSourceV4Document({ version: 4, uses: "commands/x", tags: sparse }, { filePath: "bad.yml" }),
    ).toThrow(/dense/i);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() =>
      parseTaskSourceV4Document({ version: 4, uses: "commands/x", with: cycle }, { filePath: "bad.yml" }),
    ).toThrow(/cycle/i);

    let deep: unknown = "leaf";
    for (let index = 0; index < 70; index += 1) deep = { child: deep };
    expect(() =>
      parseTaskSourceV4Document({ version: 4, uses: "commands/x", with: { deep } }, { filePath: "bad.yml" }),
    ).toThrow(/depth|nesting/i);
  });

  test.each([
    "version: 4\nuses: commands/a\nuses: commands/b\n",
    ALIASED_YAML,
    "version: 4\nuses: commands/a\ndescription: !custom 'x'\n",
    "version: 4\nuses: commands/a\nenv:\n  <<: { FOO: 'bar' }\n",
    "? [complex, key]\n: value\nversion: 4\nuses: commands/a\n",
  ])("rejects hostile YAML without expanding it", (yaml) => {
    expect(() => parseTaskSourceV4({ yaml, filePath: "/bundle/tasks/hostile.yml" })).toThrow();
  });

  test("bounds YAML depth, mapping width, and aggregate AST nodes before toJS", () => {
    let deep = "leaf: value\n";
    for (let index = 0; index < 70; index += 1) deep = `level${index}:\n${deep.replace(/^/gm, "  ")}`;
    expect(() =>
      parseTaskSourceV4({
        yaml: `version: 4\nuses: commands/a\nwith:\n${deep.replace(/^/gm, "  ")}`,
        filePath: "/bundle/tasks/deep.yml",
      }),
    ).toThrow(/depth|nesting/i);

    const wide = Array.from({ length: 257 }, (_, index) => `  k${index}: ${index}`).join("\n");
    expect(() =>
      parseTaskSourceV4({
        yaml: `version: 4\nuses: commands/a\nwith:\n${wide}\n`,
        filePath: "/bundle/tasks/wide.yml",
      }),
    ).toThrow(/mapping|key|256/i);

    const manyNodes = Array.from(
      { length: 220 },
      (_, index) => `  k${index}: [${Array.from({ length: 50 }, (_unused, item) => item).join(", ")}]`,
    ).join("\n");
    expect(() =>
      parseTaskSourceV4({
        yaml: `version: 4\nuses: commands/a\nwith:\n${manyNodes}\n`,
        filePath: "/bundle/tasks/nodes.yml",
      }),
    ).toThrow(/node|10000/i);
  });

  test("bounds mapping-key strings before object publication and YAML expansion", () => {
    const oversizedKey = "k".repeat(TASK_V3_MAX_STRING_BYTES + 1);
    expect(() =>
      parseTaskSourceV4Document(
        { version: 4, uses: "commands/a", with: { [oversizedKey]: true } },
        { filePath: "/bundle/tasks/key-object.yml" },
      ),
    ).toThrow(/key|string|262144|byte/i);

    const yaml = JSON.stringify({ version: 4, uses: "commands/a", with: { [oversizedKey]: true } });
    expect(() => parseTaskSourceV4({ yaml, filePath: "/bundle/tasks/key-yaml.yml" })).toThrow(
      /key|string|262144|byte/i,
    );
  });

  test("source-located errors include the file and structural path", () => {
    expect(() =>
      parseTaskSourceV4({
        yaml: "version: 4\nuses: commands/a\ninputs:\n  foo:\n    bogus: true\n",
        filePath: "/bundle/tasks/located.yml",
      }),
    ).toThrow(/\/bundle\/tasks\/located\.yml.*inputs\.foo\.bogus|inputs\.foo\.bogus.*\/bundle\/tasks\/located\.yml/i);
  });
});
