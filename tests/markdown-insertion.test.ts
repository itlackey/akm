import { describe, expect, test } from "bun:test";
import {
  findEndOfTable,
  findFenceRegions,
  findSafeInsertionPoint,
  findSafeInsertionPointInText,
  isInsideCodeFence,
  isInsideHtmlTable,
  isInsideIndentedCode,
  isInsideTable,
} from "../src/commands/lint/markdown-insertion";

// ── Helpers ──────────────────────────────────────────────────────────────────

function lines(s: string): string[] {
  return s.split(/\r?\n/);
}

// ── findEndOfTable ───────────────────────────────────────────────────────────

describe("findEndOfTable", () => {
  test("returns exclusive end of a simple table", () => {
    const ls = lines(["| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", "", "After."].join("\n"));
    // Table starts at line 0, ends after the last data row (line 3).
    expect(findEndOfTable(ls, 0)).toBe(4);
  });

  test("handles alignment colons in the separator", () => {
    const ls = lines(["| A | B |", "| :--- | ---: |", "| 1 | 2 |"].join("\n"));
    expect(findEndOfTable(ls, 0)).toBe(3);
  });

  test("returns -1 when header line is not followed by a separator", () => {
    const ls = lines(["| A | B |", "Not a separator.", "More."].join("\n"));
    expect(findEndOfTable(ls, 0)).toBe(-1);
  });

  test("returns -1 when called on a non-table line", () => {
    const ls = lines(["# Heading", "Some prose."].join("\n"));
    expect(findEndOfTable(ls, 0)).toBe(-1);
  });

  test("handles table at end of file with no trailing blank line", () => {
    const ls = lines(["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n"));
    expect(findEndOfTable(ls, 0)).toBe(3);
  });
});

// ── isInsideTable ────────────────────────────────────────────────────────────

describe("isInsideTable", () => {
  const fixture = [
    "Prose before.",
    "",
    "| Col A | Col B |",
    "|---|---|",
    "| row 1 a | row 1 b |",
    "| row 2 a | row 2 b |",
    "",
    "Prose after.",
  ];

  test("detects header row", () => {
    expect(isInsideTable(fixture, 2)).toBe(6);
  });

  test("detects separator row", () => {
    expect(isInsideTable(fixture, 3)).toBe(6);
  });

  test("detects data row (the regression we are fixing)", () => {
    expect(isInsideTable(fixture, 4)).toBe(6);
    expect(isInsideTable(fixture, 5)).toBe(6);
  });

  test("returns -1 for plain prose", () => {
    expect(isInsideTable(fixture, 0)).toBe(-1);
    expect(isInsideTable(fixture, 7)).toBe(-1);
  });

  test("returns -1 for blank line just before the table", () => {
    expect(isInsideTable(fixture, 1)).toBe(-1);
  });

  test("returns -1 for blank line just after the table", () => {
    expect(isInsideTable(fixture, 6)).toBe(-1);
  });
});

// ── findFenceRegions / isInsideCodeFence ─────────────────────────────────────

describe("findFenceRegions", () => {
  test("detects a single backtick fence", () => {
    const ls = lines(["before", "```", "code", "```", "after"].join("\n"));
    expect(findFenceRegions(ls)).toEqual([{ start: 1, end: 3 }]);
  });

  test("detects tilde fences", () => {
    const ls = lines(["~~~", "code", "~~~"].join("\n"));
    expect(findFenceRegions(ls)).toEqual([{ start: 0, end: 2 }]);
  });

  test("ignores tilde closer for backtick opener", () => {
    const ls = lines(["```", "still code", "~~~", "```"].join("\n"));
    expect(findFenceRegions(ls)).toEqual([{ start: 0, end: 3 }]);
  });

  test("treats unterminated fence as extending to EOF", () => {
    const ls = lines(["```", "code", "more code"].join("\n"));
    expect(findFenceRegions(ls)).toEqual([{ start: 0, end: 2 }]);
  });

  test("handles multiple fences", () => {
    const ls = lines(["```", "a", "```", "prose", "```", "b", "```"].join("\n"));
    expect(findFenceRegions(ls)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
    ]);
  });
});

