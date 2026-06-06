import { describe, expect, test } from "bun:test";
import { normalizeShowArgv } from "../../src/commands/show";

// Regression: normalizeShowArgv splits global flags from positional view-mode
// args and rebuilds argv. The global-flag allowlist must preserve the 0.8
// output flags (--shape, --verbose) — otherwise `akm show <ref> <view> --shape
// agent` silently drops the projection because process.argv is replaced before
// initOutputMode reads it.
describe("normalizeShowArgv preserves global output flags on the view-mode path", () => {
  const base = ["bun", "akm", "show", "knowledge:guide"];

  test("--shape <value> (space form) survives the rewrite", () => {
    const out = normalizeShowArgv([...base, "toc", "--shape", "agent"]);
    expect(out).toEqual(["bun", "akm", "show", "knowledge:guide", "--akmView", "toc", "--shape", "agent"]);
  });

  test("--shape=<value> (equals form) survives the rewrite", () => {
    const out = normalizeShowArgv([...base, "toc", "--shape=summary"]);
    expect(out).toContain("--shape=summary");
    expect(out).toContain("--akmView");
  });

  test("--verbose survives the rewrite on the section view path", () => {
    const out = normalizeShowArgv([...base, "section", "Auth", "--verbose"]);
    expect(out).toEqual([
      "bun",
      "akm",
      "show",
      "knowledge:guide",
      "--akmView",
      "section",
      "--akmHeading",
      "Auth",
      "--verbose",
    ]);
  });
});
