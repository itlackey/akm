// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// The line and word diff (src/lib/ui/diff.js): a small edit stays small, changed lines pair up with word
// highlights, and line endings and oversized input are handled. Pure functions, no browser.

import assert from "node:assert/strict";
import test from "node:test";
import { buildDiff, lineOps, MAX_EDITS, MAX_LINES, newFileRows, splitLines, wordMarks } from "../src/lib/ui/diff.js";

const numbered = (count, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
const hunks = (model) => model.parts.filter((p) => p.type === "hunk");
const changed = (rows) => rows.filter((r) => r.kind !== "ctx");
/** The listed fields of `actual` equal `expected`, recursively; other fields are not compared. */
const matches = (actual, expected) => {
  if (expected === null || typeof expected !== "object") return assert.equal(actual, expected);
  assert.ok(actual !== null && typeof actual === "object", `expected an object, got ${actual}`);
  for (const [key, value] of Object.entries(expected)) matches(actual[key], value);
};

test("LF and CRLF end a line; the final newline is not a line", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb\r\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\n\r\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("lineOps (Myers) rebuilds b from a with a minimal script on the classic example", () => {
  const a = "A B C A B B A".split(" ");
  const b = "C B A B A C".split(" ");
  const ops = lineOps(a, b);
  assert.deepEqual(
    ops.filter((o) => o.type !== "del").map((o) => b[o.b]),
    b,
  );
  assert.deepEqual(
    ops.filter((o) => o.type === "eq").map((o) => a[o.a]),
    ops.filter((o) => o.type === "eq").map((o) => b[o.b]),
  );
  assert.equal(ops.filter((o) => o.type !== "eq").length, 5);
});

test("lineOps on random inputs rebuilds both sides and keeps only common lines as eq", () => {
  let seed = 7;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 60; round++) {
    const a = Array.from({ length: rand(25) }, () => String(rand(5)));
    const b = Array.from({ length: rand(25) }, () => String(rand(5)));
    const ops = lineOps(a, b);
    assert.deepEqual(
      ops.filter((o) => o.type !== "add").map((o) => a[o.a]),
      a,
    );
    assert.deepEqual(
      ops.filter((o) => o.type !== "del").map((o) => b[o.b]),
      b,
    );
  }
});

test("identical texts have no change and no hunks", () => {
  const text = `${numbered(50).join("\n")}\n`;
  const model = buildDiff(text, text);
  assert.equal(model.same, true);
  assert.equal(hunks(model).length, 0);
  assert.equal(model.added + model.removed, 0);
});

test("one inserted line in a 50-line file is one hunk with just that line, at the right line numbers", () => {
  const before = numbered(50);
  const after = [...before.slice(0, 20), "inserted", ...before.slice(20)];
  const model = buildDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
  assert.equal(model.added, 1);
  assert.equal(model.removed, 0);
  assert.equal(hunks(model).length, 1);
  const hunk = hunks(model)[0];
  const edits = changed(hunk.rows);
  assert.equal(edits.length, 1);
  matches(edits[0], { kind: "add", left: null, right: { n: 21, text: "inserted" } });
  // Three lines of context on each side, numbered on both sides.
  assert.equal(hunk.rows.length, 7);
  matches(hunk.rows[0], { kind: "ctx", left: { n: 18 }, right: { n: 18 } });
  matches(hunk.rows[6], { kind: "ctx", left: { n: 23, text: "line 23" }, right: { n: 24, text: "line 23" } });
  // The rest is collapsed behind two gaps.
  assert.deepEqual(
    model.parts.map((p) => p.type),
    ["gap", "hunk", "gap"],
  );
  assert.equal(model.parts[0].rows.length, 17);
  assert.equal(model.parts[2].rows.length, 27);
  assert.equal(model.rows.length, 51);
});

test("a frontmatter field added near the top does not turn the rest of the file into changes", () => {
  const body = numbered(40, "body");
  const before = `---\ndescription: Use rg\n---\n${body.join("\n")}\n`;
  const after = `---\ndescription: Use rg\nwhen_to_use: Searching\n---\n${body.join("\n")}\n`;
  const model = buildDiff(before, after);
  assert.equal(model.added, 1);
  assert.equal(model.removed, 0);
  assert.equal(changed(model.rows).length, 1);
  matches(changed(model.rows)[0].right, { n: 3, text: "when_to_use: Searching" });
});

test("a changed line pairs old with new and marks the words that differ", () => {
  const before = ["a", "b", "c", "The quick brown fox", "d", "e"].join("\n");
  const after = ["a", "b", "c", "The quick red fox", "d", "e"].join("\n");
  const pair = changed(buildDiff(before, after).rows);
  assert.equal(pair.length, 1);
  matches(pair[0], { kind: "mod", left: { n: 4 }, right: { n: 4 } });
  assert.deepEqual(pair[0].left.marks, [
    ["The quick ", false],
    ["brown", true],
    [" fox", false],
  ]);
  assert.deepEqual(pair[0].right.marks, [
    ["The quick ", false],
    ["red", true],
    [" fox", false],
  ]);
});

test("a replaced run pairs line by line, extra lines stand alone", () => {
  const model = buildDiff("keep\none\ntwo\nkeep2\n", "keep\nuno\ndos\ntres\nkeep2\n");
  assert.deepEqual(
    changed(model.rows).map((r) => r.kind),
    ["mod", "mod", "add"],
  );
  assert.equal(model.added, 3);
  assert.equal(model.removed, 2);
});

test("lines with nothing in common get no word highlights", () => {
  assert.equal(wordMarks("alpha beta", "0123 9876"), null);
  matches(changed(buildDiff("x\n", "completely different line\n").rows)[0], {
    kind: "mod",
    left: { marks: null },
    right: { marks: null },
  });
});

test("CRLF and LF versions of the same lines are the same lines", () => {
  assert.equal(buildDiff("a\r\nb\r\nc\r\n", "a\nb\nc\n").same, true);
  const edited = buildDiff("a\r\nb\r\nc\r\n", "a\r\nB\r\nc\r\n");
  assert.equal(changed(edited.rows).length, 1);
  assert.ok(edited.rows.every((r) => !r.left?.text.includes("\r") && !r.right?.text.includes("\r")));
});

test("a new asset is every line added, numbered from 1", () => {
  assert.deepEqual(
    newFileRows("one\ntwo\n").map((r) => [r.kind, r.right?.n, r.right?.text, r.left]),
    [
      ["add", 1, "one", null],
      ["add", 2, "two", null],
    ],
  );
  const model = buildDiff(null, "one\ntwo\n");
  assert.equal(model.added, 2);
  assert.equal(model.removed, 0);
});

test("an unchanged run too short to be worth a control stays visible; a longer one is collapsed", () => {
  const before = numbered(30);
  const after = [...before];
  after[5] = "changed A";
  after[16] = "changed B";
  const apart = buildDiff(before.join("\n"), after.join("\n"));
  // Two lines before the first change are shown, not collapsed; 4 hidden lines between the changes are.
  assert.deepEqual(
    apart.parts.map((p) => p.type),
    ["hunk", "gap", "hunk", "gap"],
  );
  assert.equal(apart.parts[1].rows.length, 4);
  after[10] = "changed C";
  after[12] = "changed D";
  assert.equal(hunks(buildDiff(before.join("\n"), after.join("\n"))).length, 1);
});

test("input past the size limits returns null so the caller shows the unified diff", () => {
  const big = numbered(MAX_LINES + 1).join("\n");
  assert.equal(buildDiff(big, "x"), null);
  assert.equal(buildDiff("x", big), null);
  // Entirely different content of allowed size exceeds the edit budget.
  const a = Array.from({ length: MAX_EDITS }, (_, i) => `a${i}`).join("\n");
  const b = Array.from({ length: MAX_EDITS }, (_, i) => `b${i}`).join("\n");
  assert.equal(buildDiff(a, b), null);
});

test("a few thousand lines with scattered edits align quickly", () => {
  const before = numbered(4000);
  const after = [...before];
  for (let i = 100; i < 4000; i += 400) after[i] = `${after[i]} edited`;
  after.splice(2000, 0, "added line");
  const started = performance.now();
  const model = buildDiff(before.join("\n"), after.join("\n"));
  assert.ok(performance.now() - started < 2000);
  assert.equal(model.added, 11);
  assert.equal(model.removed, 10);
});