describe("isInsideCodeFence", () => {
  const fixture = lines(["Before.", "```javascript", "const x = 1;", "const y = 2;", "```", "After."].join("\n"));

  test("detects line inside fence", () => {
    expect(isInsideCodeFence(fixture, 2)).toBe(5);
    expect(isInsideCodeFence(fixture, 3)).toBe(5);
  });

  test("detects opening and closing fence lines themselves", () => {
    expect(isInsideCodeFence(fixture, 1)).toBe(5);
    expect(isInsideCodeFence(fixture, 4)).toBe(5);
  });

  test("returns -1 for lines outside fence", () => {
    expect(isInsideCodeFence(fixture, 0)).toBe(-1);
    expect(isInsideCodeFence(fixture, 5)).toBe(-1);
  });
});

// ── isInsideHtmlTable ────────────────────────────────────────────────────────

describe("isInsideHtmlTable", () => {
  const fixture = lines(["Prose.", "<table>", "  <tr><td>cell</td></tr>", "</table>", "After."].join("\n"));

  test("detects line between open and close", () => {
    expect(isInsideHtmlTable(fixture, 2)).toBe(4);
  });

  test("detects opening tag line", () => {
    expect(isInsideHtmlTable(fixture, 1)).toBe(4);
  });

  test("returns -1 outside the table", () => {
    expect(isInsideHtmlTable(fixture, 0)).toBe(-1);
    expect(isInsideHtmlTable(fixture, 4)).toBe(-1);
  });

  test("handles attributes on opening tag", () => {
    const ls = lines(['<table class="foo">', "x", "</table>"].join("\n"));
    expect(isInsideHtmlTable(ls, 1)).toBe(3);
  });

  test("treats unterminated html table as extending to EOF", () => {
    const ls = lines(["<table>", "x", "y"].join("\n"));
    expect(isInsideHtmlTable(ls, 1)).toBe(3);
  });
});

// ── isInsideIndentedCode ─────────────────────────────────────────────────────

describe("isInsideIndentedCode", () => {
  test("detects 4-space indented block after blank line", () => {
    const ls = lines(["Prose.", "", "    const x = 1;", "    const y = 2;", "", "After."].join("\n"));
    expect(isInsideIndentedCode(ls, 2)).toBe(4);
    expect(isInsideIndentedCode(ls, 3)).toBe(4);
  });

  test("detects tab-indented block", () => {
    const ls = lines(["Prose.", "", "\tcode", "\tmore code", "", "After."].join("\n"));
    expect(isInsideIndentedCode(ls, 2)).toBe(4);
  });

  test("does not detect list continuation as code", () => {
    const ls = lines(["- list item", "    continuation", "next paragraph"].join("\n"));
    expect(isInsideIndentedCode(ls, 1)).toBe(-1);
  });

  test("returns -1 for non-indented line", () => {
    const ls = lines(["Prose.", "More prose."].join("\n"));
    expect(isInsideIndentedCode(ls, 0)).toBe(-1);
  });
});

// ── findSafeInsertionPoint ───────────────────────────────────────────────────

