// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The `akm ui` line and word diff (src/assets/ui/diff.js): that a small edit stays small, that changed lines pair up
 * with word highlights, and that line endings and oversized input are handled. Pure functions, no browser.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

type Cell = { n: number; text: string; marks: Array<[string, boolean]> | null };
type Row = { kind: "ctx" | "del" | "add" | "mod"; block: number | null; left: Cell | null; right: Cell | null };
type Part = { type: "hunk" | "gap"; rows: Row[] };
type Model = { rows: Row[]; parts: Part[]; added: number; removed: number; same: boolean };
type Op = { type: "eq" | "del" | "add"; a: number | null; b: number | null };

const mod = (await import(path.resolve(import.meta.dir, "../src/assets/ui/diff.js"))) as {
  buildDiff: (before: string | null, after: string | null) => Model | null;
  lineOps: (a: string[], b: string[]) => Op[] | null;
  splitLines: (text: string) => string[];
  wordMarks: (a: string, b: string) => [Array<[string, boolean]>, Array<[string, boolean]>] | null;
  newFileRows: (after: string) => Row[];
  MAX_LINES: number;
  MAX_EDITS: number;
};

const numbered = (count: number, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const hunks = (model: Model) => model.parts.filter((p) => p.type === "hunk");
const changed = (rows: Row[]) => rows.filter((r) => r.kind !== "ctx");

describe("splitLines", () => {
  test("LF and CRLF end a line; the final newline is not a line", () => {
    expect(mod.splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(mod.splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(mod.splitLines("a\r\n\r\nb")).toEqual(["a", "", "b"]);
    expect(mod.splitLines("")).toEqual([]);
  });
});

describe("lineOps (Myers)", () => {
  test("applying the script to a reproduces b, and the number of edits is minimal on a known case", () => {
    const a = "A B C A B B A".split(" ");
    const b = "C B A B A C".split(" ");
    const ops = mod.lineOps(a, b) as Op[];
    const rebuilt = ops.filter((o) => o.type !== "del").map((o) => b[o.b as number]);
    expect(rebuilt).toEqual(b);
    expect(ops.filter((o) => o.type === "eq").map((o) => a[o.a as number])).toEqual(
      ops.filter((o) => o.type === "eq").map((o) => b[o.b as number]),
    );
    // The classic Myers example: shortest edit script has 5 edits.
    expect(ops.filter((o) => o.type !== "eq")).toHaveLength(5);
  });

  test("random inputs: the script rebuilds b from a and keeps only common lines as eq", () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 60; round++) {
      const a = Array.from({ length: rand(25) }, () => String(rand(5)));
      const b = Array.from({ length: rand(25) }, () => String(rand(5)));
      const ops = mod.lineOps(a, b) as Op[];
      const fromA = ops.filter((o) => o.type !== "add").map((o) => a[o.a as number]);
      const fromB = ops.filter((o) => o.type !== "del").map((o) => b[o.b as number]);
      expect(fromA).toEqual(a);
      expect(fromB).toEqual(b);
    }
  });
});

describe("buildDiff", () => {
  test("identical texts have no change and no hunks", () => {
    const text = `${numbered(50).join("\n")}\n`;
    const model = mod.buildDiff(text, text) as Model;
    expect(model.same).toBe(true);
    expect(hunks(model)).toHaveLength(0);
    expect(model.added + model.removed).toBe(0);
  });

  test("one inserted line in a 50-line file is one hunk with just that line added, at the right line numbers", () => {
    const before = numbered(50);
    const after = [...before.slice(0, 20), "inserted", ...before.slice(20)];
    const model = mod.buildDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`) as Model;
    expect(model.added).toBe(1);
    expect(model.removed).toBe(0);
    expect(hunks(model)).toHaveLength(1);
    const hunk = hunks(model)[0] as Part;
    const edits = changed(hunk.rows);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ kind: "add", left: null, right: { n: 21, text: "inserted" } });
    // Three lines of context on each side, numbered on both sides.
    expect(hunk.rows).toHaveLength(7);
    expect(hunk.rows[0]).toMatchObject({ kind: "ctx", left: { n: 18 }, right: { n: 18 } });
    expect(hunk.rows[6]).toMatchObject({
      kind: "ctx",
      left: { n: 23, text: "line 23" },
      right: { n: 24, text: "line 23" },
    });
    // The rest is collapsed behind two gaps.
    expect(model.parts.map((p) => p.type)).toEqual(["gap", "hunk", "gap"]);
    expect((model.parts[0] as Part).rows).toHaveLength(17);
    expect((model.parts[2] as Part).rows).toHaveLength(27);
    expect(model.rows).toHaveLength(51);
  });

  test("a frontmatter field added near the top does not turn the rest of the file into changes", () => {
    const body = numbered(40, "body");
    const before = `---\ndescription: Use rg\n---\n${body.join("\n")}\n`;
    const after = `---\ndescription: Use rg\nwhen_to_use: Searching\n---\n${body.join("\n")}\n`;
    const model = mod.buildDiff(before, after) as Model;
    expect(model.added).toBe(1);
    expect(model.removed).toBe(0);
    expect(changed(model.rows)).toHaveLength(1);
    expect(changed(model.rows)[0]?.right).toMatchObject({ n: 3, text: "when_to_use: Searching" });
  });

  test("a changed line pairs old with new and marks the words that differ", () => {
    const before = ["a", "b", "c", "The quick brown fox", "d", "e"].join("\n");
    const after = ["a", "b", "c", "The quick red fox", "d", "e"].join("\n");
    const model = mod.buildDiff(before, after) as Model;
    const pair = changed(model.rows);
    expect(pair).toHaveLength(1);
    expect(pair[0]).toMatchObject({ kind: "mod", left: { n: 4 }, right: { n: 4 } });
    expect(pair[0]?.left?.marks).toEqual([
      ["The quick ", false],
      ["brown", true],
      [" fox", false],
    ]);
    expect(pair[0]?.right?.marks).toEqual([
      ["The quick ", false],
      ["red", true],
      [" fox", false],
    ]);
  });

  test("a replaced run pairs line by line, extra lines stand alone", () => {
    const model = mod.buildDiff("keep\none\ntwo\nkeep2\n", "keep\nuno\ndos\ntres\nkeep2\n") as Model;
    expect(changed(model.rows).map((r) => r.kind)).toEqual(["mod", "mod", "add"]);
    expect(model.added).toBe(3);
    expect(model.removed).toBe(2);
  });

  test("lines with nothing in common get no word highlights", () => {
    expect(mod.wordMarks("alpha beta", "0123 9876")).toBeNull();
    const model = mod.buildDiff("x\n", "completely different line\n") as Model;
    expect(changed(model.rows)[0]).toMatchObject({ kind: "mod", left: { marks: null }, right: { marks: null } });
  });

  test("CRLF and LF versions of the same lines are the same lines", () => {
    const model = mod.buildDiff("a\r\nb\r\nc\r\n", "a\nb\nc\n") as Model;
    expect(model.same).toBe(true);
    const edited = mod.buildDiff("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n") as Model;
    expect(changed(edited.rows)).toHaveLength(1);
    expect(edited.rows.every((r) => !r.left?.text.includes("\r") && !r.right?.text.includes("\r"))).toBe(true);
  });

  test("a new asset is every line added, numbered from 1", () => {
    const rows = mod.newFileRows("one\ntwo\n");
    expect(rows.map((r) => [r.kind, r.right?.n, r.right?.text, r.left])).toEqual([
      ["add", 1, "one", null],
      ["add", 2, "two", null],
    ]);
    const model = mod.buildDiff(null, "one\ntwo\n") as Model;
    expect(model.added).toBe(2);
    expect(model.removed).toBe(0);
  });

  test("an unchanged run too short to be worth a control stays visible; a longer one is collapsed", () => {
    const before = numbered(30);
    const after = [...before];
    after[5] = "changed A";
    after[16] = "changed B";
    const apart = mod.buildDiff(before.join("\n"), after.join("\n")) as Model;
    // Two lines before the first change are shown, not collapsed; 4 hidden lines between the changes are.
    expect(apart.parts.map((p) => p.type)).toEqual(["hunk", "gap", "hunk", "gap"]);
    expect((apart.parts[1] as Part).rows).toHaveLength(4);
    after[10] = "changed C";
    after[12] = "changed D";
    const close = mod.buildDiff(before.join("\n"), after.join("\n")) as Model;
    expect(close.parts.filter((p) => p.type === "hunk")).toHaveLength(1);
  });

  test("input past the size limits returns null so the caller shows the server's unified diff", () => {
    const big = numbered(mod.MAX_LINES + 1).join("\n");
    expect(mod.buildDiff(big, "x")).toBeNull();
    expect(mod.buildDiff("x", big)).toBeNull();
    // Entirely different content of allowed size exceeds the edit budget.
    const a = Array.from({ length: mod.MAX_EDITS }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: mod.MAX_EDITS }, (_, i) => `b${i}`).join("\n");
    expect(mod.buildDiff(a, b)).toBeNull();
  });

  test("a few thousand lines with scattered edits align quickly", () => {
    const before = numbered(4000);
    const after = [...before];
    for (let i = 100; i < 4000; i += 400) after[i] = `${after[i]} edited`;
    after.splice(2000, 0, "added line");
    const started = performance.now();
    const model = mod.buildDiff(before.join("\n"), after.join("\n")) as Model;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(model.added).toBe(11);
    expect(model.removed).toBe(10);
  });
});
