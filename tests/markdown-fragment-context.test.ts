import { describe, expect, test } from "bun:test";
import {
  buildMarkdownLeadContext,
  MARKDOWN_FRAGMENT_SELECTED_LABEL,
  splitMarkdownFragments,
} from "../src/core/asset/markdown-fragments";

function twoFragments() {
  return splitMarkdownFragments(
    ["# Lead", `lead-start ${"lead ".repeat(20)} lead-end`, "", "# Match", "selected evidence stays intact"].join("\n"),
  );
}

describe("bounded Markdown lead context", () => {
  test("puts the explicitly labelled selected match last", () => {
    const fragments = twoFragments();
    const result = buildMarkdownLeadContext(fragments, 1, 1000);

    expect(result.truncated).toBe(false);
    expect(result.content).toStartWith(fragments[0]!.text);
    expect(result.content).toEndWith(`${MARKDOWN_FRAGMENT_SELECTED_LABEL}\n${fragments[1]!.text}`);
  });

  test("clips lead bytes before touching a selected fragment that fits", () => {
    const fragments = twoFragments();
    const selectedBlock = `${MARKDOWN_FRAGMENT_SELECTED_LABEL}\n${fragments[1]!.text}`;
    const maxChars = selectedBlock.length + 20;
    const result = buildMarkdownLeadContext(fragments, 1, maxChars);

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(maxChars);
    expect(result.content).toEndWith(selectedBlock);
    expect(result.content).not.toContain("lead-end");
  });

  test("hard-clips the selected block only when the explicit budget is smaller", () => {
    const fragments = twoFragments();
    const result = buildMarkdownLeadContext(fragments, 1, 40);

    expect(result).toEqual({
      content: `${MARKDOWN_FRAGMENT_SELECTED_LABEL}\n${fragments[1]!.text}`.slice(0, 40),
      truncated: true,
    });
  });

  test("does not duplicate the first fragment when it is selected", () => {
    const fragments = twoFragments();
    const result = buildMarkdownLeadContext(fragments, 0, 1000);

    expect(result.truncated).toBe(false);
    expect(result.content).toBe(`${MARKDOWN_FRAGMENT_SELECTED_LABEL}\n${fragments[0]!.text}`);
  });
});