describe("findSafeInsertionPoint", () => {
  test("insertion point inside table moves to after the table", () => {
    const ls = ["# Foo", "", "| A | B |", "|---|---|", "| 1 | 2 |", "| 3 | 4 |", "", "After."];
    // Proposed inside the table (between separator and first data row)
    expect(findSafeInsertionPoint(ls, 4)).toBe(6);
    // Proposed inside the table (at a data row)
    expect(findSafeInsertionPoint(ls, 5)).toBe(6);
    // Proposed at the separator
    expect(findSafeInsertionPoint(ls, 3)).toBe(6);
    // Proposed at the header
    expect(findSafeInsertionPoint(ls, 2)).toBe(6);
  });

  test("insertion point inside fenced code block moves to after the fence", () => {
    const ls = ["Prose.", "```", "x = 1", "```", "After."];
    expect(findSafeInsertionPoint(ls, 2)).toBe(4);
    expect(findSafeInsertionPoint(ls, 1)).toBe(4);
    expect(findSafeInsertionPoint(ls, 3)).toBe(4);
  });

  test("insertion point in plain prose is unchanged", () => {
    const ls = ["# Heading", "", "Paragraph one.", "", "Paragraph two."];
    expect(findSafeInsertionPoint(ls, 2)).toBe(2);
    expect(findSafeInsertionPoint(ls, 4)).toBe(4);
  });

  test("insertion point before the table is unchanged", () => {
    const ls = ["Before.", "", "| A | B |", "|---|---|", "| 1 | 2 |", ""];
    expect(findSafeInsertionPoint(ls, 0)).toBe(0);
    expect(findSafeInsertionPoint(ls, 1)).toBe(1);
  });

  test("insertion point after the table is unchanged", () => {
    const ls = ["| A | B |", "|---|---|", "| 1 | 2 |", "", "After."];
    expect(findSafeInsertionPoint(ls, 3)).toBe(3);
    expect(findSafeInsertionPoint(ls, 4)).toBe(4);
  });

  test("insertion point at end of file with no trailing blank line is handled", () => {
    const ls = ["| A | B |", "|---|---|", "| 1 | 2 |"];
    // Table runs through index 2; proposed inside should land at length (3).
    expect(findSafeInsertionPoint(ls, 2)).toBe(3);
    expect(findSafeInsertionPoint(ls, 1)).toBe(3);
  });

  test("clamps proposed line above lines.length to lines.length", () => {
    const ls = ["A", "B", "C"];
    expect(findSafeInsertionPoint(ls, 100)).toBe(3);
  });

  test("clamps negative proposed line to 0", () => {
    const ls = ["A", "B", "C"];
    expect(findSafeInsertionPoint(ls, -5)).toBe(0);
  });

  test("empty file returns 0", () => {
    expect(findSafeInsertionPoint([], 0)).toBe(0);
    expect(findSafeInsertionPoint([], 5)).toBe(0);
  });

  test("mixed scenario: table followed by code block, insertion inside the second resolves correctly", () => {
    const ls = [
      "# Doc",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "Prose between.",
      "",
      "```",
      "code line",
      "more code",
      "```",
      "",
      "Tail.",
    ];
    // Inside the code block — should land at line 12 (after the fence).
    expect(findSafeInsertionPoint(ls, 9)).toBe(12);
    expect(findSafeInsertionPoint(ls, 10)).toBe(12);
    // Inside the table — should land at line 5 (the blank line after the table).
    expect(findSafeInsertionPoint(ls, 4)).toBe(5);
  });

  test("mixed scenario: insertion lands between table and immediately adjacent code fence", () => {
    // Table on lines 0-2, code fence on lines 3-5 (no blank line between).
    const ls = ["| A | B |", "|---|---|", "| 1 | 2 |", "```", "code", "```", "After."];
    // Inside the table — pushed past, lands at line 3 which is the fence opener.
    // The helper should then push past the fence too.
    expect(findSafeInsertionPoint(ls, 2)).toBe(6);
    // Inside the fence — pushed past to line 6.
    expect(findSafeInsertionPoint(ls, 4)).toBe(6);
  });

  test("html table: insertion inside lands after </table>", () => {
    const ls = ["Prose.", "<table>", "  <tr><td>x</td></tr>", "</table>", "After."];
    expect(findSafeInsertionPoint(ls, 2)).toBe(4);
  });

  test("indented code block: insertion inside lands after the block", () => {
    const ls = ["Prose.", "", "    code line 1", "    code line 2", "", "After."];
    expect(findSafeInsertionPoint(ls, 2)).toBe(4);
  });
});

// ── findSafeInsertionPointInText ─────────────────────────────────────────────

describe("findSafeInsertionPointInText", () => {
  test("treats raw text input correctly", () => {
    const text = ["# Foo", "", "| A | B |", "|---|---|", "| 1 | 2 |", "", "After."].join("\n");
    // Line 4 (0-based) is the data row, should be pushed past the table.
    expect(findSafeInsertionPointInText(text, 4)).toBe(5);
  });

  test("handles CRLF line endings", () => {
    const text = ["A", "B", "C"].join("\r\n");
    expect(findSafeInsertionPointInText(text, 1)).toBe(1);
  });
});

// ── Integration: safe line insertion ─────────────────────────────────────────
//
// akm 0.9.0 chunk-3 (plan §12): the `BaseLinter.insertLinesSafely` protected
// helper died with the linter class hierarchy (it was unused by any linter).
// Its two lines of logic — `findSafeInsertionPoint` + `splice` — are exercised
// directly here, which is what the helper wrapped.

