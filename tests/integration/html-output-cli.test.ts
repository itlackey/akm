// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * CLI-level coverage for `--format html` and the global `--output <path>`
 * flag (#582), driven through the in-process harness.
 *
 * `--format html` is health-only (chunk-9 WI-9.4c / Decision 4): the generic
 * JSON-in-<pre> fallback template was removed, so every non-health command
 * now rejects `--format html` with a `UsageError` (INVALID_FLAG_VALUE)
 * instead of rendering the default template.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createProposal, isProposalSkipped } from "../../src/commands/proposal/repository";
import { runCliCapture } from "../_helpers/cli";
import { type Cleanup, type IsolatedAkmStorage, withIsolatedAkmStorage } from "../_helpers/sandbox";

let storage: IsolatedAkmStorage;
let cleanup: Cleanup = () => {};

beforeEach(() => {
  storage = withIsolatedAkmStorage();
  cleanup = storage.cleanup;
});

afterEach(() => {
  cleanup();
  cleanup = () => {};
});

const VALID_LESSON =
  "---\ndescription: Use ripgrep before grep\nwhen_to_use: Searching large repos\n---\n\nPrefer rg.\n";

function seedProposal(ref = "lessons/rg-over-grep"): void {
  const result = createProposal(storage.stashDir, {
    ref,
    source: "reflect",
    force: true,
    payload: { content: VALID_LESSON },
  });
  if (isProposalSkipped(result)) throw new Error("unexpected skip in seedProposal");
}

describe("--format html (health-only)", () => {
  test("akm proposal list --format html rejects with a UsageError (html is health-only)", async () => {
    seedProposal();
    const { code, stderr } = await runCliCapture(["proposal", "list", "--format", "html"]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stderr);
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(parsed.error).toContain("html output is only available for `akm health`");
  });

  test("invalid --format still rejects unknown values and lists html", async () => {
    const { code, stderr } = await runCliCapture(["proposal", "list", "--format", "xml"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Invalid value for --format: xml");
    expect(stderr).toContain("html");
  });
});

describe("--output <path>", () => {
  test("--format html --output still rejects (html is health-only, before any file write)", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.html");
    const { code, stderr } = await runCliCapture(["proposal", "list", "--format", "html", "--output", out]);
    expect(code).toBe(2);
    const parsed = JSON.parse(stderr);
    expect(parsed.code).toBe("INVALID_FLAG_VALUE");
    expect(fs.existsSync(out)).toBe(false);
  });

  test("also redirects json output to the file", async () => {
    seedProposal();
    const out = path.join(storage.root, "proposals.json");
    const { code, stdout } = await runCliCapture(["proposal", "list", "--format", "json", `--output=${out}`]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("");
    const parsed = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(parsed.totalCount).toBe(1);
  });
});

describe("akm health --format html", () => {
  test("renders the full report from the bespoke template (echarts is CDN-only, chunk-9 WI-9.4d)", async () => {
    const { code, stdout } = await runCliCapture(["health", "--format", "html"]);
    // health maps warn→4; both pass and warn are valid for a fresh sandbox DB.
    expect([0, 4]).toContain(code);
    expect(stdout).toContain("<!DOCTYPE html>");
    expect(stdout).toContain("AKM Health Report");
    // All 7 chart panels are present.
    for (const id of [
      "chartWallTime",
      "chartPhases",
      "chartStash",
      "chartConsOutput",
      "chartSuccess",
      "chartLint",
      "chartDistill",
    ]) {
      expect(stdout).toContain(`id="${id}"`);
    }
    expect(stdout).toContain('<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>');
    expect(stdout).not.toMatch(/%%[A-Z_]+%%/);
    // Default compare window is 24h — surfaced in exec summary.
    expect(stdout).toContain("Trend vs prior 24h");
  });

  test("--compare overrides the trend window and --output writes the file", async () => {
    const out = path.join(storage.root, "health.html");
    const { code, stdout } = await runCliCapture(["health", "--format", "html", "--compare", "7d", "--output", out]);
    expect([0, 4]).toContain(code);
    expect(stdout.trim()).toBe("");
    const html = fs.readFileSync(out, "utf8");
    expect(html).toContain("Trend vs prior 7d");
    expect(html).toContain("AKM Health Report");
  });
});