/** The former `BaseLinter.insertLinesSafely` body: pick a safe index, splice. */
function insertLinesSafely(raw: string, newLines: string[], proposedLineNumber: number): string {
  const ls = raw.split(/\r?\n/);
  const safeIdx = findSafeInsertionPoint(ls, proposedLineNumber);
  ls.splice(safeIdx, 0, ...newLines);
  return ls.join("\n");
}

describe("safe line insertion (findSafeInsertionPoint + splice)", () => {
  test("a fixer-style call routed through the helper preserves the table", () => {
    const raw = [
      "---",
      "description: example",
      "updated: 2026-05-23",
      "---",
      "",
      "# Foo",
      "",
      "## Execution",
      "",
      "| Command | Description |",
      "|---|---|",
      "| `akm tasks list` | List configured tasks |",
      "| `akm tasks add` | Register a new task |",
      "| `akm tasks run <id>` | Manually invoke a task |",
      "",
      "More text after the table.",
    ].join("\n");

    // Proposed line 12 = inside the table body (between data rows). This is
    // exactly the regression case from the akm-stash alignment sweep.
    const callout = ["", "> NOTE: Task files must be `.yml`.", ""];
    const fixed = insertLinesSafely(raw, callout, 12);
    const fixedLines = fixed.split("\n");

    // The table header + separator + 3 data rows must remain contiguous.
    const headerIdx = fixedLines.indexOf("| Command | Description |");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(fixedLines[headerIdx + 1]).toBe("|---|---|");
    expect(fixedLines[headerIdx + 2]).toBe("| `akm tasks list` | List configured tasks |");
    expect(fixedLines[headerIdx + 3]).toBe("| `akm tasks add` | Register a new task |");
    expect(fixedLines[headerIdx + 4]).toBe("| `akm tasks run <id>` | Manually invoke a task |");

    // The callout must appear AFTER the last data row (somewhere past index headerIdx+4).
    const calloutIdx = fixedLines.indexOf("> NOTE: Task files must be `.yml`.");
    expect(calloutIdx).toBeGreaterThan(headerIdx + 4);

    // And the post-table prose must still be present.
    expect(fixedLines).toContain("More text after the table.");
  });

  test("the helper is a no-op for prose-line insertion", () => {
    const raw = ["# Heading", "", "Paragraph one.", "", "Paragraph two."].join("\n");
    const result = insertLinesSafely(raw, ["INSERTED"], 2);
    const out = result.split("\n");
    expect(out[2]).toBe("INSERTED");
    expect(out[3]).toBe("Paragraph one.");
  });
});

// ── Regression: the original bug fixture ─────────────────────────────────────

describe("regression: akm-cli-reference table corruption", () => {
  test("callout proposed at line 5 of an Execution-section table lands after the table", () => {
    // Mirrors the structure of knowledge/akm-cli-reference.md lines 64-72
    // where the auto-fix originally split the table.
    const body = [
      "## Execution and authoring", // 0
      "", // 1
      "| Command | Purpose |", // 2
      "|---|---|", // 3
      "| `akm run <ref>` | Execute a runnable asset. |", // 4
      "| `akm workflow start <ref>` | Run stateful workflows. |", // 5
      "| `akm tasks add <id>` | Register a scheduled task. |", // 6
      "", // 7
      "## Next section", // 8
    ];
    // Without the helper a naive fixer might insert at line 5 (a data row),
    // producing the broken-table bug. The helper must push past the table.
    const safe = findSafeInsertionPoint(body, 5);
    expect(safe).toBe(7); // the blank line immediately after the table
    // Inserting a callout at the safe point preserves the table structure.
    const callout = ["> NOTE: Task files must be `.yml`."];
    const result = [...body.slice(0, safe), ...callout, ...body.slice(safe)];
    // The table header + separator + 3 data rows remain contiguous (indices 2..6).
    expect(result[2]).toBe("| Command | Purpose |");
    expect(result[3]).toBe("|---|---|");
    expect(result[4].startsWith("| `akm run")).toBe(true);
    expect(result[5].startsWith("| `akm workflow")).toBe(true);
    expect(result[6].startsWith("| `akm tasks")).toBe(true);
    // The callout lands at index 7 (immediately after the last data row), which
    // is fine because the original blank line then follows.
    expect(result[7]).toBe("> NOTE: Task files must be `.yml`.");
  });
});
